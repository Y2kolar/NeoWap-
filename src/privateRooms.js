const { pool } = require("./db");

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

async function addPrivateMember(code, nick, role = "member") {
  const cleanCode = normalizePrivateCode(code);

  await pool.query(
    `INSERT INTO private_room_members (code, nick, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (code, nick) DO NOTHING`,
    [cleanCode, nick, role]
  );
}

async function getPrivateMember(code, nick) {
  const cleanCode = normalizePrivateCode(code);

  const result = await pool.query(
    `SELECT *
     FROM private_room_members
     WHERE code = $1
     AND lower(nick) = lower($2)
     LIMIT 1`,
    [cleanCode, nick]
  );

  return result.rows[0];
}

async function isPrivateMember(code, nick) {
  const member = await getPrivateMember(code, nick);
  return Boolean(member);
}

async function isPrivateOwner(code, nick) {
  const member = await getPrivateMember(code, nick);
  return Boolean(member && member.role === "owner");
}

async function getPrivateMembers(code) {
  const cleanCode = normalizePrivateCode(code);

  const result = await pool.query(
    `SELECT nick, role, joined_at
     FROM private_room_members
     WHERE code = $1
     ORDER BY
       CASE WHEN role = 'owner' THEN 0 ELSE 1 END,
       joined_at ASC`,
    [cleanCode]
  );

  return result.rows;
}

async function removePrivateMember(code, nick) {
  const cleanCode = normalizePrivateCode(code);

  await pool.query(
    `DELETE FROM private_room_members
     WHERE code = $1
     AND lower(nick) = lower($2)`,
    [cleanCode, nick]
  );
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

async function closePrivateRoom(code) {
  const cleanCode = normalizePrivateCode(code);

  await pool.query(
    `UPDATE private_rooms
     SET is_active = false
     WHERE code = $1`,
    [cleanCode]
  );

  await pool.query(
    `UPDATE private_invites
     SET status = 'room_closed'
     WHERE code = $1
     AND status = 'pending'`,
    [cleanCode]
  );
}

async function createPrivateReport(code, reporterNick, targetNick, reason) {
  const cleanCode = normalizePrivateCode(code);

  const result = await pool.query(
    `INSERT INTO private_reports (code, reporter_nick, target_nick, reason)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [cleanCode, reporterNick, targetNick, reason || "без причины"]
  );

  return result.rows[0];
}

module.exports = {
  makePrivateCode,
  normalizePrivateCode,
  privateRoomId,
  isPrivateRoom,
  addPrivateMember,
  getPrivateMember,
  isPrivateMember,
  isPrivateOwner,
  getPrivateMembers,
  removePrivateMember,
  privateRoomExists,
  closePrivateRoom,
  createPrivateReport
};
