console.log("NeoWAP app.js v13 loaded");

const SERVER_URL = "https://neowap-production.up.railway.app";

let socket = null;
let currentUser = null;
let currentRoom = null;
let currentPrivateCode = null;
let typingTimer = null;

let roomsOnline = {};
let pendingInvites = {};
let myPrivateRooms = {};

const rooms = [
  { id: "main", name: "Главная", desc: "Общий ламповый чат." },
  { id: "night", name: "Ночной двор", desc: "Для поздних разговоров." },
  { id: "nostalgia", name: "2007 memories", desc: "Аська, Nokia, старые сайты." },
  { id: "quiet", name: "Тихая комната", desc: "Для тех, кто просто хочет посидеть." }
];

function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => {
    s.classList.remove("active");
  });

  const screen = document.getElementById(id);
  if (screen) screen.classList.add("active");

  const inputBar = document.getElementById("inputBar");
  const typingLine = document.getElementById("typingLine");

  if (id === "chatScreen" && currentRoom) {
    inputBar.classList.add("active");
  } else {
    inputBar.classList.remove("active");
    typingLine.classList.remove("active");
  }
}

function renderRooms() {
  const box = document.getElementById("rooms");
  if (!box) return;

  let html = "";

  rooms.forEach((room) => {
    html += `
      <div class="card room" onclick="enterRoom('${room.id}')">
        <div class="room-name">
          <span>${room.name}</span>
          <span class="online">${roomsOnline[room.id] || 0} online</span>
        </div>
        <div class="room-desc">${room.desc}</div>
      </div>
    `;
  });

  box.innerHTML = html;
}

async function login() {
  const nickInput = document.getElementById("nickInput");
  const passInput = document.getElementById("passInput");
  const error = document.getElementById("loginError");
  const ok = document.getElementById("loginOk");

  const nick = nickInput.value.trim();
  const password = passInput.value.trim();

  error.innerText = "";
  ok.innerText = "";

  if (nick.length < 3) {
    error.innerText = "Ник минимум 3 символа.";
    return;
  }

  if (password.length < 4) {
    error.innerText = "Пароль минимум 4 символа.";
    return;
  }

  try {
    ok.innerText = "Подключаюсь...";

    const res = await fetch(SERVER_URL + "/auth", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ nick, password })
    });

    const data = await res.json();

    if (!res.ok || !data.ok) {
      ok.innerText = "";
      error.innerText = data.error || "Ошибка входа.";
      return;
    }

    currentUser = {
      id: data.user.id,
      nick: data.user.nick,
      messages: Number(data.user.messages_count || 0),
      role: data.user.role || "user",
      active_status: data.user.active_status || "No body 🌑",
      earned_status: data.user.earned_status || "No body 🌑",
      trust_level: data.user.trust_level || "новый",
      trust_score: data.user.trust_score || 35
    };

    localStorage.setItem("neowap_nick", currentUser.nick);
    localStorage.setItem("neowap_pass", password);

    ok.innerText = data.mode === "registered" ? "Ник создан." : "Вход выполнен.";

    setTimeout(afterLogin, 250);

  } catch (e) {
    console.error("LOGIN ERROR:", e);
    ok.innerText = "";
    error.innerText = "Сервер не отвечает.";
  }
}

async function afterLogin() {
  const topUser = document.getElementById("topUser");
  topUser.innerText = currentUser.nick;

  renderRooms();
  connectSocket();
  showScreen("roomsScreen");

  try {
    const r = await fetch(SERVER_URL + "/rooms-online");
    const d = await r.json();

    if (d.ok) {
      roomsOnline = d.rooms || {};
      renderRooms();
    }
  } catch (e) {}

  await loadPendingInvites();
  await loadMyPrivateRooms();
}

