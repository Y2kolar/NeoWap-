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
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");

  if (id === "chatScreen" && currentRoom) {
    document.getElementById("inputBar").classList.add("active");
  } else {
    document.getElementById("inputBar").classList.remove("active");
    document.getElementById("typingLine").classList.remove("active");
  }
}

function renderRooms() {
  let html = "";

  rooms.forEach(room => {
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

  document.getElementById("rooms").innerHTML = html;
}

async function login() {
  const nick = document.getElementById("nickInput").value.trim();
  const password = document.getElementById("passInput").value.trim();

  const error = document.getElementById("loginError");
  const ok = document.getElementById("loginOk");

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
      headers: { "Content-Type": "application/json" },
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

    setTimeout(afterLogin, 300);

  } catch (e) {
    ok.innerText = "";
    error.innerText = "Сервер не отвечает.";
  }
}

async function afterLogin() {
  document.getElementById("topUser").innerText = currentUser.nick;

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
  if (socket) return;

  socket = io(SERVER_URL, {
    transports: ["websocket", "polling"]
  });

  socket.on("connect", () => {
    console.log("NeoWAP connected");

    if (currentUser) {
      socket.emit("registerUser", {
        user: currentUser.nick
      });
    }
  });

  socket.on("connect_error", () => {
    showSystem("Сервер не отвечает. Проверь Railway.");
  });

  socket.on("roomsOnline", data => {
    roomsOnline = data || {};
    renderRooms();
  });

  socket.on("roomUsers", users => {
    document.getElementById("roomUsers").innerText =
      users && users.length ? "Сейчас здесь: " + users.join(", ") : "";
  });

  socket.on("typing", data => {
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

  socket.on("message", data => {
    if (!data || !currentUser) return;

    if (data.user === currentUser.nick) {
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

      return;
    }

    addMessage(
      data.user || "unknown",
      data.text || "",
      false,
      data.active_status || "No body 🌑"
    );
  });

  socket.on("system", text => {
    showSystem(text);
  });

  socket.on("privateInvite", invite => {
    addPendingInvite(invite);
    showInvitePopup(invite);
  });

  socket.on("privateInviteCreated", invite => {
    appendPrivateLog("Приглашение отправлено: " + invite.to_nick + " · код " + invite.code);

    if (currentPrivateCode && invite.code === currentPrivateCode) {
      appendPrivateRoomLog("Приглашение отправлено: " + invite.to_nick);
    }

    loadMyPrivateRooms();
  });

  socket.on("privateInviteError", text => {
    appendPrivateLog("Ошибка: " + text);
    appendPrivateRoomLog("Ошибка: " + text);
  });

  socket.on("privateInviteAccepted", data => {
    appendPrivateLog("Приватная комната открыта: " + data.code);
    enterPrivateRoom(data.room, data.code);
    loadMyPrivateRooms();
  });

  socket.on("privateInviteDeclined", data => {
    appendPrivateLog("Приглашение отклонено: " + data.to);
  });

  socket.on("privateJoinedByCode", data => {
    enterPrivateRoom(data.room, data.code);
  });

  socket.on("privateMembersFull", data => {
    if (!data || !Array.isArray(data.members)) return;

    const list = data.members
      .map(m => `${m.role === "owner" ? "👑" : "👤"} ${m.nick} · ${m.role}`)
      .join("\n");

    appendPrivateRoomLog("Участники комнаты " + data.code + ":\n" + list);
  });

  socket.on("privateLeftForever", data => {
    appendPrivateLog("Ты покинул приватную комнату " + data.code + ".");
    appendPrivateRoomLog("Ты покинул эту комнату навсегда.");

    currentRoom = null;
    currentPrivateCode = null;

    document.getElementById("privateTools").classList.remove("active");
    document.getElementById("privateWatermark").classList.remove("active");
    document.getElementById("privateWatermark").innerText = "";

    loadMyPrivateRooms();
    goHome();
  });

  socket.on("privateClosed", data => {
    appendPrivateLog("Приватная комната " + data.code + " закрыта.");
    appendPrivateRoomLog("Комната закрыта владельцем.");

    currentRoom = null;
    currentPrivateCode = null;

    document.getElementById("privateTools").classList.remove("active");
    document.getElementById("privateWatermark").classList.remove("active");
    document.getElementById("privateWatermark").innerText = "";

    loadMyPrivateRooms();
    goHome();
  });

  socket.on("privateReportResult", text => {
    appendPrivateRoomLog(text);
  });
  socket.on("adminPrivateReport", data => {
  const text = data?.text || "Новая жалоба в приватной комнате.";

  appendAdminLog(text);
  appendPrivateLog(text);
});
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
      data.invites.forEach(invite => {
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

      data.rooms.forEach(room => {
        myPrivateRooms[room.code] = room;
      });

      renderMyPrivateRooms();
    }
  } catch (e) {}
}

function renderMyPrivateRooms() {
  const card = document.getElementById("myPrivateRoomsCard");
  const box = document.getElementById("myPrivateRooms");

  const roomsList = Object.values(myPrivateRooms);

  if (!roomsList.length) {
    card.style.display = "none";
    box.innerHTML = "";
    return;
  }

  card.style.display = "block";

  let html = "";

  roomsList.forEach(room => {
    html += `
      <div class="card">
        <div class="title">🔒 ${escapeHtml(room.code)}</div>
        <div class="subtitle">
          Создал: ${escapeHtml(room.created_by || "unknown")}<br>
          Твоя роль: ${escapeHtml(room.role || "member")}
        </div>
        <button class="btn secondary" onclick="joinPrivateByCodeValue('${escapeHtml(room.code)}')">Войти</button>
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

  invites.forEach(invite => {
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

function createPrivateInvite() {
  const target = document.getElementById("privateTarget").value.trim();
  const code = document.getElementById("privateCodeForInvite").value.trim();

  if (!target) {
    appendPrivateLog("Укажи ник для приглашения.");
    return;
  }

  if (!socket || !socket.connected) {
    appendPrivateLog("Сервер ещё не подключён.");
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
    addSystem("Укажи ник для приглашения.");
    return;
  }

  if (!currentPrivateCode) {
    addSystem("Ты сейчас не в приватной комнате.");
    return;
  }

  if (!socket || !socket.connected) {
    addSystem("Сервер не подключён.");
    return;
  }

  socket.emit("createPrivateInvite", {
    from: currentUser.nick,
    to: target,
    code: currentPrivateCode
  });

  addSystem("Sabrina: приглашение отправлено для " + target + ".");
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
    appendPrivateLog("Сервер не подключён.");
    return;
  }

  socket.emit("joinPrivateByCode", {
    code: code,
    user: currentUser.nick
  });
}

function acceptPrivateInvite(code) {
  if (!socket || !socket.connected) {
    appendPrivateLog("Сервер не подключён.");
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
    appendPrivateLog("Сервер не подключён.");
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
  }
}

async function enterRoom(roomId) {
  const room = rooms.find(r => r.id === roomId);
  if (!room) return;

  currentPrivateCode = null;
  currentRoom = room;

  document.getElementById("privateTools").classList.remove("active");
  document.getElementById("privateWatermark").classList.remove("active");
  document.getElementById("privateWatermark").innerText = "";

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

      data.messages.forEach(m => {
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
  const text = input.value.trim();

  if (!text || !currentRoom || !currentUser) return;

  input.value = "";

  addMessage(
    currentUser.nick,
    text,
    true,
    currentUser.active_status
  );

  if (socket && socket.connected) {
    socket.emit("message", {
      room: currentRoom.id,
      user: currentUser.nick,
      text: text
    });
  } else {
    addSystem("Сообщение показано у тебя, но сервер не подключён.");
  }

  maybeSabrina(text);
}

function addMessage(user, text, me, status) {
  const chat = document.getElementById("chat");

  const div = document.createElement("div");

  div.className = "msg" + (me ? " me" : "");

  div.innerHTML = `
    <div class="nick">
      <span class="rank">${escapeHtml(status || "No body 🌑")}</span>
      ${escapeHtml(user)}
    </div>
    <div>${escapeHtml(text)}</div>
  `;

  chat.appendChild(div);

  scrollChat();
}

function addSystem(text) {
  const chat = document.getElementById("chat");

  const div = document.createElement("div");

  div.className = "msg system";
  div.innerText = text;

  chat.appendChild(div);

  scrollChat();
}

function scrollChat() {
  const content = document.querySelector(".content");

  setTimeout(() => {
    content.scrollTop = content.scrollHeight;
  }, 50);
}

function maybeSabrina(text) {
  if (Math.random() > 0.9) {
    setTimeout(() => {
      const replies = [
        "Иногда проще говорить с незнакомцами.",
        "Тут можно быть собой.",
        "Поздней ночью люди честнее.",
        "Многие здесь тоже просто устали."
      ];

      addMessage(
        "Sabrina",
        replies[Math.floor(Math.random() * replies.length)],
        false,
        "NeoWAP Host"
      );
    }, 1200);
  }
}

function goHome() {
  if (!currentUser) {
    showScreen("loginScreen");
    return;
  }

  currentRoom = null;
  currentPrivateCode = null;

  document.getElementById("privateTools").classList.remove("active");
  document.getElementById("privateWatermark").classList.remove("active");
  document.getElementById("privateWatermark").innerText = "";

  document.getElementById("statusText").innerHTML =
    "● Поздняя волна интернета · 2007<br>Тихий чат для тех, кто помнит старую сеть.";

  loadMyPrivateRooms();
  showScreen("roomsScreen");
}

function goChat() {
  if (currentRoom) {
    showScreen("chatScreen");
  }
}

function goProfile() {
  if (!currentUser) return;

  const leftToStar = Math.max(0, 1000 - currentUser.messages);

  document.getElementById("profileText").innerHTML = `
    Ник: <b>${escapeHtml(currentUser.nick)}</b><br>
    Роль: <b>${escapeHtml(currentUser.role)}</b><br>
    Сообщений: <b>${currentUser.messages}</b><br>
    Статус: <b>${escapeHtml(currentUser.active_status)}</b><br>
    Trust: <b>${escapeHtml(currentUser.trust_level)}</b><br>
    До Star ⭐: <b>${leftToStar}</b>
  `;

  const adminPanel = document.getElementById("adminPanel");

  if (currentUser.role === "admin") {
    adminPanel.style.display = "block";
  } else {
    adminPanel.style.display = "none";
  }

  showScreen("profileScreen");
}

function logout() {
  localStorage.removeItem("neowap_nick");
  localStorage.removeItem("neowap_pass");

  currentUser = null;
  currentRoom = null;
  currentPrivateCode = null;

  if (socket) {
    socket.disconnect();
    socket = null;
  }

  location.reload();
}

function appendPrivateLog(text) {
  const log = document.getElementById("privateLog");

  if (!log) return;

  if (log.innerText === "Приватные события будут здесь.") {
    log.innerText = "";
  }

  log.innerText += text + "\n";
  log.scrollTop = log.scrollHeight;
}

function appendPrivateRoomLog(text) {
  const log = document.getElementById("privateRoomLog");

  if (!log) return;

  if (log.innerText === "События приватной комнаты будут здесь.") {
    log.innerText = "";
  }

  log.innerText += text + "\n";
  log.scrollTop = log.scrollHeight;
}

function requestPrivateMembers() {
  if (!currentPrivateCode) {
    appendPrivateRoomLog("Ты сейчас не в приватной комнате.");
    return;
  }

  if (!socket || !socket.connected) {
    appendPrivateRoomLog("Сервер не подключён.");
    return;
  }

  socket.emit("requestPrivateMembers", {
    code: currentPrivateCode,
    user: currentUser.nick
  });

  appendPrivateRoomLog("Запрашиваю список участников...");
}

function reportPrivateRoom() {
  if (!currentPrivateCode) {
    appendPrivateRoomLog("Ты сейчас не в приватной комнате.");
    return;
  }

  const target = document.getElementById("privateReportTarget").value.trim();
  const reason = document.getElementById("privateReportReason").value.trim();

  if (!target) {
    appendPrivateRoomLog("Укажи ник пользователя.");
    return;
  }

  if (!socket || !socket.connected) {
    appendPrivateRoomLog("Сервер не подключён.");
    return;
  }

  socket.emit("reportPrivateRoom", {
    code: currentPrivateCode,
    reporter: currentUser.nick,
    target: target,
    reason: reason || "без причины"
  });

  appendPrivateRoomLog("Жалоба отправляется...");
}

function leavePrivateForever() {
  if (!currentPrivateCode) {
    appendPrivateRoomLog("Ты сейчас не в приватной комнате.");
    return;
  }

  const ok = confirm("Покинуть эту приватную комнату навсегда? Она исчезнет из твоего списка.");

  if (!ok) return;

  if (!socket || !socket.connected) {
    appendPrivateRoomLog("Сервер не подключён.");
    return;
  }

  socket.emit("leavePrivateRoomForever", {
    code: currentPrivateCode,
    user: currentUser.nick
  });

  appendPrivateRoomLog("Выход из комнаты...");
}

function closePrivateRoom() {
  if (!currentPrivateCode) {
    appendPrivateRoomLog("Ты сейчас не в приватной комнате.");
    return;
  }

  const ok = confirm("Закрыть эту приватную комнату для всех? Это действие нельзя отменить.");

  if (!ok) return;

  if (!socket || !socket.connected) {
    appendPrivateRoomLog("Сервер не подключён.");
    return;
  }

  socket.emit("closePrivateRoom", {
    code: currentPrivateCode,
    user: currentUser.nick
  });

  appendPrivateRoomLog("Закрываю комнату...");
}

function getAdminTarget() {
  return document.getElementById("adminTarget").value.trim();
}

function adminEmit(command) {
  if (!currentUser || currentUser.role !== "admin") {
    appendAdminLog("Нет прав администратора.");
    return;
  }

  if (!socket) {
    connectSocket();
  }

  const room = currentRoom ? currentRoom.id : "main";

  appendAdminLog("> " + command);

  socket.emit("message", {
    room: room,
    user: currentUser.nick,
    text: command
  });
}

function adminTrust() {
  const nick = getAdminTarget();
  if (!nick) return appendAdminLog("Укажи ник.");
  adminEmit("/trust " + nick);
}

function adminWarn() {
  const nick = getAdminTarget();
  if (!nick) return appendAdminLog("Укажи ник.");
  adminEmit("/warn " + nick);
}

function adminMute() {
  const nick = getAdminTarget();
  if (!nick) return appendAdminLog("Укажи ник.");
  adminEmit("/mute " + nick + " 10m");
}

function adminBan() {
  const nick = getAdminTarget();
  if (!nick) return appendAdminLog("Укажи ник.");
  adminEmit("/ban " + nick + " 1d");
}

function adminPermBan() {
  const nick = getAdminTarget();
  if (!nick) return appendAdminLog("Укажи ник.");

  const ok = confirm("Забанить " + nick + " навсегда?");

  if (ok) {
    adminEmit("/permban " + nick);
  }
}

function adminUnban() {
  const nick = getAdminTarget();
  if (!nick) return appendAdminLog("Укажи ник.");
  adminEmit("/unban " + nick);
}

function adminSetTrust() {
  const nick = getAdminTarget();
  const value = document.getElementById("adminTrustValue").value.trim();

  if (!nick) return appendAdminLog("Укажи ник.");
  if (!value) return appendAdminLog("Укажи trust 0-100.");

  adminEmit("/settrust " + nick + " " + value);
}

function adminSetStatus() {
  const nick = getAdminTarget();
  const status = document.getElementById("adminStatusValue").value.trim();

  if (!nick) return appendAdminLog("Укажи ник.");
  if (!status) return appendAdminLog("Укажи статус.");

  adminEmit("/status " + nick + " " + status);
}

function appendAdminLog(text) {
  const log = document.getElementById("adminLog");

  if (!log) return;

  if (log.innerText === "Журнал админки пуст.") {
    log.innerText = "";
  }

  log.innerText += text + "\n";
  log.scrollTop = log.scrollHeight;
}

function togglePrivateCreateBlock(){
  const block = document.getElementById("privateCreateBlock");
  const btn = document.getElementById("privateCreateToggle");

  if(!block || !btn) return;

  const opened = block.classList.toggle("active");

  btn.innerText = opened
    ? "Скрыть управление приватками"
    : "Открыть управление приватками";
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

window.onload = async function () {
  try {
    const tg = window.Telegram?.WebApp;

    if (tg) {
      tg.expand();
      tg.ready();
    }
  } catch (e) {}

  const nick = localStorage.getItem("neowap_nick");
  const pass = localStorage.getItem("neowap_pass");

  if (nick && pass) {
    document.getElementById("nickInput").value = nick;
    document.getElementById("passInput").value = pass;

    await login();
  } else {
    showScreen("loginScreen");
  }
};
/* === NeoWAP PATCH v6: private controls, reports, reconnect === */

if (!window.__NEOWAP_PATCH_V6__) {
  window.__NEOWAP_PATCH_V6__ = true;

  function ensurePrivateToolsBlock() {
    const chatScreen = document.getElementById("chatScreen");
    if (!chatScreen) return;

    let tools = document.getElementById("privateTools");

    if (!tools) {
      tools = document.createElement("div");
      tools.id = "privateTools";
      tools.className = "card private-tools";
      chatScreen.insertBefore(tools, chatScreen.firstChild);
    }

    if (tools.dataset.neoToolsPatched === "yes") return;

    tools.innerHTML = `
      <div class="title">Закрытая комната</div>
      <div class="subtitle" id="privateRoomInfo"></div>

      <input id="privateInviteMoreNick" class="input" placeholder="пригласить ещё ник">
      <button class="btn secondary" onclick="inviteMoreToCurrentPrivate()">Пригласить ещё</button>

      <button class="btn secondary" onclick="requestPrivateMembers()">Участники</button>

      <input id="privateReportTarget" class="input" placeholder="ник для жалобы">
      <input id="privateReportReason" class="input" placeholder="причина жалобы">
      <button class="btn warn" onclick="reportPrivateRoom()">Пожаловаться</button>

      <button class="btn danger" onclick="leavePrivateForever()">Покинуть навсегда</button>
      <button class="btn danger" onclick="closePrivateRoom()">Закрыть комнату</button>

      <div class="private-log" id="privateRoomLog">События приватной комнаты будут здесь.</div>
    `;

    tools.dataset.neoToolsPatched = "yes";
  }

  function bindNeoPatchSocketEvents() {
    if (!socket || socket.__neoPatchEventsBound) return;

    socket.__neoPatchEventsBound = true;

    socket.on("adminPrivateReport", data => {
      const text = data?.text || "🚩 Новая жалоба в приватной комнате.";

      appendAdminLog(text);
      appendPrivateLog(text);
    });

    socket.on("system", text => {
      if (
        currentUser &&
        currentUser.role === "admin" &&
        typeof text === "string" &&
        (text.includes("🚩") || text.toLowerCase().includes("жалоба"))
      ) {
        appendAdminLog(text);
      }
    });

    socket.on("privateLeftForever", data => {
      if (data && data.code) {
        delete myPrivateRooms[data.code];
        renderMyPrivateRooms();
      }
    });

    socket.on("privateClosed", data => {
      if (data && data.code) {
        delete myPrivateRooms[data.code];
        renderMyPrivateRooms();
      }
    });
  }

  const __neoOldConnectSocket = connectSocket;

  window.connectSocket = connectSocket = function () {
    if (socket && !socket.connected) {
      socket.connect();
    }

    __neoOldConnectSocket();

    bindNeoPatchSocketEvents();

    setTimeout(bindNeoPatchSocketEvents, 300);
  };

  const __neoOldEnterPrivateRoom = enterPrivateRoom;

  window.enterPrivateRoom = enterPrivateRoom = async function (roomId, code) {
    ensurePrivateToolsBlock();

    await __neoOldEnterPrivateRoom(roomId, code);

    const tools = document.getElementById("privateTools");
    const info = document.getElementById("privateRoomInfo");
    const log = document.getElementById("privateRoomLog");

    if (tools) {
      tools.classList.add("active");
    }

    if (info && currentPrivateCode) {
      info.innerHTML =
        "Код комнаты: <b>" +
        escapeHtml(currentPrivateCode) +
        "</b><br>Можно пригласить ещё людей по нику.";
    }

    if (log && log.innerText.trim() === "") {
      log.innerText = "События приватной комнаты будут здесь.";
    }

    bindNeoPatchSocketEvents();
  };

  window.sendMessage = sendMessage = function () {
    const input = document.getElementById("msgInput");
    const text = input.value.trim();

    if (!text) return;

    if (!currentUser) {
      input.value = text;
      return;
    }

    if (!currentRoom) {
      input.value = text;
      appendPrivateLog("Сначала войди в комнату.");
      return;
    }

    if (!socket || !socket.connected) {
      input.value = text;
      connectSocket();

      if (document.getElementById("chatScreen").classList.contains("active")) {
        addSystem("Подключаюсь к серверу. Нажми OK ещё раз через секунду.");
      } else {
        appendPrivateLog("Подключаюсь к серверу. Повтори действие через секунду.");
      }

      return;
    }

    input.value = "";

    addMessage(
      currentUser.nick,
      text,
      true,
      currentUser.active_status
    );

    socket.emit("message", {
      room: currentRoom.id,
      user: currentUser.nick,
      text: text
    });

    maybeSabrina(text);
  };

  window.renderMyPrivateRooms = renderMyPrivateRooms = function () {
    const card = document.getElementById("myPrivateRoomsCard");
    const box = document.getElementById("myPrivateRooms");

    const roomsList = Object.values(myPrivateRooms);

    if (!roomsList.length) {
      card.style.display = "none";
      box.innerHTML = "";
      return;
    }

    card.style.display = "block";

    let html = "";

    roomsList.forEach(room => {
      const code = escapeHtml(room.code);
      const role = escapeHtml(room.role || "member");
      const creator = escapeHtml(room.created_by || "unknown");

      const actionButton = room.role === "owner"
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
  };

  window.leavePrivateFromList = function (code) {
    if (!code) return;

    const ok = confirm(
      "Покинуть приватную комнату " +
      code +
      " навсегда? Она исчезнет из твоего списка."
    );

    if (!ok) return;

    if (!socket || !socket.connected) {
      connectSocket();
      appendPrivateLog("Подключаюсь к серверу. Повтори действие через секунду.");
      return;
    }

    socket.emit("leavePrivateRoomForever", {
      code: code,
      user: currentUser.nick
    });

    appendPrivateLog("Покидаю комнату " + code + "...");

    delete myPrivateRooms[code];
    renderMyPrivateRooms();
  };

  window.closePrivateFromList = function (code) {
    if (!code) return;

    const ok = confirm(
      "Закрыть приватную комнату " +
      code +
      " для всех? Это действие нельзя отменить."
    );

    if (!ok) return;

    if (!socket || !socket.connected) {
      connectSocket();
      appendPrivateLog("Подключаюсь к серверу. Повтори действие через секунду.");
      return;
    }

    socket.emit("closePrivateRoom", {
      code: code,
      user: currentUser.nick
    });

    appendPrivateLog("Закрываю комнату " + code + "...");

    delete myPrivateRooms[code];
    renderMyPrivateRooms();
  };

  ensurePrivateToolsBlock();
}
