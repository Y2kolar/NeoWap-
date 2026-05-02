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
      return res.status(400).json({ ok: false, error: "Нужен ник и пароль" });
    }

    const cleanNick = String(nick).trim();
    const cleanPassword = String(password).trim();

    if (cleanNick.length < 3 || cleanNick.length > 20) {
      return res.status(400).json({ ok: false, error: "Ник должен быть 3–20 символов" });
    }

    if (cleanPassword.length < 4 || cleanPassword.length > 60) {
      return res.status(400).json({ ok: false, error: "Пароль должен быть 4–60 символов" });
    }

    const existing = await pool.query(
      "SELECT * FROM users WHERE lower(nick) = lower($1)",
      [cleanNick]
    );

    if (existing.rows.length === 0) {
      const hash = await bcrypt.hash(cleanPassword, 10);

      const created = await pool.query(
        `INSERT INTO users (nick, password_hash)
         VALUES ($1, $2)
         RETURNING id, nick, messages_count, role, paid_status, manual_status, banned_forever, ban_until, muted_until`,
        [cleanNick, hash]
      );

      const user = created.rows[0];

      return res.json({
        ok: true,
        mode: "registered",
        user: {
          ...user,
          active_status: getActiveStatus(user),
          earned_status: getEarnedStatus(user.messages_count)
        }
      });
    }

    const user = existing.rows[0];

    const now = new Date();

    if (user.banned_forever) {
      return res.status(403).json({ ok: false, error: "Этот ник забанен навсегда" });
    }

    if (user.ban_until && new Date(user.ban_until) > now) {
      return res.status(403).json({ ok: false, error: "Этот ник временно забанен" });
    }

    const valid = await bcrypt.compare(cleanPassword, user.password_hash);

    if (!valid) {
      return res.status(401).json({ ok: false, error: "Неверный пароль для этого ника" });
    }

    return res.json({
      ok: true,
      mode: "login",
      user: {
        id: user.id,
        nick: user.nick,
        messages_count: user.messages_count,
        role: user.role,
        paid_status: user.paid_status,
        manual_status: user.manual_status,
        active_status: getActiveStatus(user),
        earned_status: getEarnedStatus(user.messages_count),
        banned_forever: user.banned_forever,
        ban_until: user.ban_until,
        muted_until: user.muted_until
      }
    });

  } catch (e) {
    console.error("AUTH ERROR:", e);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
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

    res.json({ ok: true, messages: result.rows.reverse() });

  } catch (e) {
    console.error("MESSAGES ERROR:", e);
    res.status(500).json({ ok: false, error: "Ошибка загрузки сообщений" });
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

async function getUserByNick(nick) {
  const result = await pool.query(
    "SELECT * FROM users WHERE lower(nick) = lower($1)",
    [nick]
  );
  return result.rows[0];
}

function parseDuration(text) {
  const value = parseInt(text);
  if (!value) return null;

  if (text.endsWith("m")) return value * 60 * 1000;
  if (text.endsWith("h")) return value * 60 * 60 * 1000;
  if (text.endsWith("d")) return value * 24 * 60 * 60 * 1000;

  return value * 60 * 1000;
}

async function handleAdminCommand(socket, data) {
  const text = String(data.text || "").trim();
  const adminNick = String(data.user || "").trim();

  const admin = await getUserByNick(adminNick);

  if (!admin || admin.role !== "admin") {
    socket.emit("system", "Нет прав администратора.");
    return true;
  }

  const parts = text.split(" ");
  const command = parts[0];
  const targetNick = parts[1];

  if (!targetNick) {
    socket.emit("system", "Нужно указать ник.");
    return true;
  }

  if (command === "/admin") {
    socket.emit("system", "Команды: /status Nick Star | /ban Nick 1d | /permban Nick | /mute Nick 10m | /unban Nick");
    return true;
  }

  const target = await getUserByNick(targetNick);

  if (!target) {
    socket.emit("system", "Пользователь не найден.");
    return true;
  }

  if (command === "/status") {
    const status = parts.slice(2).join(" ");

    if (!status) {
      socket.emit("system", "Укажи статус.");
      return true;
    }

    await pool.query(
      "UPDATE users SET manual_status = $1 WHERE lower(nick) = lower($2)",
      [status, targetNick]
    );

    io.emit("system", `Админ изменил статус пользователя ${target.nick} на ${status}`);
    return true;
  }

  if (command === "/ban") {
    const duration = parts[2] || "1d";
    const ms = parseDuration(duration);

    if (!ms) {
      socket.emit("system", "Формат: /ban Nick 1d или 10m или 2h");
      return true;
    }

    const until = new Date(Date.now() + ms);

    await pool.query(
      "UPDATE users SET ban_until = $1 WHERE lower(nick) = lower($2)",
      [until, targetNick]
    );

    io.emit("system", `${target.nick} временно забанен.`);
    return true;
  }

  if (command === "/permban") {
    await pool.query(
      "UPDATE users SET banned_forever = true WHERE lower(nick) = lower($1)",
      [targetNick]
    );

    io.emit("system", `${target.nick} забанен навсегда.`);
    return true;
  }

  if (command === "/mute") {
    const duration = parts[2] || "10m";
    const ms = parseDuration(duration);

    if (!ms) {
      socket.emit("system", "Формат: /mute Nick 10m или 1h");
      return true;
    }

    const until = new Date(Date.now() + ms);

    await pool.query(
      "UPDATE users SET muted_until = $1 WHERE lower(nick) = lower($2)",
      [until, targetNick]
    );

    io.emit("system", `${target.nick} получил мут.`);
    return true;
  }

  if (command === "/unban") {
    await pool.query(
      "UPDATE users SET banned_forever = false, ban_until = NULL, muted_until = NULL WHERE lower(nick) = lower($1)",
      [targetNick]
    );

    io.emit("system", `${target.nick} разбанен.`);
    return true;
  }

  return false;
}

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

      const room = String(data.room).trim();
      const userNick = String(data.user).trim();
      const text = String(data.text).trim();

      if (!room || !userNick || !text) return;
      if (text.length > 1000) return;

      if (text.startsWith("/")) {
        const handled = await handleAdminCommand(socket, data);
        if (handled) return;
      }

      const user = await getUserByNick(userNick);

      if (!user) return;

      const now = new Date();

      if (user.banned_forever) {
        socket.emit("system", "Ты забанен навсегда.");
        return;
      }

      if (user.ban_until && new Date(user.ban_until) > now) {
        socket.emit("system", "Ты временно забанен.");
        return;
      }

      if (user.muted_until && new Date(user.muted_until) > now) {
        socket.emit("system", "У тебя временный мут. Читать можно, писать пока нельзя.");
        return;
      }

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
        messages_count: updatedUser.messages_count,
        active_status: activeStatus,
        earned_status: getEarnedStatus(updatedUser.messages_count),
        time: Date.now()
      });

    } catch (e) {
      console.error("SOCKET MESSAGE ERROR:", e);
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

initDb()
  .then(() => {
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`NeoWAP server running on port ${PORT}`);
    });
  })
  .catch((e) => {
    console.error("Database init failed:", e);
    process.exit(1);
  });
