const express = require("express");
const http = require("http");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
const { Server } = require("socket.io");

const app = express();

app.use(express.json());

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.sendStatus(200);

  next();
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function getEarnedStatus(count) {
  if (count >= 10000) return "Rockstar 🦊";
  if (count >= 1000) return "Star ⭐";
  if (count >= 500) return "Moon 🌕";
  if (count >= 200) return "Whisper 🌓";
  if (count > 10) return "Silent 🌒";
  return "No body 🌑";
}

function getActiveStatus(user) {
  return user.manual_status || user.paid_status || getEarnedStatus(user.messages_count || 0);
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      nick TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      messages_count INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      room TEXT NOT NULL,
      user_nick TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'user';`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS paid_status TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS manual_status TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_until TIMESTAMP;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_forever BOOLEAN DEFAULT false;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS muted_until TIMESTAMP;`);

  console.log("Database ready");
}

async function getUserByNick(nick) {
  const result = await pool.query(
    "SELECT * FROM users WHERE lower(nick) = lower($1)",
    [nick]
  );

  return result.rows[0];
}

async function ensureAdmin(user) {
  if (!user) return user;

  if (String(user.nick).toLowerCase() === "admin" && user.role !== "admin") {
    await pool.query(
      "UPDATE users SET role = 'admin' WHERE id = $1",
      [user.id]
    );

    user.role = "admin";
  }

  return user;
}

app.get("/", (req, res) => {
  res.send("NeoWAP server online");
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/auth", async (req, res) => {
  try {
    const { nick, password } = req.body;

    if (!nick || !password) {
      return res.status(400).json({
        ok: false,
        error: "Нужен ник и пароль"
      });
    }

    const cleanNick = String(nick).trim();
    const cleanPassword = String(password).trim();

    const existing = await pool.query(
      "SELECT * FROM users WHERE lower(nick) = lower($1)",
      [cleanNick]
    );

    if (existing.rows.length === 0) {
      const hash = await bcrypt.hash(cleanPassword, 10);

      const created = await pool.query(
        `INSERT INTO users (nick, password_hash)
         VALUES ($1, $2)
         RETURNING *`,
        [cleanNick, hash]
      );

      let user = created.rows[0];
      user = await ensureAdmin(user);

      return res.json({
        ok: true,
        mode: "registered",
        user: {
          ...user,
          active_status: getActiveStatus(user)
        }
      });
    }

    let user = existing.rows[0];
    user = await ensureAdmin(user);

    const valid = await bcrypt.compare(cleanPassword, user.password_hash);

    if (!valid) {
      return res.status(401).json({
        ok: false,
        error: "Неверный пароль"
      });
    }

    return res.json({
      ok: true,
      mode: "login",
      user: {
        ...user,
        active_status: getActiveStatus(user)
      }
    });

  } catch (e) {
    console.error(e);

    res.status(500).json({
      ok: false,
      error: "Ошибка сервера"
    });
  }
});

app.get("/messages/:room", async (req, res) => {
  try {
    const room = req.params.room;

    const result = await pool.query(
      `SELECT m.*, u.messages_count, u.manual_status, u.paid_status
       FROM messages m
       LEFT JOIN users u
       ON lower(u.nick) = lower(m.user_nick)
       WHERE room = $1
       ORDER BY id DESC
       LIMIT 50`,
      [room]
    );

    const messages = result.rows.reverse().map((m) => ({
      ...m,
      active_status:
        m.manual_status ||
        m.paid_status ||
        getEarnedStatus(m.messages_count || 0)
    }));

    res.json({
      ok: true,
      messages
    });

  } catch (e) {
    console.error(e);

    res.status(500).json({
      ok: false
    });
  }
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const roomsOnline = {};
const roomUsers = {};

function emitRoomsOnline() {
  io.emit("roomsOnline", roomsOnline);
}

io.on("connection", (socket) => {
  console.log("connected", socket.id);

  socket.on("joinRoom", (data) => {
    const room = data.room;
    const nick = data.user;

    if (socket.currentRoom) {
      socket.leave(socket.currentRoom);

      if (roomsOnline[socket.currentRoom]) {
        roomsOnline[socket.currentRoom]--;
      }

      if (roomUsers[socket.currentRoom]) {
        roomUsers[socket.currentRoom].delete(socket.id);
      }
    }

    socket.join(room);

    socket.currentRoom = room;
    socket.nick = nick;

    roomsOnline[room] = (roomsOnline[room] || 0) + 1;

    if (!roomUsers[room]) {
      roomUsers[room] = new Map();
    }

    roomUsers[room].set(socket.id, nick);

    io.to(room).emit(
      "roomUsers",
      Array.from(roomUsers[room].values())
    );

    io.to(room).emit(
      "system",
      `👤 ${nick} вошёл в комнату`
    );

    emitRoomsOnline();
  });

  socket.on("typing", (data) => {
    socket.to(data.room).emit("typing", {
      user: data.user,
      active_status: data.active_status
    });
  });

  socket.on("message", async (data) => {
    try {
      const room = String(data.room).trim();
      const userNick = String(data.user).trim();
      const text = String(data.text).trim();

      const user = await getUserByNick(userNick);

      if (!user) return;

      await pool.query(
        `INSERT INTO messages (room, user_nick, text)
         VALUES ($1, $2, $3)`,
        [room, userNick, text]
      );

      const updated = await pool.query(
        `UPDATE users
         SET messages_count = messages_count + 1
         WHERE lower(nick) = lower($1)
         RETURNING messages_count, paid_status, manual_status`,
        [userNick]
      );

      const updatedUser = updated.rows[0];

      const activeStatus =
        updatedUser.manual_status ||
        updatedUser.paid_status ||
        getEarnedStatus(updatedUser.messages_count);

      io.to(room).emit("message", {
        user: userNick,
        text,
        room,
        active_status: activeStatus,
        messages_count: updatedUser.messages_count
      });

    } catch (e) {
      console.error(e);
    }
  });

  socket.on("disconnect", () => {
    const room = socket.currentRoom;

    if (room && roomsOnline[room]) {
      roomsOnline[room]--;

      if (roomUsers[room]) {
        roomUsers[room].delete(socket.id);
      }

      io.to(room).emit(
        "roomUsers",
        roomUsers[room]
          ? Array.from(roomUsers[room].values())
          : []
      );

      emitRoomsOnline();
    }

    console.log("disconnect", socket.id);
  });
});

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`NeoWAP server running on port ${PORT}`);
    });
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
