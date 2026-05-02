const express = require("express");
const http = require("http");
const bcrypt = require("bcryptjs");
const { Server } = require("socket.io");

const { pool, initDb } = require("./src/db");
const statusTools = require("./src/statuses");
const trustTools = require("./src/trust");
const userTools = require("./src/users");
const sockets = require("./src/sockets");

const app = express();

app.use(express.json());

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.sendStatus(200);

  next();
});

function getEarnedStatus(count) {
  return statusTools.getEarnedStatus(count);
}

function getActiveStatus(user) {
  return statusTools.getActiveStatus(user);
}

function getTrustLevel(score) {
  return trustTools.getTrustLevel(score);
}

async function ensureAdmin(user) {
  return userTools.ensureAdmin(user);
}

async function touchUser(nick) {
  return userTools.touchUser(nick);
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

    if (cleanNick.length < 3 || cleanNick.length > 20) {
      return res.status(400).json({
        ok: false,
        error: "Ник должен быть 3–20 символов"
      });
    }

    if (cleanPassword.length < 4 || cleanPassword.length > 60) {
      return res.status(400).json({
        ok: false,
        error: "Пароль должен быть 4–60 символов"
      });
    }

    const existing = await pool.query(
      "SELECT * FROM users WHERE lower(nick) = lower($1)",
      [cleanNick]
    );

    if (existing.rows.length === 0) {
      const hash = await bcrypt.hash(cleanPassword, 10);

      const created = await pool.query(
        `INSERT INTO users (nick, password_hash, trust_score, last_seen)
         VALUES ($1, $2, 35, NOW())
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
          active_status: getActiveStatus(user),
          earned_status: getEarnedStatus(user.messages_count),
          trust_level: getTrustLevel(user.trust_score)
        }
      });
    }

    let user = existing.rows[0];
    user = await ensureAdmin(user);

    const now = new Date();

    if (user.banned_forever) {
      return res.status(403).json({
        ok: false,
        error: "Этот ник забанен навсегда"
      });
    }

    if (user.ban_until && new Date(user.ban_until) > now) {
      return res.status(403).json({
        ok: false,
        error: "Этот ник временно забанен"
      });
    }

    const valid = await bcrypt.compare(cleanPassword, user.password_hash);

    if (!valid) {
      return res.status(401).json({
        ok: false,
        error: "Неверный пароль"
      });
    }

    await touchUser(user.nick);

    return res.json({
      ok: true,
      mode: "login",
      user: {
        ...user,
        active_status: getActiveStatus(user),
        earned_status: getEarnedStatus(user.messages_count),
        trust_level: getTrustLevel(user.trust_score)
      }
    });

  } catch (e) {
    console.error("AUTH ERROR:", e);

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
      `SELECT m.*, u.messages_count, u.manual_status, u.paid_status, u.trust_score
       FROM messages m
       LEFT JOIN users u
       ON lower(u.nick) = lower(m.user_nick)
       WHERE m.room = $1
       ORDER BY m.id DESC
       LIMIT 50`,
      [room]
    );

    const messages = result.rows.reverse().map((m) => ({
      ...m,
      active_status:
        m.manual_status ||
        m.paid_status ||
        getEarnedStatus(m.messages_count || 0),
      trust_level: getTrustLevel(m.trust_score || 35)
    }));

    res.json({
      ok: true,
      messages
    });

  } catch (e) {
    console.error("MESSAGES ERROR:", e);

    res.status(500).json({
      ok: false
    });
  }
});

app.get("/rooms-online", (req, res) => {
  res.json({
    ok: true,
    rooms: sockets.getRoomsOnline()
  });
});

app.get("/private-invites/:nick", async (req, res) => {
  try {
    const nick = String(req.params.nick || "").trim();

    const result = await pool.query(
      `SELECT *
       FROM private_invites
       WHERE lower(to_nick) = lower($1)
       AND status = 'pending'
       ORDER BY id DESC
       LIMIT 20`,
      [nick]
    );

    res.json({
      ok: true,
      invites: result.rows
    });

  } catch (e) {
    console.error("PRIVATE INVITES ERROR:", e);

    res.status(500).json({
      ok: false,
      error: "Ошибка загрузки приглашений"
    });
  }
});

app.get("/private-rooms/:nick", async (req, res) => {
  try {
    const nick = String(req.params.nick || "").trim();

    const result = await pool.query(
      `SELECT prm.code, prm.role, prm.joined_at, pr.created_by, pr.is_active
       FROM private_room_members prm
       LEFT JOIN private_rooms pr ON pr.code = prm.code
       WHERE lower(prm.nick) = lower($1)
       AND pr.is_active = true
       ORDER BY prm.joined_at DESC
       LIMIT 20`,
      [nick]
    );

    res.json({
      ok: true,
      rooms: result.rows
    });

  } catch (e) {
    console.error("PRIVATE ROOMS ERROR:", e);

    res.status(500).json({
      ok: false,
      error: "Ошибка загрузки приватных комнат"
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

sockets.setupSockets(io);

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