function connectSocket() {
  if (socket) {
    if (!socket.connected) socket.connect();
    return;
  }

  socket = io(SERVER_URL, {
    transports: ["websocket", "polling"]
  });

  socket.on("connect", () => {
    if (currentUser) {
      socket.emit("registerUser", {
        user: currentUser.nick
      });
    }
  });

  socket.on("connect_error", () => {
    showSystem("Сервер не отвечает. Проверь Railway.");
  });

  socket.on("roomsOnline", (data) => {
    roomsOnline = data || {};
    renderRooms();
  });

  socket.on("roomUsers", (users) => {
    const box = document.getElementById("roomUsers");
    box.innerText = users && users.length
      ? "Сейчас здесь: " + users.join(", ")
      : "";
  });

  socket.on("typing", (data) => {
    if (!currentRoom || !data || data.user === currentUser.nick) return;

    const line = document.getElementById("typingLine");

    line.innerText =
      (data.active_status ? data.active_status + " " : "") +
      data.user +
      " печатает...";

    line.classList.add("active");

    clearTimeout(typingTimer);

    typingTimer = setTimeout(() => {
      line.classList.remove("active");
    }, 1800);
  });

  socket.on("message", (data) => {
    if (!data || !currentUser) return;

    if (data.user === currentUser.nick) {
      updateCurrentUserFromMessage(data);
      return;
    }

    addMessage(
      data.user || "unknown",
      data.text || "",
      false,
      data.active_status || "No body 🌑"
    );
  });

  socket.on("messageSaved", (data) => {
    if (!data || !currentUser) return;

    if (data.user === currentUser.nick) {
      updateCurrentUserFromMessage(data);
    }
  });

  socket.on("system", (text) => {
    showSystem(text);

    if (
      currentUser &&
      currentUser.role === "admin" &&
      typeof text === "string" &&
      (text.includes("🚩") || text.toLowerCase().includes("жалоба"))
    ) {
      appendAdminLog(text);
    }
  });

  socket.on("adminPrivateReport", (data) => {
    const text = data && data.text ? data.text : "🚩 Новая жалоба в приватной комнате.";

    appendAdminLog(text);
    appendPrivateLog(text);
  });

  socket.on("privateInvite", (invite) => {
    addPendingInvite(invite);
    showInvitePopup(invite);
  });

  socket.on("privateInviteCreated", (invite) => {
    appendPrivateLog("Приглашение отправлено: " + invite.to_nick + " · код " + invite.code);

    if (currentPrivateCode && invite.code === currentPrivateCode) {
      appendPrivateRoomLog("Приглашение отправлено: " + invite.to_nick);
    }

    loadMyPrivateRooms();
  });

  socket.on("privateInviteError", (text) => {
    appendPrivateLog("Ошибка: " + text);
    appendPrivateRoomLog("Ошибка: " + text);
  });

  socket.on("privateInviteAccepted", (data) => {
    appendPrivateLog("Приватная комната открыта: " + data.code);
    enterPrivateRoom(data.room, data.code);
    loadMyPrivateRooms();
  });

  socket.on("privateInviteDeclined", (data) => {
    appendPrivateLog("Приглашение отклонено: " + data.to);
  });

  socket.on("privateJoinedByCode", (data) => {
    enterPrivateRoom(data.room, data.code);
  });

  socket.on("privateMembersFull", (data) => {
    if (!data || !Array.isArray(data.members)) return;

    const list = data.members
      .map((m) => `${m.role === "owner" ? "👑" : "👤"} ${m.nick} · ${m.role}`)
      .join("\n");

    appendPrivateRoomLog("Участники комнаты " + data.code + ":\n" + list);
  });

  socket.on("privateLeftForever", (data) => {
    appendPrivateLog("Ты покинул приватную комнату " + data.code + ".");
    appendPrivateRoomLog("Ты покинул эту комнату навсегда.");

    if (data && data.code) {
      delete myPrivateRooms[data.code];
      renderMyPrivateRooms();
    }

    currentRoom = null;
    currentPrivateCode = null;

    hidePrivateTools();
    loadMyPrivateRooms();
    goHome();
  });

  socket.on("privateClosed", (data) => {
    appendPrivateLog("Приватная комната " + data.code + " закрыта.");
    appendPrivateRoomLog("Комната закрыта владельцем.");

    if (data && data.code) {
      delete myPrivateRooms[data.code];
      renderMyPrivateRooms();
    }

    currentRoom = null;
    currentPrivateCode = null;

    hidePrivateTools();
    loadMyPrivateRooms();
    goHome();
  });

  socket.on("privateReportResult", (text) => {
    appendPrivateRoomLog(text);
  });
}

function updateCurrentUserFromMessage(data) {
  if (typeof data.messages_count === "number") {
    currentUser.messages = data.messages_count;
  }

  if (data.active_status) {
    currentUser.active_status = data.active_status;
  }

  if (data.trust_level) {
    currentUser.trust_level = data.trust_level;
  }

  if (typeof data.trust_score === "number") {
    currentUser.trust_score = data.trust_score;
  }
}

