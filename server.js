const express = require("express");
const http = require("http");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
const { Server } = require("socket.io");

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

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

  console.log("Database ready");
}

app.get("/", (req, res) => {
  res.send("NeoWAP server online");
});

app.post("/auth", async (req, res) => {
  try {
    const { nick, password } = req.body;

    if (!nick || !password) {
      return res.status(400).json({ error: "Нужен ник и пароль" });
    }

    if (nick.length < 3 || nick.length > 20) {
      return res.status(400).json({ error: "Ник должен быть 3–20 символов" });
    }

    if (password.length < 4 || password.length > 60) {
      return res.status(400).json({ error: "Пароль должен быть 4–60 символов" });
    }

    const cleanNick = nick.trim();

    const existing = await pool.query(
      "SELECT * FROM users WHERE lower(nick) = lower($1)",
      [cleanNick]
    );

    if (existing.rows.length === 0) {
      const hash = await bcrypt.hash(password, 10);

      const created = await pool.query(
        "INSERT INTO users (nick, password_hash) VALUES ($1, $2) RETURNING id, nick, messages_count",
        [cleanNick, hash]
      );

      return res.json({
        ok: true,
        mode: "registered",
        user: created.rows[0]
      });
    }

    const user = existing.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return res.status(401).json({ error: "Неверный пароль для этого ника" });
    }

    return res.json({
      ok: true,
      mode: "login",
      user: {
        id: user.id,
        nick: user.nick,
        messages_count: user.messages_count
      }
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.get("/messages/:room", async (req, res) => {
  try {
    const room = req.params.room;

    const result = await pool.query(
      `SELECT room, user_nick, text, created_at
       FROM messages
       WHERE room = $1
       ORDER BY id DESC
       LIMIT 50`,
      [room]
    );

    res.json({
      ok: true,
      messages: result.rows.reverse()
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Ошибка загрузки сообщений" });
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

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("joinRoom", (room) => {
    if (!room) return;

    if (socket.currentRoom) {
      socket.leave(socket.currentRoom);

      if (roomsOnline[socket.currentRoom]) {
        roomsOnline[socket.currentRoom] = Math.max(0, roomsOnline[socket.currentRoom] - 1);
      }
    }

    socket.join(room);
    socket.currentRoom = room;

    roomsOnline[room] = (roomsOnline[room] || 0) + 1;

    io.to(room).emit("system", `👤 Кто-то вошёл. Сейчас в комнате: ${roomsOnline[room]}`);
  });

  socket.on("message", async (data) => {
    try {
      if (!data || !data.room || !data.text || !data.user) return;

      const text = String(data.text).trim();
      const user = String(data.user).trim();
      const room = String(data.room).trim();

      if (!text || text.length > 1000) return;

      await pool.query(
        "INSERT INTO messages (room, user_nick, text) VALUES ($1, $2, $3)",
        [room, user, text]
      );

      const updated = await pool.query(
        "UPDATE users SET messages_count = messages_count + 1 WHERE lower(nick) = lower($1) RETURNING messages_count",
        [user]
      );

      io.to(room).emit("message", {
        user,
        text,
        room,
        messages_count: updated.rows[0]?.messages_count || 0,
        time: Date.now()
      });

    } catch (e) {
      console.error(e);
    }
  });

  socket.on("disconnect", () => {
    const room = socket.currentRoom;

    if (room && roomsOnline[room]) {
      roomsOnline[room] = Math.max(0, roomsOnline[room] - 1);
      io.to(room).emit("system", `👤 Кто-то вышел. Сейчас в комнате: ${roomsOnline[room]}`);
    }

    console.log("User disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 3000;

initDb().then(() => {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`NeoWAP server running on port ${PORT}`);
  });
}).catch((e) => {
  console.error("Database init failed:", e);
  process.exit(1);
});
