console.log("NeoWAP app.js v17 loaded");

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
  document.querySelectorAll(".screen").forEach((screen) => {
    screen.classList.remove("active");
  });

  const target = document.getElementById(id);
  if (target) target.classList.add("active");

  const inputBar = document.getElementById("inputBar");
  const typingLine = document.getElementById("typingLine");

  if (inputBar) {
    if (id === "chatScreen" && currentRoom) {
      inputBar.classList.add("active");
    } else {
      inputBar.classList.remove("active");
    }
  }

  if (typingLine && id !== "chatScreen") {
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
          <span>${escapeHtml(room.name)}</span>
          <span class="online">${roomsOnline[room.id] || 0} online</span>
        </div>
        <div class="room-desc">${escapeHtml(room.desc)}</div>
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
      body: JSON.stringify({
        nick,
        password
      })
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
  if (topUser) topUser.innerText = currentUser.nick;

  renderRooms();
  connectSocket();
  showScreen("roomsScreen");

  try {
    const res = await fetch(SERVER_URL + "/rooms-online");
    const data = await res.json();

    if (data.ok) {
      roomsOnline = data.rooms || {};
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
    console.log("Socket connected");

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
    if (!box) return;

    box.innerText = users && users.length
      ? "Сейчас здесь: " + users.join(", ")
      : "";
  });

  socket.on("typing", (data) => {
    if (!currentRoom || !currentUser || !data || data.user === currentUser.nick) return;

    const line = document.getElementById("typingLine");
    if (!line) return;

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
    const text = data && data.text
      ? data.text
      : "🚩 Новая жалоба в приватной комнате.";

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
  if (!currentUser) return;

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
  const chatScreen = document.getElementById("chatScreen");

  if (
    currentRoom &&
    chatScreen &&
    chatScreen.classList.contains("active")
  ) {
    addSystem(text);
    return;
  }

  appendPrivateLog(text);
  appendAdminLog(text);
}

async function loadPendingInvites() {
  if (!currentUser) return;

  try {
    const res = await fetch(
      SERVER_URL + "/private-invites/" + encodeURIComponent(currentUser.nick)
    );

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
    const res = await fetch(
      SERVER_URL + "/private-rooms/" + encodeURIComponent(currentUser.nick)
    );

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

  if (popup) {
    popup.classList.remove("active");
    popup.innerHTML = "";
  }
}

function renderPendingInvites() {
  const box = document.getElementById("pendingInvites");
  const card = document.getElementById("pendingInvitesCard");

  if (!box || !card) return;

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
  if (!popup) return;

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
  const room = rooms.find((item) => item.id === roomId);
  if (!room) return;

  currentPrivateCode = null;
  currentRoom = room;

  hidePrivateTools();

  document.getElementById("chat").innerHTML = "";
  document.getElementById("roomUsers").innerText = "";

  showScreen("chatScreen");

  document.getElementById("statusText").innerHTML =
    `● ${escapeHtml(room.name)} · ${roomsOnline[room.id] || 0} online<br>${escapeHtml(room.desc)}`;

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
    return;
  }

  if (!socket || !socket.connected) {
    input.value = text;
    connectSocket();
    addSystem("Подключаюсь к серверу. Нажми OK ещё раз через секунду.");
    return;
  }

  input.value = "";

  addMessage(
    currentUser.nick,
    text,
    true,
    currentUser.active_status || "No body 🌑"
  );

  socket.emit("message", {
    room: currentRoom.id,
    user: currentUser.nick,
    text: text
  });
}

function addMessage(user, text, me, status) {
  const chat = document.getElementById("chat");
  if (!chat) return;

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
  if (!chat) return;

  const div = document.createElement("div");
  div.className = "msg system";
  div.innerText = text;

  chat.appendChild(div);
  scrollChat();
}

function scrollChat() {
  const content = document.querySelector(".content");

  if (!content) return;

  setTimeout(() => {
    content.scrollTop = content.scrollHeight;
  }, 50);
}

function goHome() {
  if (!currentUser) {
    showScreen("loginScreen");
    return;
  }

  currentRoom = null;
  currentPrivateCode = null;

  hidePrivateTools();

  document.getElementById("statusText").innerHTML =
    "● Поздняя волна интернета · 2007<br>Тихий чат для тех, кто помнит старую сеть.";

  loadMyPrivateRooms();
  showScreen("roomsScreen");
}

function goChat() {
  if (currentRoom) {
    showScreen("chatScreen");

    if (currentPrivateCode) {
      document.getElementById("privateTools").classList.add("active");
    }
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
    ensureAdminReportsPanel();
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

function hidePrivateTools() {
  const tools = document.getElementById("privateTools");
  const watermark = document.getElementById("privateWatermark");

  if (tools) tools.classList.remove("active");

  if (watermark) {
    watermark.classList.remove("active");
    watermark.innerText = "";
  }
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
    connectSocket();
    appendPrivateRoomLog("Сервер подключается. Повтори действие через секунду.");
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

  const ok = confirm(
    "Sabrina Moderator проверит ограниченный контекст этой приватной комнаты вокруг жалобы.\n\n" +
    "Жалоба не является автоматическим наказанием.\n\n" +
    "Если нарушение подтвердится, пользователь может получить мут и снижение trust.\n\n" +
    "Отправить жалобу?"
  );

  if (!ok) return;

  if (!socket || !socket.connected) {
    connectSocket();
    appendPrivateRoomLog("Сервер подключается. Повтори действие через секунду.");
    return;
  }

  socket.emit("reportPrivateRoom", {
    code: currentPrivateCode,
    reporter: currentUser.nick,
    target: target,
    reason: reason || "без причины"
  });

  appendPrivateRoomLog("Жалоба отправляется на проверку Sabrina Moderator...");
}

function leavePrivateForever() {
  if (!currentPrivateCode) {
    appendPrivateRoomLog("Ты сейчас не в приватной комнате.");
    return;
  }

  const ok = confirm("Покинуть эту приватную комнату навсегда? Она исчезнет из твоего списка.");

  if (!ok) return;

  if (!socket || !socket.connected) {
    connectSocket();
    appendPrivateRoomLog("Сервер подключается. Повтори действие через секунду.");
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
    connectSocket();
    appendPrivateRoomLog("Сервер подключается. Повтори действие через секунду.");
    return;
  }

  socket.emit("closePrivateRoom", {
    code: currentPrivateCode,
    user: currentUser.nick
  });

  appendPrivateRoomLog("Закрываю комнату...");
}

function leavePrivateFromList(code) {
  if (!code) return;

  const ok = confirm("Покинуть приватную комнату " + code + " навсегда? Она исчезнет из твоего списка.");

  if (!ok) return;

  if (!socket || !socket.connected) {
    connectSocket();
    appendPrivateLog("Сервер подключается. Повтори действие через секунду.");
    return;
  }

  socket.emit("leavePrivateRoomForever", {
    code: code,
    user: currentUser.nick
  });

  appendPrivateLog("Покидаю комнату " + code + "...");

  delete myPrivateRooms[code];
  renderMyPrivateRooms();
}

function closePrivateFromList(code) {
  if (!code) return;

  const ok = confirm("Закрыть приватную комнату " + code + " для всех? Это действие нельзя отменить.");

  if (!ok) return;

  if (!socket || !socket.connected) {
    connectSocket();
    appendPrivateLog("Сервер подключается. Повтори действие через секунду.");
    return;
  }

  socket.emit("closePrivateRoom", {
    code: code,
    user: currentUser.nick
  });

  appendPrivateLog("Закрываю комнату " + code + "...");

  delete myPrivateRooms[code];
  renderMyPrivateRooms();
}

function getAdminTarget() {
  return document.getElementById("adminTarget").value.trim();
}

function adminEmit(command) {
  if (!currentUser || currentUser.role !== "admin") {
    appendAdminLog("Нет прав администратора.");
    return;
  }

  if (!socket || !socket.connected) {
    connectSocket();
    appendAdminLog("Сервер подключается. Повтори действие через секунду.");
    return;
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
  if (ok) adminEmit("/permban " + nick);
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

function ensureAdminReportsPanel() {
  const adminPanel = document.getElementById("adminPanel");

  if (!adminPanel || document.getElementById("adminReportsBox")) return;

  const box = document.createElement("div");
  box.id = "adminReportsBox";
  box.className = "admin-reports-box";

  box.innerHTML = `
    <button class="btn secondary" onclick="loadAdminReports()">
      Жалобы
    </button>

    <div class="admin-log" id="adminReportsList">
      Список жалоб пуст.
    </div>

    <div class="admin-log" id="adminReportDetail">
      Открой жалобу, чтобы увидеть контекст.
    </div>
  `;

  adminPanel.appendChild(box);
}

async function loadAdminReports() {
  ensureAdminReportsPanel();

  const list = document.getElementById("adminReportsList");

  if (!currentUser || currentUser.role !== "admin") {
    list.innerText = "Нет прав администратора.";
    return;
  }

  list.innerText = "Загружаю жалобы...";

  try {
    const res = await fetch(
      SERVER_URL + "/admin/reports?admin=" + encodeURIComponent(currentUser.nick)
    );

    const data = await res.json();

    if (!data.ok) {
      list.innerText = data.error || "Ошибка загрузки жалоб.";
      return;
    }

    if (!data.reports.length) {
      list.innerText = "Жалоб пока нет.";
      return;
    }

    let html = "";

    data.reports.forEach((r) => {
      const status = escapeHtml(r.status || "pending");

      html += `
        <div class="admin-report-row">
          <div>
            <b>#${r.id}</b> ${escapeHtml(r.reporter_nick)} → ${escapeHtml(r.target_nick)}<br>
            <span>${escapeHtml(r.reason || "без причины")}</span><br>
            <small>Комната: ${escapeHtml(r.code)} · статус: ${status}</small>
          </div>

          <button class="btn secondary" onclick="loadAdminReportDetail(${r.id})">
            Открыть
          </button>
        </div>
      `;
    });

    list.innerHTML = html;

  } catch (e) {
    list.innerText = "Ошибка соединения с сервером.";
  }
}

async function loadAdminReportDetail(id) {
  const detail = document.getElementById("adminReportDetail");

  detail.innerText = "Загружаю жалобу #" + id + "...";

  try {
    const res = await fetch(
      SERVER_URL + "/admin/reports/" + id + "?admin=" + encodeURIComponent(currentUser.nick)
    );

    const data = await res.json();

    if (!data.ok) {
      detail.innerText = data.error || "Ошибка загрузки жалобы.";
      return;
    }

    const r = data.report;
    const context = data.context || [];

    const contextHtml = context.length
      ? context.map((m) => {
          const time = m.created_at
            ? new Date(m.created_at).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit"
              })
            : "--:--";

          return `
            <div class="report-message">
              <b>[${time}] ${escapeHtml(m.user_nick)}:</b>
              ${escapeHtml(m.text)}
            </div>
          `;
        }).join("")
      : `<div class="report-message">Контекст пуст.</div>`;

    detail.innerHTML = `
      <div class="admin-report-detail-card">
        <div class="title">Жалоба #${r.id}</div>

        <div class="subtitle">
          Комната: <b>${escapeHtml(r.code)}</b><br>
          Кто пожаловался: <b>${escapeHtml(r.reporter_nick)}</b><br>
          На кого: <b>${escapeHtml(r.target_nick)}</b><br>
          Причина: <b>${escapeHtml(r.reason || "без причины")}</b><br>
          Статус: <b>${escapeHtml(r.status || "pending")}</b>
        </div>

        <div class="rules-small">
          Контекст последних 20 сообщений:
        </div>

        <div class="report-context">
          ${contextHtml}
        </div>

        <button class="btn secondary" onclick="adminReportAction(${r.id}, 'no_violation')">
          Нет нарушения
        </button>

        <button class="btn secondary" onclick="adminReportAction(${r.id}, 'warn')">
          Warn / trust -5
        </button>

        <button class="btn warn" onclick="adminReportAction(${r.id}, 'mute_1h')">
          Mute 1h / trust -10
        </button>

        <button class="btn warn" onclick="adminReportAction(${r.id}, 'mute_10h')">
          Mute 10h / trust -25
        </button>

        <button class="btn danger" onclick="adminReportAction(${r.id}, 'ban_1d')">
          Ban 1d / trust -35
        </button>
      </div>
    `;

  } catch (e) {
    detail.innerText = "Ошибка соединения с сервером.";
  }
}

async function adminReportAction(id, action) {
  const ok = confirm("Применить действие к жалобе #" + id + "?");

  if (!ok) return;

  const detail = document.getElementById("adminReportDetail");

  try {
    const res = await fetch(SERVER_URL + "/admin/reports/" + id + "/action", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        adminNick: currentUser.nick,
        action: action
      })
    });

    const data = await res.json();

    if (!data.ok) {
      appendAdminLog(data.error || "Ошибка действия.");
      return;
    }

    appendAdminLog("Жалоба #" + id + ": " + data.message);

    detail.innerHTML += `
      <div class="rules-small">
        ✅ ${escapeHtml(data.message)}
      </div>
    `;

    await loadAdminReports();

  } catch (e) {
    appendAdminLog("Ошибка соединения с сервером.");
  }
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

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

window.onload = async function () {
  try {
    const tg = window.Telegram && window.Telegram.WebApp;

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

/* === NeoWAP v18: notifications + report status refresh === */

if (!window.__NEOWAP_NOTIFICATIONS_V18__) {
  window.__NEOWAP_NOTIFICATIONS_V18__ = true;

  function ensureNotificationBox() {
    let box = document.getElementById("neoNotificationBox");

    if (box) return box;

    box = document.createElement("div");
    box.id = "neoNotificationBox";
    box.className = "neo-notification-box";

    document.body.appendChild(box);

    return box;
  }

  async function loadMyNotifications() {
    if (!currentUser) return;

    try {
      const res = await fetch(
        SERVER_URL + "/notifications/" + encodeURIComponent(currentUser.nick)
      );

      const data = await res.json();

      if (!data.ok || !Array.isArray(data.notifications)) return;

      data.notifications.forEach((n) => {
        showNeoNotification(n);
      });

    } catch (e) {}
  }

  function showNeoNotification(notification) {
    const box = ensureNotificationBox();

    const div = document.createElement("div");
    div.className = "neo-notification";

    div.innerHTML = `
      <div class="neo-notification-title">
        ${escapeHtml(notification.title || "NeoWAP")}
      </div>

      <div class="neo-notification-body">
        ${escapeHtml(notification.body || "")}
      </div>

      <button class="btn secondary" onclick="markNotificationRead(${notification.id}, this)">
        OK
      </button>
    `;

    box.appendChild(div);
  }

  window.markNotificationRead = async function (id, button) {
    try {
      await fetch(SERVER_URL + "/notifications/" + id + "/read", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          nick: currentUser.nick
        })
      });
    } catch (e) {}

    const card = button.closest(".neo-notification");

    if (card) {
      card.remove();
    }
  };

  const oldAfterLoginV18 = afterLogin;

  window.afterLogin = afterLogin = async function () {
    await oldAfterLoginV18();

    await loadMyNotifications();

    if (!window.__NEOWAP_NOTIFICATION_TIMER__) {
      window.__NEOWAP_NOTIFICATION_TIMER__ = setInterval(() => {
        loadMyNotifications();
      }, 30000);
    }
  };

  const oldAdminReportActionV18 = adminReportAction;

  window.adminReportAction = adminReportAction = async function (id, action) {
    const ok = confirm("Применить действие к жалобе #" + id + "?");

    if (!ok) return;

    const detail = document.getElementById("adminReportDetail");

    try {
      const res = await fetch(SERVER_URL + "/admin/reports/" + id + "/action", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          adminNick: currentUser.nick,
          action: action
        })
      });

      const data = await res.json();

      if (!data.ok) {
        appendAdminLog(data.error || "Ошибка действия.");
        return;
      }

      appendAdminLog("Жалоба #" + id + ": " + data.message);

      await loadAdminReports();
      await loadAdminReportDetail(id);

      if (detail) {
        detail.innerHTML += `
          <div class="rules-small">
            ✅ ${escapeHtml(data.message)}
          </div>
        `;
      }

    } catch (e) {
      appendAdminLog("Ошибка соединения с сервером.");
    }
  };
}