function showSystem(text) {
  if (currentRoom && document.getElementById("chatScreen").classList.contains("active")) {
    addSystem(text);
    return;
  }

  appendPrivateLog(text);
  appendAdminLog(text);
}

async function loadPendingInvites() {
  if (!currentUser) return;

  try {
    const res = await fetch(SERVER_URL + "/private-invites/" + encodeURIComponent(currentUser.nick));
    const data = await res.json();

    if (data.ok && Array.isArray(data.invites)) {
      data.invites.forEach((invite) => {
        addPendingInvite(invite);
      });
    }
  } catch (e) {}
}

async function loadMyPrivateRooms() {
  if (!currentUser) return;

  try {
    const res = await fetch(SERVER_URL + "/private-rooms/" + encodeURIComponent(currentUser.nick));
    const data = await res.json();

    if (data.ok && Array.isArray(data.rooms)) {
      myPrivateRooms = {};

      data.rooms.forEach((room) => {
        myPrivateRooms[room.code] = room;
      });

      renderMyPrivateRooms();
    }
  } catch (e) {}
}

function renderMyPrivateRooms() {
  const card = document.getElementById("myPrivateRoomsCard");
  const box = document.getElementById("myPrivateRooms");

  if (!card || !box) return;

  const roomsList = Object.values(myPrivateRooms || {});

  if (!roomsList.length) {
    card.style.display = "none";
    box.innerHTML = "";
    return;
  }

  card.style.display = "block";

  let html = "";

  roomsList.forEach((room) => {
    const rawCode = String(room.code || "").trim();
    const code = escapeHtml(rawCode);
    const roleRaw = String(room.role || "member").trim().toLowerCase();
    const role = escapeHtml(roleRaw);
    const creator = escapeHtml(room.created_by || "unknown");

    const actionButton = roleRaw === "owner"
      ? `<button class="btn danger" onclick="closePrivateFromList('${code}')">Закрыть комнату</button>`
      : `<button class="btn danger" onclick="leavePrivateFromList('${code}')">Покинуть навсегда</button>`;

    html += `
      <div class="card">
        <div class="title">🔒 ${code}</div>
        <div class="subtitle">
          Создал: ${creator}<br>
          Твоя роль: ${role}
        </div>

        <button class="btn secondary" onclick="joinPrivateByCodeValue('${code}')">Войти</button>
        ${actionButton}
      </div>
    `;
  });

  box.innerHTML = html;
}

function warningText(invite) {
  if (invite.warning_level === "strong" || invite.warning_level === "blocked") {
    return "Sabrina: Я бы не советовала переходить в приват прямо сейчас. У пользователя были предупреждения или жалобы. Если всё равно хочешь — решение за тобой.";
  }

  if (invite.warning_level === "soft") {
    return "Sabrina: Этот пользователь ещё не очень проверен в NeoWAP. Лучше не спешить и сначала немного пообщаться в общей комнате.";
  }

  return "Sabrina: Пользователь приглашает тебя в закрытую комнату.";
}

function addPendingInvite(invite) {
  if (!invite || !invite.code) return;

  pendingInvites[invite.code] = invite;
  renderPendingInvites();
}

function removePendingInvite(code) {
  delete pendingInvites[code];

  renderPendingInvites();

  const popup = document.getElementById("invitePopup");
  popup.classList.remove("active");
  popup.innerHTML = "";
}

function renderPendingInvites() {
  const box = document.getElementById("pendingInvites");
  const card = document.getElementById("pendingInvitesCard");

  const invites = Object.values(pendingInvites);

  if (!invites.length) {
    card.style.display = "none";
    box.innerHTML = "";
    return;
  }

  card.style.display = "block";

  let html = "";

  invites.forEach((invite) => {
    html += `
      <div class="card invite-card">
        <div class="title">${escapeHtml(invite.from_nick)} приглашает в приват</div>
        <div class="subtitle">Код комнаты: ${escapeHtml(invite.code)}</div>
        <div class="invite-warning">${escapeHtml(warningText(invite))}</div>
        <button class="btn secondary" onclick="acceptPrivateInvite('${escapeHtml(invite.code)}')">Принять</button>
        <button class="btn danger" onclick="declinePrivateInvite('${escapeHtml(invite.code)}')">Отказаться</button>
      </div>
    `;
  });

  box.innerHTML = html;
}

