const express = require("express");
const http = require("http");
const bcrypt = require("bcryptjs");
const { Server } = require("socket.io");

const { pool, initDb } = require("./src/db");
const statusTools = require("./src/statuses");
const trustTools = require("./src/trust");

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

function getPrivateWarningLevel(score) {
  return trustTools.getPrivateWarningLevel(score);
}

function clampTrust(score) {
  return trustTools.clampTrust(score);
}

function makePrivateCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "P";

  for (let i = 0; i < 5; i++) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }

  return code;
}

function normalizePrivateCode(value) {
  return String(value || "")
    .trim()
    .replace("private:", "")
    .toUpperCase();
}

function privateRoomId(code) {
  return "private:" + normalizePrivateCode(code);
}

function isPrivateRoom(room) {
  return String(room || "").startsWith("private:");
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

async function changeTrust(nick, delta) {
  const result = await pool.query(
    `UPDATE users
     SET trust_score = LEAST(100, GREATEST(0, COALESCE(trust_score, 35) + $1))
     WHERE lower(nick) = lower($2)
     RETURNING trust_score`,
    [delta, nick]
  );

  return result.rows[0]?.trust_score;
}

async function touchUser(nick) {
  await pool.query(
    `UPDATE users SET last_seen = NOW() WHERE lower(nick) = lower($1)`,
    [nick]
  );
}

async function addPrivateMember(code, nick, role = "member") {
  const cleanCode = normalizePrivateCode(code);

  await pool.query(
    `INSERT INTO private_room_members (code, nick, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (code, nick) DO NOTHING`,
    [cleanCode, nick, role]
  );
}

async function isPrivateMember(code, nick) {
  const cleanCode = normalizePrivateCode(code);

  const result = await pool.query(
    `SELECT 1
     FROM private_room_members
     WHERE code = $1
     AND lower(nick) = lower($2)
     LIMIT 1`,
    [cleanCode, nick]
  );

  return result.rows.length > 0;
}

async function privateRoomExists(code) {
  const cleanCode = normalizePrivateCode(code);

  const result = await pool.query(
    `SELECT *
     FROM private_rooms
     WHERE code = $1
     AND is_active = true
     LIMIT 1`,
    [cleanCode]
  );

  return result.rows[0];
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
    rooms: roomsOnline
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

const roomsOnline = {};
const roomUsers = {};
const userSockets = {};

function addUserSocket(nick, socketId) {
  if (!nick) return;

  const key = String(nick).toLowerCase();

  if (!userSockets[key]) {
    userSockets[key] = new Set();
  }

  userSockets[key].add(socketId);
}

function removeUserSocket(nick, socketId) {
  if (!nick) return;

  const key = String(nick).toLowerCase();

  if (!userSockets[key]) return;

  userSockets[key].delete(socketId);

  if (userSockets[key].size === 0) {
    delete userSockets[key];
  }
}

function emitToNick(nick, event, payload) {
  if (!nick) return;

  const key = String(nick).toLowerCase();
  const sockets = userSockets[key];

  if (!sockets) return;

  for (const socketId of sockets) {
    io.to(socketId).emit(event, payload);
  }
}

function parseDuration(text) {
  const value = parseInt(text);
  if (!value) return null;

  if (text.endsWith("m")) return value * 60 * 1000;
  if (text.endsWith("h")) return value * 60 * 60 * 1000;
  if (text.endsWith("d")) return value * 24 * 60 * 60 * 1000;

  return value * 60 * 1000;
}

function emitRoomsOnline() {
  io.emit("roomsOnline", roomsOnline);
}

async function handleAdminCommand(socket, data) {
  const text = String(data.text || "").trim();
  const adminNick = String(data.user || "").trim();

  let admin = await getUserByNick(adminNick);
  admin = await ensureAdmin(admin);

  if (!admin || admin.role !== "admin") {
    socket.emit("system", "Нет прав администратора.");
    return true;
  }

  const parts = text.split(" ");
  const command = parts[0];
  const targetNick = parts[1];

  if (command === "/admin") {
    socket.emit(
      "system",
      "Команды: /status Nick Star ⭐ | /trust Nick | /settrust Nick 80 | /warn Nick | /report Nick причина | /ban Nick 1d | /permban Nick | /mute Nick 10m | /unban Nick"
    );
    return true;
  }

  if (!targetNick) {
    socket.emit("system", "Нужно указать ник.");
    return true;
  }

  const target = await getUserByNick(targetNick);

  if (!target) {
    socket.emit("system", "Пользователь не найден.");
    return true;
  }

  if (command === "/trust") {
    socket.emit(
      "system",
      `${target.nick}: trust ${target.trust_score}/100 · ${getTrustLevel(target.trust_score)} · warnings ${target.warnings_count} · reports ${target.reports_count} · mutes ${target.mutes_count} · bans ${target.bans_count}`
    );
    return true;
  }

  if (command === "/settrust") {
    const value = clampTrust(parts[2]);

    await pool.query(
      "UPDATE users SET trust_score = $1 WHERE lower(nick) = lower($2)",
      [value, targetNick]
    );

    socket.emit(
      "system",
      `${target.nick}: trust установлен ${value}/100 · ${getTrustLevel(value)}`
    );
    return true;
  }

  if (command === "/warn") {
    const newTrust = await changeTrust(targetNick, -5);

    await pool.query(
      `UPDATE users
       SET warnings_count = COALESCE(warnings_count, 0) + 1
       WHERE lower(nick) = lower($1)`,
      [targetNick]
    );

    io.emit(
      "system",
      `${target.nick} получил предупреждение. Trust: ${newTrust}/100 · ${getTrustLevel(newTrust)}`
    );
    return true;
  }

  if (command === "/report") {
    const reason = parts.slice(2).join(" ") || "без причины";
    const newTrust = await changeTrust(targetNick, -7);

    await pool.query(
      `UPDATE users
       SET reports_count = COALESCE(reports_count, 0) + 1
       WHERE lower(nick) = lower($1)`,
      [targetNick]
    );

    socket.emit(
      "system",
      `Жалоба на ${target.nick} сохранена: ${reason}. Trust: ${newTrust}/100 · ${getTrustLevel(newTrust)}`
    );
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
    const newTrust = await changeTrust(targetNick, -25);

    await pool.query(
      `UPDATE users
       SET ban_until = $1,
           bans_count = COALESCE(bans_count, 0) + 1
       WHERE lower(nick) = lower($2)`,
      [until, targetNick]
    );

    io.emit(
      "system",
      `${target.nick} временно забанен. Trust: ${newTrust}/100 · ${getTrustLevel(newTrust)}`
    );
    return true;
  }

  if (command === "/permban") {
    const newTrust = await changeTrust(targetNick, -60);

    await pool.query(
      `UPDATE users
       SET banned_forever = true,
           bans_count = COALESCE(bans_count, 0) + 1
       WHERE lower(nick) = lower($1)`,
      [targetNick]
    );

    io.emit(
      "system",
      `${target.nick} забанен навсегда. Trust: ${newTrust}/100 · ${getTrustLevel(newTrust)}`
    );
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
    const newTrust = await changeTrust(targetNick, -12);

    await pool.query(
      `UPDATE users
       SET muted_until = $1,
           mutes_count = COALESCE(mutes_count, 0) + 1
       WHERE lower(nick) = lower($2)`,
      [until, targetNick]
    );

    io.emit(
      "system",
      `${target.nick} получил мут. Trust: ${newTrust}/100 · ${getTrustLevel(newTrust)}`
    );
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
  console.log("connected", socket.id);

  socket.on("registerUser", async (data) => {
    const nick = String(data?.user || "").trim();

    if (!nick) return;

    socket.nick = nick;
    addUserSocket(nick, socket.id);

    await touchUser(nick);

    socket.emit("system", "NeoWAP: пользователь зарегистрирован в сети.");
  });

  socket.on("joinRoom", async (data) => {
    const room = data.room;
    const nick = data.user;

    if (!room || !nick) return;

    if (isPrivateRoom(room)) {
      const code = normalizePrivateCode(room);
      const allowed = await isPrivateMember(code, nick);

      if (!allowed) {
        socket.emit("system", "Нет доступа к этой закрытой комнате.");
        return;
      }
    }

    addUserSocket(nick, socket.id);

    if (socket.currentRoom) {
      socket.leave(socket.currentRoom);

      if (roomsOnline[socket.currentRoom]) {
        roomsOnline[socket.currentRoom] = Math.max(0, roomsOnline[socket.currentRoom] - 1);
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
    if (!data || !data.room || !data.user) return;

    socket.to(data.room).emit("typing", {
      user: data.user,
      active_status: data.active_status
    });
  });

  socket.on("createPrivateInvite", async (data) => {
    try {
      const fromNick = String(data?.from || "").trim();
      const toNick = String(data?.to || "").trim();
      const requestedCode = normalizePrivateCode(data?.code || "");

      if (!fromNick || !toNick) {
        socket.emit("privateInviteError", "Нужно указать ник.");
        return;
      }

      if (fromNick.toLowerCase() === toNick.toLowerCase()) {
        socket.emit("privateInviteError", "Нельзя пригласить самого себя.");
        return;
      }

      const inviter = await getUserByNick(fromNick);
      const target = await getUserByNick(toNick);

      if (!inviter) {
        socket.emit("privateInviteError", "Твой аккаунт не найден.");
        return;
      }

      if (!target) {
        socket.emit("privateInviteError", "Пользователь не найден.");
        return;
      }

      const now = new Date();

      if (inviter.banned_forever || (inviter.ban_until && new Date(inviter.ban_until) > now)) {
        socket.emit("privateInviteError", "Ты не можешь приглашать в приват из-за бана.");
        return;
      }

      if (inviter.muted_until && new Date(inviter.muted_until) > now) {
        socket.emit("privateInviteError", "Во время мута нельзя приглашать в приват.");
        return;
      }

      const warningLevel = getPrivateWarningLevel(inviter.trust_score || 35);

      if (warningLevel === "blocked") {
        socket.emit(
          "privateInviteError",
          "Sabrina: пока приватные комнаты закрыты для тебя. Немного пообщайся спокойно в общих комнатах — доступ вернётся."
        );
        return;
      }

      let code = requestedCode;

      if (code) {
        const room = await privateRoomExists(code);

        if (!room) {
          socket.emit("privateInviteError", "Комната с таким кодом не найдена.");
          return;
        }

        const member = await isPrivateMember(code, fromNick);

        if (!member) {
          socket.emit("privateInviteError", "Ты не участник этой комнаты.");
          return;
        }

      } else {
        code = makePrivateCode();

        await pool.query(
          `INSERT INTO private_rooms (code, created_by, invited_nick)
           VALUES ($1, $2, $3)`,
          [code, fromNick, toNick]
        );

        await addPrivateMember(code, fromNick, "owner");
      }

      const alreadyMember = await isPrivateMember(code, toNick);

      if (alreadyMember) {
        socket.emit("privateInviteError", "Этот пользователь уже участник комнаты.");
        return;
      }

      const invite = await pool.query(
        `INSERT INTO private_invites (code, from_nick, to_nick, warning_level)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [code, fromNick, toNick, warningLevel]
      );

      const payload = {
        ...invite.rows[0],
        from_status: getActiveStatus(inviter),
        from_trust_level: getTrustLevel(inviter.trust_score || 35)
      };

      socket.emit("privateInviteCreated", payload);
      emitToNick(toNick, "privateInvite", payload);

    } catch (e) {
      console.error("CREATE PRIVATE INVITE ERROR:", e);
      socket.emit("privateInviteError", "Ошибка создания приглашения.");
    }
  });

  socket.on("acceptPrivateInvite", async (data) => {
    try {
      const code = normalizePrivateCode(data?.code || "");
      const nick = String(data?.user || "").trim();

      if (!code || !nick) return;

      const result = await pool.query(
        `SELECT *
         FROM private_invites
         WHERE code = $1
         AND lower(to_nick) = lower($2)
         AND status = 'pending'
         LIMIT 1`,
        [code, nick]
      );

      const invite = result.rows[0];

      if (!invite) {
        socket.emit("privateInviteError", "Приглашение не найдено или уже закрыто.");
        return;
      }

      await pool.query(
        `UPDATE private_invites
         SET status = 'accepted',
             accepted_at = NOW()
         WHERE id = $1`,
        [invite.id]
      );

      await addPrivateMember(code, nick, "member");

      const room = privateRoomId(code);

      socket.emit("privateInviteAccepted", {
        code,
        room,
        from: invite.from_nick,
        to: invite.to_nick
      });

      emitToNick(invite.from_nick, "privateInviteAccepted", {
        code,
        room,
        from: invite.from_nick,
        to: invite.to_nick
      });

    } catch (e) {
      console.error("ACCEPT PRIVATE INVITE ERROR:", e);
      socket.emit("privateInviteError", "Ошибка принятия приглашения.");
    }
  });

  socket.on("declinePrivateInvite", async (data) => {
    try {
      const code = normalizePrivateCode(data?.code || "");
      const nick = String(data?.user || "").trim();

      if (!code || !nick) return;

      const result = await pool.query(
        `UPDATE private_invites
         SET status = 'declined',
             declined_at = NOW()
         WHERE code = $1
         AND lower(to_nick) = lower($2)
         AND status = 'pending'
         RETURNING *`,
        [code, nick]
      );

      const invite = result.rows[0];

      if (!invite) return;

      socket.emit("privateInviteDeclined", invite);

      emitToNick(invite.from_nick, "privateInviteDeclined", {
        code,
        from: invite.from_nick,
        to: invite.to_nick
      });

    } catch (e) {
      console.error("DECLINE PRIVATE INVITE ERROR:", e);
    }
  });

  socket.on("joinPrivateByCode", async (data) => {
    try {
      const code = normalizePrivateCode(data?.code || "");
      const nick = String(data?.user || "").trim();

      if (!code || !nick) {
        socket.emit("privateInviteError", "Укажи код комнаты.");
        return;
      }

      const room = await privateRoomExists(code);

      if (!room) {
        socket.emit("privateInviteError", "Комната не найдена.");
        return;
      }

      const member = await isPrivateMember(code, nick);

      if (!member) {
        socket.emit("privateInviteError", "Нет доступа. Нужно приглашение в эту комнату.");
        return;
      }

      socket.emit("privateJoinedByCode", {
        code,
        room: privateRoomId(code)
      });

    } catch (e) {
      console.error("JOIN PRIVATE BY CODE ERROR:", e);
      socket.emit("privateInviteError", "Ошибка входа по коду.");
    }
  });

  socket.on("message", async (data) => {
    try {
      const room = String(data.room).trim();
      const userNick = String(data.user).trim();
      const text = String(data.text).trim();

      if (!room || !userNick || !text) return;

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
        socket.emit("system", "У тебя временный мут.");
        return;
      }

      if (isPrivateRoom(room)) {
        const code = normalizePrivateCode(room);
        const allowed = await isPrivateMember(code, userNick);

        if (!allowed) {
          socket.emit("system", "Нет доступа к этой закрытой комнате.");
          return;
        }
      }

      await pool.query(
        `INSERT INTO messages (room, user_nick, text)
         VALUES ($1, $2, $3)`,
        [room, userNick, text]
      );

      const updated = await pool.query(
        `UPDATE users
         SET messages_count = messages_count + 1,
             last_seen = NOW(),
             trust_score = LEAST(
               100,
               GREATEST(
                 0,
                 COALESCE(trust_score, 35) + CASE WHEN messages_count % 50 = 0 THEN 1 ELSE 0 END
               )
             )
         WHERE lower(nick) = lower($1)
         RETURNING messages_count, paid_status, manual_status, trust_score`,
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
        messages_count: updatedUser.messages_count,
        trust_level: getTrustLevel(updatedUser.trust_score),
        trust_score: updatedUser.trust_score
      });

    } catch (e) {
      console.error("SOCKET MESSAGE ERROR:", e);
    }
  });

  socket.on("disconnect", () => {
    const room = socket.currentRoom;

    if (socket.nick) {
      removeUserSocket(socket.nick, socket.id);
    }

    if (room && roomsOnline[room]) {
      roomsOnline[room] = Math.max(0, roomsOnline[room] - 1);

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