/* === NeoWAP v19: Sabrina Memory UI === */

if (!window.__NEOWAP_SABRINA_MEMORY_V19__) {
  window.__NEOWAP_SABRINA_MEMORY_V19__ = true;

  let sabrinaProfileCache = null;

  function ensureSabrinaPanel() {
    const profileScreen = document.getElementById("profileScreen");

    if (!profileScreen || document.getElementById("sabrinaPanel")) return;

    const panel = document.createElement("div");
    panel.id = "sabrinaPanel";
    panel.className = "card sabrina-panel";

    panel.innerHTML = `
      <div class="title">Sabrina Memory</div>

      <div class="subtitle" id="sabrinaGreeting">
        Sabrina пока загружается...
      </div>

      <div class="sabrina-settings">
        <label class="sabrina-check">
          <input type="checkbox" id="sabrinaRemember">
          <span>Помнить мои предпочтения</span>
        </label>

        <label class="sabrina-check">
          <input type="checkbox" id="sabrinaHints">
          <span>Мягкие подсказки</span>
        </label>

        <label class="sabrina-check">
          <input type="checkbox" id="sabrinaMatch">
          <span>Предлагать мне людей для общения</span>
        </label>

        <label class="sabrina-check">
          <input type="checkbox" id="sabrinaSuggestMe">
          <span>Можно предлагать меня другим</span>
        </label>

        <label class="sabrina-check">
          <input type="checkbox" id="sabrinaQuiet">
          <span>Тихий режим Sabrina</span>
        </label>
      </div>

      <button class="btn secondary" onclick="saveSabrinaSettings()">
        Сохранить настройки Sabrina
      </button>

      <button class="btn secondary" onclick="loadSabrinaMatches()">
        Найти похожих людей
      </button>

      <div class="private-log" id="sabrinaLog">
        Sabrina будет мягко запоминать твой ритм в NeoWAP.
      </div>
    `;

    const adminPanel = document.getElementById("adminPanel");

    if (adminPanel) {
      profileScreen.insertBefore(panel, adminPanel);
    } else {
      profileScreen.appendChild(panel);
    }
  }

  async function loadSabrinaProfile() {
    if (!currentUser) return;

    ensureSabrinaPanel();

    try {
      const res = await fetch(
        SERVER_URL + "/sabrina/profile/" + encodeURIComponent(currentUser.nick)
      );

      const data = await res.json();

      if (!data.ok) {
        appendSabrinaLog(data.error || "Sabrina не смогла загрузить профиль.");
        return;
      }

      sabrinaProfileCache = data.profile;

      renderSabrinaProfile(data.profile);

    } catch (e) {
      appendSabrinaLog("Sabrina пока не отвечает.");
    }
  }

  function renderSabrinaProfile(profile) {
    if (!profile) return;

    const greeting = document.getElementById("sabrinaGreeting");

    if (greeting) {
      greeting.innerHTML = `
        ${escapeHtml(profile.greeting || "Sabrina рядом.")}<br><br>
        Любимая комната: <b>${escapeHtml(profile.favorite_room || "ещё не выбрана")}</b><br>
        Последняя комната: <b>${escapeHtml(profile.last_room || "ещё нет")}</b><br>
        Заходов в комнаты: <b>${Number(profile.visits_count || 0)}</b>
      `;
    }

    setChecked("sabrinaRemember", profile.remember_enabled);
    setChecked("sabrinaHints", profile.hints_enabled);
    setChecked("sabrinaMatch", profile.match_enabled);
    setChecked("sabrinaSuggestMe", profile.can_be_suggested);
    setChecked("sabrinaQuiet", profile.quiet_mode);
  }

  function setChecked(id, value) {
    const el = document.getElementById(id);
    if (el) el.checked = Boolean(value);
  }

  function getChecked(id) {
    const el = document.getElementById(id);
    return el ? Boolean(el.checked) : false;
  }

  function appendSabrinaLog(text) {
    const log = document.getElementById("sabrinaLog");

    if (!log) return;

    if (log.innerText === "Sabrina будет мягко запоминать твой ритм в NeoWAP.") {
      log.innerText = "";
    }

    log.innerText += text + "\n";
    log.scrollTop = log.scrollHeight;
  }

  window.saveSabrinaSettings = async function () {
    if (!currentUser) return;

    try {
      const res = await fetch(
        SERVER_URL + "/sabrina/profile/" + encodeURIComponent(currentUser.nick) + "/settings",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            remember_enabled: getChecked("sabrinaRemember"),
            hints_enabled: getChecked("sabrinaHints"),
            match_enabled: getChecked("sabrinaMatch"),
            can_be_suggested: getChecked("sabrinaSuggestMe"),
            quiet_mode: getChecked("sabrinaQuiet")
          })
        }
      );

      const data = await res.json();

      if (!data.ok) {
        appendSabrinaLog(data.error || "Не удалось сохранить настройки.");
        return;
      }

      sabrinaProfileCache = data.profile;
      renderSabrinaProfile(data.profile);

      appendSabrinaLog("Sabrina: настройки сохранены.");

    } catch (e) {
      appendSabrinaLog("Sabrina: ошибка соединения при сохранении.");
    }
  };

  async function trackSabrinaRoom(room) {
    if (!currentUser || !room) return;

    try {
      const res = await fetch(SERVER_URL + "/sabrina/track-room", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          nick: currentUser.nick,
          room: room
        })
      });

      const data = await res.json();

      if (data.ok && data.profile) {
        sabrinaProfileCache = data.profile;
      }

    } catch (e) {}
  }

  window.loadSabrinaMatches = async function () {
    if (!currentUser) return;

    ensureSabrinaPanel();

    try {
      const res = await fetch(
        SERVER_URL + "/sabrina/matches/" + encodeURIComponent(currentUser.nick)
      );

      const data = await res.json();

      if (!data.ok) {
        appendSabrinaLog(data.error || "Sabrina не смогла подобрать людей.");
        return;
      }

      if (!data.matches || !data.matches.length) {
        appendSabrinaLog(data.message || "Sabrina пока не нашла похожих людей.");
        return;
      }

      appendSabrinaLog("Sabrina нашла похожих людей:");

      data.matches.forEach((m) => {
        appendSabrinaLog(
          "— " +
          m.nick +
          " · " +
          (m.reason || "похожий ритм") +
          (m.favorite_room ? " · любимая комната: " + m.favorite_room : "")
        );
      });

    } catch (e) {
      appendSabrinaLog("Sabrina: ошибка поиска похожих людей.");
    }
  };

  const oldAfterLoginSabrina = afterLogin;

  window.afterLogin = afterLogin = async function () {
    await oldAfterLoginSabrina();
    await loadSabrinaProfile();
  };

  const oldGoProfileSabrina = goProfile;

  window.goProfile = goProfile = function () {
    oldGoProfileSabrina();
    ensureSabrinaPanel();
    loadSabrinaProfile();
  };

  const oldEnterRoomSabrina = enterRoom;

  window.enterRoom = enterRoom = async function (roomId) {
    await oldEnterRoomSabrina(roomId);
    await trackSabrinaRoom(roomId);

    if (
      sabrinaProfileCache &&
      sabrinaProfileCache.hints_enabled &&
      !sabrinaProfileCache.quiet_mode
    ) {
      if (roomId === sabrinaProfileCache.favorite_room) {
        setTimeout(() => {
          addMessage(
            "Sabrina",
            "Похоже, эта комната тебе уже знакома. Я запомнила твой ритм.",
            false,
            "NeoWAP Memory"
          );
        }, 900);
      }
    }
  };

  const oldEnterPrivateRoomSabrina = enterPrivateRoom;

  window.enterPrivateRoom = enterPrivateRoom = async function (roomId, code) {
    await oldEnterPrivateRoomSabrina(roomId, code);
    await trackSabrinaRoom("private");
  };

  window.loadSabrinaProfile = loadSabrinaProfile;
}