function showInvitePopup(invite) {
  const popup = document.getElementById("invitePopup");

  popup.innerHTML = `
    <div class="card invite-card">
      <div class="title">Закрытая комната</div>
      <div class="subtitle">${escapeHtml(invite.from_nick)} приглашает тебя в приват.</div>
      <div class="invite-warning">${escapeHtml(warningText(invite))}</div>
      <button class="btn secondary" onclick="acceptPrivateInvite('${escapeHtml(invite.code)}')">Принять</button>
      <button class="btn danger" onclick="declinePrivateInvite('${escapeHtml(invite.code)}')">Отказаться</button>
    </div>
  `;

  popup.classList.add("active");
}

function togglePrivateCreateBlock() {
  const block = document.getElementById("privateCreateBlock");
  const btn = document.getElementById("privateCreateToggle");

  if (!block || !btn) return;

  const opened = block.classList.toggle("active");

  btn.innerText = opened
    ? "Скрыть управление приватками"
    : "Открыть управление приватками";
}

function createPrivateInvite() {
  const target = document.getElementById("privateTarget").value.trim();
  const code = document.getElementById("privateCodeForInvite").value.trim();

  if (!target) {
    appendPrivateLog("Укажи ник для приглашения.");
    return;
  }

  if (!socket || !socket.connected) {
    connectSocket();
    appendPrivateLog("Сервер подключается. Повтори действие через секунду.");
    return;
  }

  socket.emit("createPrivateInvite", {
    from: currentUser.nick,
    to: target,
    code: code
  });

  appendPrivateLog("Отправляю приглашение для " + target + "...");
}

function inviteMoreToCurrentPrivate() {
  const target = document.getElementById("privateInviteMoreNick").value.trim();

  if (!target) {
    appendPrivateRoomLog("Укажи ник для приглашения.");
    return;
  }

  if (!currentPrivateCode) {
    appendPrivateRoomLog("Ты сейчас не в приватной комнате.");
    return;
  }

  if (!socket || !socket.connected) {
    connectSocket();
    appendPrivateRoomLog("Сервер подключается. Повтори действие через секунду.");
    return;
  }

  socket.emit("createPrivateInvite", {
    from: currentUser.nick,
    to: target,
    code: currentPrivateCode
  });

  appendPrivateRoomLog("Приглашение отправляется для " + target + ".");
  document.getElementById("privateInviteMoreNick").value = "";
}

function joinPrivateByCode() {
  const code = document.getElementById("privateJoinCode").value.trim();
  joinPrivateByCodeValue(code);
}

function joinPrivateByCodeValue(code) {
  if (!code) {
    appendPrivateLog("Укажи код комнаты.");
    return;
  }

  if (!socket || !socket.connected) {
    connectSocket();
    appendPrivateLog("Сервер подключается. Повтори действие через секунду.");
    return;
  }

  socket.emit("joinPrivateByCode", {
    code: code,
    user: currentUser.nick
  });
}

function acceptPrivateInvite(code) {
  if (!socket || !socket.connected) {
    connectSocket();
    appendPrivateLog("Сервер подключается. Повтори действие через секунду.");
    return;
  }

  socket.emit("acceptPrivateInvite", {
    code: code,
    user: currentUser.nick
  });

  removePendingInvite(code);
}

function declinePrivateInvite(code) {
  if (!socket || !socket.connected) {
    connectSocket();
    appendPrivateLog("Сервер подключается. Повтори действие через секунду.");
    return;
  }

  socket.emit("declinePrivateInvite", {
    code: code,
    user: currentUser.nick
  });

  removePendingInvite(code);
}

async function enterPrivateRoom(roomId, code) {
  currentPrivateCode = String(code || "").replace("private:", "").toUpperCase();

  currentRoom = {
    id: roomId,
    name: "Приват " + currentPrivateCode,
    desc: "Закрытая комната"
  };

  document.getElementById("chat").innerHTML = "";
  document.getElementById("roomUsers").innerText = "";

  document.getElementById("statusText").innerHTML =
    "🔒 Закрытая комната · " + escapeHtml(currentPrivateCode) + "<br>Приватный разговор";

  document.getElementById("privateWatermark").innerText =
    "NeoWAP • " + currentUser.nick + " • " + currentPrivateCode;

  document.getElementById("privateWatermark").classList.add("active");

  document.getElementById("privateTools").classList.add("active");
  document.getElementById("privateRoomLog").innerText = "События приватной комнаты будут здесь.";

  document.getElementById("privateRoomInfo").innerHTML =
    "Код комнаты: <b>" + escapeHtml(currentPrivateCode) + "</b><br>Можно пригласить ещё людей по нику.";

  showScreen("chatScreen");

  addSystem("Ты вошёл в закрытую комнату " + currentPrivateCode + ".");
  addSystem("Sabrina: Помни, приватность — это доверие, а не магия. Не делись тем, что может навредить тебе.");

  await loadHistory(roomId);

  if (socket && socket.connected) {
    socket.emit("joinRoom", {
      room: roomId,
      user: currentUser.nick
    });

    socket.emit("requestPrivateMembers", {
      code: currentPrivateCode,
      user: currentUser.nick
    });
  } else {
    connectSocket();
    addSystem("Подключаюсь к серверу...");
  }
}

