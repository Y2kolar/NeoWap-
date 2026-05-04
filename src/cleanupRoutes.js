const express = require("express");
const bcrypt = require("bcryptjs");
const { pool } = require("./db");

const formParser = express.urlencoded({ extended: false });

const TABLES_TO_CLEAN = [
  "messages",
  "private_reports",
  "notifications",
  "private_invites",
  "private_invite_requests",
  "private_invite_request_votes",
  "private_room_members",
  "private_rooms",
  "sabrina_imprints"
];

function page(message = "") {
  return `
<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>NeoWAP cleanup</title>
  <style>
    body{
      margin:0;
      background:#020604;
      color:#b8ffd0;
      font-family:monospace;
      padding:24px;
    }
    .box{
      max-width:520px;
      margin:0 auto;
      border:1px solid rgba(57,255,138,.25);
      border-radius:18px;
      padding:18px;
      background:#07120d;
    }
    h1{color:#39ff8a;font-size:22px;}
    input,button{
      width:100%;
      box-sizing:border-box;
      margin:8px 0;
      padding:14px;
      border-radius:12px;
      font-family:monospace;
      font-size:16px;
    }
    input{
      background:#020604;
      border:1px solid rgba(57,255,138,.25);
      color:#b8ffd0;
    }
    button{
      border:0;
      background:#39ff8a;
      color:#020604;
      font-weight:bold;
    }
    .msg{
      white-space:pre-wrap;
      color:#ffd36e;
      margin-bottom:12px;
    }
    .small{
      color:#7fa08a;
      font-size:13px;
      line-height:1.5;
    }
  </style>
</head>
<body>
  <div class="box">
    <h1>NeoWAP cleanup</h1>

    ${message ? `<div class="msg">${message}</div>` : ""}

    <form method="POST" action="/admin/cleanup-test-data">
      <input name="nick" placeholder="Admin nick" autocomplete="username" required>
      <input name="password" placeholder="Admin password" type="password" autocomplete="current-password" required>

      <button type="submit">Очистить тестовые данные</button>
    </form>

    <div class="small">
      Пользователи не удаляются. Чистятся сообщения, приватки, жалобы, уведомления и серверные следы Sabrina.
    </div>
  </div>
</body>
</html>
`;
}

async function tableExists(client, tableName) {
  const result = await client.query(
    "SELECT to_regclass($1) AS name",
    ["public." + tableName]
  );

  return Boolean(result.rows[0] && result.rows[0].name);
}

async function checkAdmin(nick, password) {
  const result = await pool.query(
    `SELECT *
     FROM users
     WHERE lower(nick) = lower($1)
     LIMIT 1`,
    [String(nick || "").trim()]
  );

  const user = result.rows[0];

  if (!user) return false;

  const role = String(user.role || "").toLowerCase();

  if (role !== "admin") return false;

  const hash =
    user
