const { pool } = require("./db");

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

async function touchUser(nick) {
  await pool.query(
    `UPDATE users
     SET last_seen = NOW()
     WHERE lower(nick) = lower($1)`,
    [nick]
  );
}

module.exports = {
  getUserByNick,
  ensureAdmin,
  touchUser
};
