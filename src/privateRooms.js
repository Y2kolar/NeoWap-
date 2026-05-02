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

module.exports = {
  makePrivateCode,
  normalizePrivateCode,
  privateRoomId,
  isPrivateRoom,
  addPrivateMember,
  isPrivateMember,
  privateRoomExists
};