async function enterRoom(roomId) {
  const room = rooms.find((r) => r.id === roomId);
  if (!room) return;

  currentPrivateCode = null;
  currentRoom = room;

  hidePrivateTools();

  document.getElementById("chat").innerHTML = "";
  document.getElementById("roomUsers").innerText = "";

  showScreen("chatScreen");

  document.getElementById("statusText").innerHTML =
    `● ${room.name} · ${roomsOnline[room.id] || 0} online<br>${room.desc}`;

  addSystem("Ты вошёл в комнату.");

  await loadHistory(room.id);

  if (socket && socket.connected) {
    socket.emit("joinRoom", {
      room: room.id,
      user: currentUser.nick
    });
  } else {
    addSystem("Подключаюсь к серверу...");
    connectSocket();

    setTimeout(() => {
      if (socket && socket.connected) {
        socket.emit("joinRoom", {
          room: room.id,
          user: currentUser.nick
        });
      }
    }, 1000);
  }

  setTimeout(() => {
    addMessage(
      "Sabrina",
      "Можно просто читать. Не обязательно сразу что-то говорить.",
      false,
      "NeoWAP Host"
    );
  }, 700);
}

async function loadHistory(roomId) {
  try {
    const res = await fetch(SERVER_URL + "/messages/" + encodeURIComponent(roomId));
    const data = await res.json();

    if (data.ok && Array.isArray(data.messages) && data.messages.length) {
      addSystem("Последние сообщения комнаты:");

      data.messages.forEach((m) => {
        addMessage(
          m.user_nick,
          m.text,
          currentUser && m.user_nick === currentUser.nick,
          m.active_status || "No body 🌑"
        );
      });
    }

  } catch (e) {
    addSystem("История сообщений пока не загрузилась.");
  }
}

function sendTyping() {
  if (socket && socket.connected && currentRoom && currentUser) {
    socket.emit("typing", {
      room: currentRoom.id,
      user: currentUser.nick,
      active_status: currentUser.active_status
    });
  }
}

function sendMessage() {
  const input = document.getElementById("msgInput");
  if (!input) return;

  const text = input.value.trim();
  if (!text) return;

  if (!currentUser) {
    input.value = text;
    return;
  }

  if (!currentRoom) {
    input.value = text;
    appendPrivateLog("Сначала войди в комнату.");
window.login = login;
window.goHome = goHome;
window.goChat = goChat;
window.goProfile = goProfile;
window.logout = logout;

window.sendMessage = sendMessage;
window.sendTyping = sendTyping;

window.togglePrivateCreateBlock = togglePrivateCreateBlock;
window.createPrivateInvite = createPrivateInvite;
window.joinPrivateByCode = joinPrivateByCode;
window.joinPrivateByCodeValue = joinPrivateByCodeValue;
window.inviteMoreToCurrentPrivate = inviteMoreToCurrentPrivate;
window.requestPrivateMembers = requestPrivateMembers;
window.reportPrivateRoom = reportPrivateRoom;
window.leavePrivateForever = leavePrivateForever;
window.closePrivateRoom = closePrivateRoom;
window.leavePrivateFromList = leavePrivateFromList;
window.closePrivateFromList = closePrivateFromList;

window.acceptPrivateInvite = acceptPrivateInvite;
window.declinePrivateInvite = declinePrivateInvite;

window.adminTrust = adminTrust;
window.adminWarn = adminWarn;
window.adminMute = adminMute;
window.adminBan = adminBan;
window.adminPermBan = adminPermBan;
window.adminUnban = adminUnban;
window.adminSetTrust = adminSetTrust;
window.adminSetStatus = adminSetStatus;

window.loadAdminReports = loadAdminReports;
window.loadAdminReportDetail = loadAdminReportDetail;
window.adminReportAction = adminReportAction;
    
