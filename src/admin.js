const { pool } = require("./db");
const userTools = require("./users");
const trustTools = require("./trust");

function getTrustLevel(score) {
  return trustTools.getTrustLevel(score);
}

function clampTrust(score) {
  return trustTools.clampTrust(score);
}

async function getUserByNick(nick) {
  return userTools.getUserByNick(nick);
}

async function ensureAdmin(user) {
  return userTools.ensureAdmin(user);
}

function parseDuration(text) {
  const value = parseInt(text);

  if (!value) return null;

  if (text.endsWith("m")) return value * 60 * 1000;
  if (text.endsWith("h")) return value * 60 * 60 * 1000;
  if (text.endsWith("d")) return value * 24 * 60 * 60 * 1000;

  return value * 60 * 1000;
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

async function handleAdminCommand(socket, data, io) {
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

    io.emit(
      "system",
      `Админ изменил статус пользователя ${target.nick} на ${status}`
    );

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

module.exports = {
  handleAdminCommand,
  parseDuration,
  changeTrust
};