/* === NeoWAP v20: instant messages + pending queue === */

if (!window.__NEOWAP_INSTANT_MESSAGES_V20__) {
  window.__NEOWAP_INSTANT_MESSAGES_V20__ = true;

  const pendingOutgoingMessages = [];

  function flushPendingOutgoingMessages() {
    if (!socket || !socket.connected || !currentUser) return;

    while (pendingOutgoingMessages.length > 0) {
      const item = pendingOutgoingMessages.shift();

      socket.emit("message", {
        room: item.roomId,
        user: currentUser.nick,
        text: item.text
      });
    }
  }

  const oldConnectSocketV20 = connectSocket;

  window.connectSocket = connectSocket = function () {
    oldConnectSocketV20();

    if (socket && !socket.__neoPendingQueueBound) {
      socket.__neoPendingQueueBound = true;

      socket.on("connect", () => {
        flushPendingOutgoingMessages();
      });
    }

    flushPendingOutgoingMessages();
  };

  window.sendMessage = sendMessage = function () {
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
      return;
    }

    input.value = "";

    addMessage(
      currentUser.nick,
      text,
      true,
      currentUser.active_status || "No body 🌑"
    );

    if (socket && socket.connected) {
      socket.emit("message", {
        room: currentRoom.id,
        user: currentUser.nick,
        text: text
      });

      return;
    }

    pendingOutgoingMessages.push({
      roomId: currentRoom.id,
      text: text
    });

    connectSocket();

    addSystem("Сообщение показано у тебя. Отправлю на сервер, когда связь восстановится.");
  };
}

/* === NeoWAP v21: mobile keyboard composition fix === */

if (!window.__NEOWAP_MOBILE_INPUT_FIX_V21__) {
  window.__NEOWAP_MOBILE_INPUT_FIX_V21__ = true;

  let neoInputComposing = false;

  function bindMobileInputFix() {
    const input = document.getElementById("msgInput");

    if (!input || input.__neoCompositionBound) return;

    input.__neoCompositionBound = true;

    input.addEventListener("compositionstart", () => {
      neoInputComposing = true;
    });

    input.addEventListener("compositionend", () => {
      neoInputComposing = false;
    });
  }

  const oldSendMessageV21 = sendMessage;

  window.sendMessage = sendMessage = function () {
    bindMobileInputFix();

    const delay = neoInputComposing ? 140 : 45;

    setTimeout(() => {
      oldSendMessageV21();
    }, delay);
  };

  document.addEventListener("DOMContentLoaded", bindMobileInputFix);
  setTimeout(bindMobileInputFix, 500);
}
