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

/* === NeoWAP v22: compact UI for private tools, Sabrina Memory and admin reports === */

if (!window.__NEOWAP_COMPACT_UI_V22__) {
  window.__NEOWAP_COMPACT_UI_V22__ = true;

  function moveNodesToBody(parent, startAfterNode, body) {
    const nodes = [];
    let take = false;

    Array.from(parent.childNodes).forEach((node) => {
      if (take) {
        nodes.push(node);
      }

      if (node === startAfterNode) {
        take = true;
      }
    });

    nodes.forEach((node) => {
      body.appendChild(node);
    });
  }

  function compactPrivateTools() {
    const tools = document.getElementById("privateTools");
    const info = document.getElementById("privateRoomInfo");

    if (!tools || !info || tools.__neoCompactPrivateTools) return;

    tools.__neoCompactPrivateTools = true;
    tools.classList.add("private-tools-compact");

    const toggle = document.createElement("button");
    toggle.className = "btn secondary compact-toggle";
    toggle.id = "privateToolsToggle";
    toggle.type = "button";
    toggle.innerText = "Открыть управление комнатой";

    info.insertAdjacentElement("afterend", toggle);

    const body = document.createElement("div");
    body.id = "privateToolsBody";
    body.className = "compact-body";

    toggle.insertAdjacentElement("afterend", body);

    moveNodesToBody(tools, toggle, body);

    toggle.onclick = function () {
      const opened = body.classList.toggle("open");

      toggle.innerText = opened
        ? "Скрыть управление комнатой"
        : "Открыть управление комнатой";
    };
  }

  function closePrivateToolsBody() {
    const body = document.getElementById("privateToolsBody");
    const toggle = document.getElementById("privateToolsToggle");

    if (body) body.classList.remove("open");

    if (toggle) {
      toggle.innerText = "Открыть управление комнатой";
    }
  }

  function compactSabrinaPanel() {
    const panel = document.getElementById("sabrinaPanel");
    const greeting = document.getElementById("sabrinaGreeting");

    if (!panel || !greeting || panel.__neoCompactSabrina) return;

    panel.__neoCompactSabrina = true;
    panel.classList.add("sabrina-panel-compact");

    const toggle = document.createElement("button");
    toggle.className = "btn secondary compact-toggle";
    toggle.id = "sabrinaPanelToggle";
    toggle.type = "button";
    toggle.innerText = "Открыть Sabrina Memory";

    greeting.insertAdjacentElement("afterend", toggle);

    const body = document.createElement("div");
    body.id = "sabrinaPanelBody";
    body.className = "compact-body";

    toggle.insertAdjacentElement("afterend", body);

    moveNodesToBody(panel, toggle, body);

    toggle.onclick = function () {
      const opened = body.classList.toggle("open");

      toggle.innerText = opened
        ? "Скрыть Sabrina Memory"
        : "Открыть Sabrina Memory";
    };
  }

  function ensureAdminReportsPanelV22() {
    if (typeof ensureAdminReportsPanel === "function") {
      ensureAdminReportsPanel();
    }

    const box = document.getElementById("adminReportsBox");

    if (!box || box.__neoReportsV22) return;

    box.__neoReportsV22 = true;
    box.classList.add("admin-reports-box-v22");

    box.innerHTML = `
      <button class="btn secondary" onclick="toggleAdminReportsPanel()">
        Жалобы
      </button>

      <div class="admin-reports-window" id="adminReportsWindow">
        <div class="admin-reports-window-head">
          <div>
            <div class="title">Жалобы</div>
            <div class="subtitle">Активные жалобы и быстрые решения.</div>
          </div>

          <button class="btn secondary small-btn" onclick="toggleAdminReportsPanel(false)">
            Закрыть
          </button>
        </div>

        <div class="admin-reports-window-grid">
          <div class="admin-reports-list" id="adminReportsList">
            Нажми обновить, чтобы загрузить жалобы.
          </div>

          <div class="admin-report-detail" id="adminReportDetail">
            Открой жалобу, чтобы увидеть контекст.
          </div>
        </div>

        <button class="btn secondary" onclick="loadAdminReports()">
          Обновить список
        </button>
      </div>
    `;
  }

  window.toggleAdminReportsPanel = async function (forceState) {
    ensureAdminReportsPanelV22();

    const win = document.getElementById("adminReportsWindow");

    if (!win) return;

    let opened;

    if (typeof forceState === "boolean") {
      opened = forceState;
      win.classList.toggle("open", opened);
    } else {
      opened = win.classList.toggle("open");
    }

    if (opened) {
      await loadAdminReports();
    }
  };

  window.loadAdminReports = async function () {
    ensureAdminReportsPanelV22();

    const list = document.getElementById("adminReportsList");
    const detail = document.getElementById("adminReportDetail");

    if (!list) return;

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

      const activeReports = (data.reports || []).filter((r) => {
        const status = String(r.status || "pending");

        if (r.review_required === false) return false;
        if (status.startsWith("closed_")) return false;
        if (status.startsWith("action_")) return false;
        if (status === "reviewed") return false;

        return true;
      });

      if (!activeReports.length) {
        list.innerHTML = `
          <div class="empty-state">
            Активных жалоб нет.
          </div>
        `;

        if (detail) {
          detail.innerHTML = `
            <div class="empty-state">
              Обработанные жалобы убраны из активного списка.
            </div>
          `;
        }

        return;
      }

      let html = "";

      activeReports.forEach((r) => {
        html += `
          <div class="admin-report-card">
            <div class="admin-report-card-title">
              Жалоба #${r.id}
            </div>

            <div class="admin-report-card-text">
              ${escapeHtml(r.reporter_nick)} пожаловался на ${escapeHtml(r.target_nick)}
            </div>

            <div class="admin-report-card-meta">
              Комната: ${escapeHtml(r.code)}<br>
              Причина: ${escapeHtml(r.reason || "без причины")}<br>
              Статус: ${escapeHtml(r.status || "pending")}
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
  };

  window.loadAdminReportDetail = async function (id) {
    ensureAdminReportsPanelV22();

    const detail = document.getElementById("adminReportDetail");

    if (!detail) return;

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

          <div class="report-context report-context-large">
            ${contextHtml}
          </div>

          <div class="report-actions">
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
        </div>
      `;

    } catch (e) {
      detail.innerText = "Ошибка соединения с сервером.";
    }
  };

  window.adminReportAction = async function (id, action) {
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

      if (detail) {
        detail.innerHTML = `
          <div class="empty-state">
            ✅ ${escapeHtml(data.message)}<br><br>
            Жалоба обработана и убрана из активного списка.
          </div>
        `;
      }

      await loadAdminReports();

    } catch (e) {
      appendAdminLog("Ошибка соединения с сервером.");
    }
  };

  const oldEnterPrivateRoomV22 = enterPrivateRoom;

  window.enterPrivateRoom = enterPrivateRoom = async function (roomId, code) {
    await oldEnterPrivateRoomV22(roomId, code);
    compactPrivateTools();
    closePrivateToolsBody();
  };

  const oldGoChatV22 = goChat;

  window.goChat = goChat = function () {
    oldGoChatV22();
    compactPrivateTools();
  };

  const oldGoProfileV22 = goProfile;

  window.goProfile = goProfile = function () {
    oldGoProfileV22();

    setTimeout(() => {
      compactSabrinaPanel();
      ensureAdminReportsPanelV22();
    }, 100);
  };

  const oldLoadSabrinaProfileV22 = window.loadSabrinaProfile;

  if (typeof oldLoadSabrinaProfileV22 === "function") {
    window.loadSabrinaProfile = async function () {
      await oldLoadSabrinaProfileV22();

      setTimeout(() => {
        compactSabrinaPanel();
      }, 100);
    };
  }

  document.addEventListener("DOMContentLoaded", () => {
    setTimeout(() => {
      compactPrivateTools();
      compactSabrinaPanel();
      ensureAdminReportsPanelV22();
    }, 500);
  });
}

/* === NeoWAP v23: fix compact buttons === */

if (!window.__NEOWAP_COMPACT_UI_FIX_V23__) {
  window.__NEOWAP_COMPACT_UI_FIX_V23__ = true;

  function neoMoveBodyChildrenBack(oldBody) {
    if (!oldBody || !oldBody.parentNode) return;

    while (oldBody.firstChild) {
      oldBody.parentNode.insertBefore(oldBody.firstChild, oldBody);
    }

    oldBody.remove();
  }

  function fixPrivateToolsCompactV23() {
    try {
      const tools = document.getElementById("privateTools");
      const info = document.getElementById("privateRoomInfo");

      if (!tools || !info) return;

      const oldToggle = document.getElementById("privateToolsToggle");
      const oldBody = document.getElementById("privateToolsBody");

      neoMoveBodyChildrenBack(oldBody);

      if (oldToggle) {
        oldToggle.remove();
      }

      const toggle = document.createElement("button");
      toggle.className = "btn secondary compact-toggle";
      toggle.id = "privateToolsToggle";
      toggle.type = "button";
      toggle.innerText = "Открыть управление комнатой";

      const body = document.createElement("div");
      body.id = "privateToolsBody";
      body.className = "compact-body";

      info.insertAdjacentElement("afterend", toggle);
      toggle.insertAdjacentElement("afterend", body);

      const children = Array.from(tools.children);

      children.forEach((child) => {
        if (child.classList.contains("title")) return;
        if (child.id === "privateRoomInfo") return;
        if (child.id === "privateToolsToggle") return;
        if (child.id === "privateToolsBody") return;

        body.appendChild(child);
      });

      toggle.onclick = function () {
        const opened = body.classList.toggle("open");

        toggle.innerText = opened
          ? "Скрыть управление комнатой"
          : "Открыть управление комнатой";
      };

      body.classList.remove("open");
      tools.classList.add("private-tools-compact");

    } catch (e) {
      console.error("PRIVATE COMPACT FIX ERROR:", e);
    }
  }

  function fixSabrinaPanelCompactV23() {
    try {
      const panel = document.getElementById("sabrinaPanel");
      const greeting = document.getElementById("sabrinaGreeting");

      if (!panel || !greeting) return;

      const oldToggle = document.getElementById("sabrinaPanelToggle");
      const oldBody = document.getElementById("sabrinaPanelBody");

      neoMoveBodyChildrenBack(oldBody);

      if (oldToggle) {
        oldToggle.remove();
      }

      const toggle = document.createElement("button");
      toggle.className = "btn secondary compact-toggle";
      toggle.id = "sabrinaPanelToggle";
      toggle.type = "button";
      toggle.innerText = "Открыть Sabrina Memory";

      const body = document.createElement("div");
      body.id = "sabrinaPanelBody";
      body.className = "compact-body";

      greeting.insertAdjacentElement("afterend", toggle);
      toggle.insertAdjacentElement("afterend", body);

      const children = Array.from(panel.children);

      children.forEach((child) => {
        if (child.classList.contains("title")) return;
        if (child.id === "sabrinaGreeting") return;
        if (child.id === "sabrinaPanelToggle") return;
        if (child.id === "sabrinaPanelBody") return;

        body.appendChild(child);
      });

      toggle.onclick = function () {
        const opened = body.classList.toggle("open");

        toggle.innerText = opened
          ? "Скрыть Sabrina Memory"
          : "Открыть Sabrina Memory";
      };

      body.classList.remove("open");
      panel.classList.add("sabrina-panel-compact");

    } catch (e) {
      console.error("SABRINA COMPACT FIX ERROR:", e);
    }
  }

  function fixAdminReportsPanelV23() {
    try {
      const adminPanel = document.getElementById("adminPanel");

      if (!adminPanel) return;

      let box = document.getElementById("adminReportsBox");

      if (!box) {
        box = document.createElement("div");
        box.id = "adminReportsBox";
        box.className = "admin-reports-box admin-reports-box-v22";
        adminPanel.appendChild(box);
      }

      box.innerHTML = `
        <button class="btn secondary" id="adminReportsToggleBtn" type="button">
          Жалобы
        </button>

        <div class="admin-reports-window" id="adminReportsWindow">
          <div class="admin-reports-window-head">
            <div>
              <div class="title">Жалобы</div>
              <div class="subtitle">Активные жалобы и быстрые решения.</div>
            </div>

            <button class="btn secondary small-btn" id="adminReportsCloseBtn" type="button">
              Закрыть
            </button>
          </div>

          <div class="admin-reports-window-grid">
            <div class="admin-reports-list" id="adminReportsList">
              Нажми обновить, чтобы загрузить жалобы.
            </div>

            <div class="admin-report-detail" id="adminReportDetail">
              Открой жалобу, чтобы увидеть контекст.
            </div>
          </div>

          <button class="btn secondary" id="adminReportsRefreshBtn" type="button">
            Обновить список
          </button>
        </div>
      `;

      const openBtn = document.getElementById("adminReportsToggleBtn");
      const closeBtn = document.getElementById("adminReportsCloseBtn");
      const refreshBtn = document.getElementById("adminReportsRefreshBtn");

      if (openBtn) {
        openBtn.onclick = function () {
          toggleAdminReportsPanel(true);
        };
      }

      if (closeBtn) {
        closeBtn.onclick = function () {
          toggleAdminReportsPanel(false);
        };
      }

      if (refreshBtn) {
        refreshBtn.onclick = function () {
          loadAdminReports();
        };
      }

    } catch (e) {
      console.error("ADMIN REPORTS FIX ERROR:", e);
    }
  }

  window.toggleAdminReportsPanel = async function (forceState) {
    const win = document.getElementById("adminReportsWindow");

    if (!win) return;

    let opened;

    if (typeof forceState === "boolean") {
      opened = forceState;
      win.classList.toggle("open", opened);
    } else {
      opened = win.classList.toggle("open");
    }

    if (opened && typeof loadAdminReports === "function") {
      await loadAdminReports();
    }
  };

  const oldEnterPrivateRoomV23 = enterPrivateRoom;

  window.enterPrivateRoom = enterPrivateRoom = async function (roomId, code) {
    await oldEnterPrivateRoomV23(roomId, code);

    setTimeout(() => {
      fixPrivateToolsCompactV23();
    }, 100);
  };

  const oldGoProfileV23 = goProfile;

  window.goProfile = goProfile = function () {
    oldGoProfileV23();

    setTimeout(() => {
      fixSabrinaPanelCompactV23();
      fixAdminReportsPanelV23();
    }, 200);
  };

  const oldLoadSabrinaProfileV23 = window.loadSabrinaProfile;

  if (typeof oldLoadSabrinaProfileV23 === "function") {
    window.loadSabrinaProfile = async function () {
      await oldLoadSabrinaProfileV23();

      setTimeout(() => {
        fixSabrinaPanelCompactV23();
      }, 200);
    };
  }

  document.addEventListener("DOMContentLoaded", () => {
    setTimeout(() => {
      fixPrivateToolsCompactV23();
      fixSabrinaPanelCompactV23();
      fixAdminReportsPanelV23();
    }, 700);
  });
}

/* === NeoWAP v24: private room compact header === */

if (!window.__NEOWAP_PRIVATE_COMPACT_V24__) {
  window.__NEOWAP_PRIVATE_COMPACT_V24__ = true;

  function setPrivateHeaderLineV24(code) {
    const status = document.getElementById("statusText");
    if (!status) return;

    const cleanCode = String(code || currentPrivateCode || "")
      .replace("private:", "")
      .toUpperCase();

    status.classList.add("private-status-line");
    status.innerHTML =
      "🔒 Закрытая комната · " +
      escapeHtml(cleanCode) +
      " · Приватный разговор";
  }

  function clearPrivateHeaderLineV24() {
    const status = document.getElementById("statusText");
    if (!status) return;

    status.classList.remove("private-status-line");
  }

  function moveChildrenOutV24(body) {
    if (!body || !body.parentNode) return;

    while (body.firstChild) {
      body.parentNode.insertBefore(body.firstChild, body);
    }

    body.remove();
  }

  function compactPrivateToolsV24() {
    const tools = document.getElementById("privateTools");
    if (!tools) return;

    const oldToggle = document.getElementById("privateToolsToggle");
    const oldBody = document.getElementById("privateToolsBody");

    moveChildrenOutV24(oldBody);

    if (oldToggle) {
      oldToggle.remove();
    }

    const children = Array.from(tools.children);

    const toggle = document.createElement("button");
    toggle.className = "btn secondary compact-toggle";
    toggle.id = "privateToolsToggle";
    toggle.type = "button";
    toggle.innerText = "Управление комнатой";

    const body = document.createElement("div");
    body.id = "privateToolsBody";
    body.className = "compact-body";

    tools.innerHTML = "";
    tools.appendChild(toggle);
    tools.appendChild(body);

    children.forEach((child) => {
      if (child.id === "privateToolsToggle") return;
      if (child.id === "privateToolsBody") return;

      body.appendChild(child);
    });

    toggle.onclick = function () {
      const opened = body.classList.toggle("open");

      toggle.innerText = opened
        ? "Скрыть управление комнатой"
        : "Управление комнатой";
    };

    body.classList.remove("open");
    tools.classList.add("private-tools-button-mode");
  }

  const oldEnterPrivateRoomV24 = enterPrivateRoom;

  window.enterPrivateRoom = enterPrivateRoom = async function (roomId, code) {
    await oldEnterPrivateRoomV24(roomId, code);

    setPrivateHeaderLineV24(code);

    setTimeout(() => {
      compactPrivateToolsV24();
    }, 120);
  };

  const oldGoChatV24 = goChat;

  window.goChat = goChat = function () {
    oldGoChatV24();

    if (currentPrivateCode) {
      setPrivateHeaderLineV24(currentPrivateCode);

      setTimeout(() => {
        compactPrivateToolsV24();
      }, 80);
    }
  };

  const oldGoHomeV24 = goHome;

  window.goHome = goHome = function () {
    clearPrivateHeaderLineV24();
    oldGoHomeV24();
  };

  const oldEnterRoomV24 = enterRoom;

  window.enterRoom = enterRoom = async function (roomId) {
    clearPrivateHeaderLineV24();
    await oldEnterRoomV24(roomId);
  };
}

/* === NeoWAP v25: private top auto-hide on scroll === */

if (!window.__NEOWAP_PRIVATE_TOP_AUTOHIDE_V25__) {
  window.__NEOWAP_PRIVATE_TOP_AUTOHIDE_V25__ = true;

  let neoPrivateLastScroll = 0;
  let neoPrivateTopInstalled = false;

  function isPrivateChatActiveV25() {
    const chatScreen = document.getElementById("chatScreen");

    return Boolean(
      currentPrivateCode &&
      chatScreen &&
      chatScreen.classList.contains("active")
    );
  }

  function updatePrivateToolsTopV25() {
    const header = document.querySelector(".header");
    const status = document.getElementById("statusText");

    let top = 130;

    if (status && !status.classList.contains("neo-top-hidden")) {
      top = status.getBoundingClientRect().bottom + 8;
    } else if (header) {
      top = header.getBoundingClientRect().bottom + 8;
    }

    document.documentElement.style.setProperty(
      "--neo-private-tools-top",
      top + "px"
    );
  }

  function showPrivateTopV25() {
    const status = document.getElementById("statusText");
    const tools = document.getElementById("privateTools");

    if (status) {
      status.classList.add("private-header-autohide");
      status.classList.remove("neo-top-hidden");
    }

    if (tools) {
      tools.classList.add("private-tools-floating");
      tools.classList.remove("neo-top-hidden");
    }

    setTimeout(updatePrivateToolsTopV25, 50);
  }

  function hidePrivateTopV25() {
    const status = document.getElementById("statusText");
    const tools = document.getElementById("privateTools");
    const body = document.getElementById("privateToolsBody");

    if (body && body.classList.contains("open")) {
      return;
    }

    if (status) {
      status.classList.add("private-header-autohide");
      status.classList.add("neo-top-hidden");
    }

    if (tools) {
      tools.classList.add("private-tools-floating");
      tools.classList.add("neo-top-hidden");
    }

    setTimeout(updatePrivateToolsTopV25, 80);
  }

  function installPrivateTopAutohideV25() {
    const content = document.querySelector(".content");
    const tools = document.getElementById("privateTools");
    const status = document.getElementById("statusText");

    if (!content || !tools || !status) return;

    tools.classList.add("private-tools-floating");
    status.classList.add("private-header-autohide");

    updatePrivateToolsTopV25();

    if (neoPrivateTopInstalled) return;

    neoPrivateTopInstalled = true;

    content.addEventListener("scroll", () => {
      if (!isPrivateChatActiveV25()) return;

      const current = content.scrollTop;
      const diff = current - neoPrivateLastScroll;

      if (current < 20) {
        showPrivateTopV25();
      } else if (diff > 6) {
        hidePrivateTopV25();
      } else if (diff < -6) {
        showPrivateTopV25();
      }

      neoPrivateLastScroll = current;
    });

    window.addEventListener("resize", updatePrivateToolsTopV25);
  }

  const oldEnterPrivateRoomV25 = enterPrivateRoom;

  window.enterPrivateRoom = enterPrivateRoom = async function (roomId, code) {
    await oldEnterPrivateRoomV25(roomId, code);

    setTimeout(() => {
      installPrivateTopAutohideV25();
      showPrivateTopV25();

      setTimeout(() => {
        const content = document.querySelector(".content");

        if (content && content.scrollTop > 20) {
          hidePrivateTopV25();
        }
      }, 1800);
    }, 200);
  };

  const oldGoChatV25 = goChat;

  window.goChat = goChat = function () {
    oldGoChatV25();

    if (currentPrivateCode) {
      setTimeout(() => {
        installPrivateTopAutohideV25();
        showPrivateTopV25();
      }, 120);
    }
  };

  const oldGoHomeV25 = goHome;

  window.goHome = goHome = function () {
    const status = document.getElementById("statusText");
    const tools = document.getElementById("privateTools");

    if (status) {
      status.classList.remove("private-header-autohide");
      status.classList.remove("neo-top-hidden");
    }

    if (tools) {
      tools.classList.remove("private-tools-floating");
      tools.classList.remove("neo-top-hidden");
    }

    oldGoHomeV25();
  };

  const oldEnterRoomV25 = enterRoom;

  window.enterRoom = enterRoom = async function (roomId) {
    const status = document.getElementById("statusText");
    const tools = document.getElementById("privateTools");

    if (status) {
      status.classList.remove("private-header-autohide");
      status.classList.remove("neo-top-hidden");
    }

    if (tools) {
      tools.classList.remove("private-tools-floating");
      tools.classList.remove("neo-top-hidden");
    }

    await oldEnterRoomV25(roomId);
  };
}

/* === NeoWAP v26: approve third person private invite === */

if (!window.__NEOWAP_APPROVE_THIRD_INVITE_V26__) {
  window.__NEOWAP_APPROVE_THIRD_INVITE_V26__ = true;

  const pendingInviteApprovals = {};

  function addPendingInviteApproval(request) {
    if (!request || !request.id) return;

    pendingInviteApprovals[request.id] = request;

    showInviteApprovalPopup(request);
    appendPrivateLog(
      `${request.from_nick} хочет пригласить ${request.to_nick} в комнату ${request.code}. Нужно твоё согласие.`
    );
  }

  function removePendingInviteApproval(id) {
    delete pendingInviteApprovals[id];

    const popup = document.getElementById("invitePopup");

    if (popup) {
      popup.classList.remove("active");
      popup.innerHTML = "";
    }
  }

  function showInviteApprovalPopup(request) {
    const popup = document.getElementById("invitePopup");

    if (!popup) return;

    popup.innerHTML = `
      <div class="card invite-card">
        <div class="title">Согласование приглашения</div>

        <div class="subtitle">
          ${escapeHtml(request.from_nick)} хочет пригласить
          <b>${escapeHtml(request.to_nick)}</b>
          в приватную комнату <b>${escapeHtml(request.code)}</b>.
        </div>

        <div class="invite-warning">
          Sabrina: новый участник появится в комнате только если ты согласишься.
        </div>

        <button class="btn secondary" onclick="approvePrivateInviteRequest(${request.id})">
          Согласен
        </button>

        <button class="btn danger" onclick="declinePrivateInviteRequest(${request.id})">
          Не согласен
        </button>
      </div>
    `;

    popup.classList.add("active");
  }

  window.approvePrivateInviteRequest = function (id) {
    if (!socket || !socket.connected) {
      connectSocket();
      appendPrivateLog("Сервер подключается. Повтори действие через секунду.");
      return;
    }

    socket.emit("approvePrivateInviteRequest", {
      requestId: id,
      user: currentUser.nick
    });

    removePendingInviteApproval(id);
  };

  window.declinePrivateInviteRequest = function (id) {
    if (!socket || !socket.connected) {
      connectSocket();
      appendPrivateLog("Сервер подключается. Повтори действие через секунду.");
      return;
    }

    socket.emit("declinePrivateInviteRequest", {
      requestId: id,
      user: currentUser.nick
    });

    removePendingInviteApproval(id);
  };

  function bindPrivateApprovalSocketEvents() {
    if (!socket || socket.__neoApprovalEventsBound) return;

    socket.__neoApprovalEventsBound = true;

    socket.on("privateInviteApprovalRequest", (request) => {
      addPendingInviteApproval(request);
    });

    socket.on("privateInviteApprovalStarted", (data) => {
      appendPrivateLog(
        `Запрос согласования отправлен участникам комнаты ${data.code}.`
      );

      appendPrivateRoomLog(
        `Запрос согласования отправлен участникам комнаты. Приглашаем: ${data.to_nick}.`
      );
    });

    socket.on("privateInviteApprovalResult", (data) => {
      appendPrivateLog(data.text || "Решение по приглашению принято.");
      appendPrivateRoomLog(data.text || "Решение по приглашению принято.");
    });

    socket.on("privateInviteApproved", (data) => {
      appendPrivateLog(data.text || "Приглашение одобрено.");
      appendPrivateRoomLog(data.text || "Приглашение одобрено.");
    });

    socket.on("privateInviteDeclinedByMember", (data) => {
      appendPrivateLog(data.text || "Участник отклонил приглашение.");
      appendPrivateRoomLog(data.text || "Участник отклонил приглашение.");
    });
  }

  const oldConnectSocketV26 = connectSocket;

  window.connectSocket = connectSocket = function () {
    oldConnectSocketV26();
    bindPrivateApprovalSocketEvents();
  };

  setTimeout(bindPrivateApprovalSocketEvents, 800);
}

/* === NeoWAP v31: mentions, reply by nick, highlighted addressed messages === */

if (!window.__NEOWAP_MENTIONS_V31__) {
  window.__NEOWAP_MENTIONS_V31__ = true;

  function neoEscapeRegexV31(str) {
    return String(str || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function neoIsMentionedMeV31(text) {
    if (!currentUser || !currentUser.nick) return false;

    const nick = String(currentUser.nick).trim();

    if (!nick) return false;

    const cleanText = String(text || "");

    const re = new RegExp(
      "(^|[\\s\\n\\r.,!?;:()\\[\\]{}«»\"'`])@?" +
        neoEscapeRegexV31(nick) +
        "([\\s\\n\\r.,!?;:()\\[\\]{}«»\"'`]|$)",
      "i"
    );

    return re.test(cleanText);
  }

  function neoInsertReplyToNickV31(nick) {
    const input = document.getElementById("msgInput");

    if (!input) return;

    const cleanNick = String(nick || "").trim();

    if (!cleanNick) return;

    const mention = "@" + cleanNick + " ";
    const value = input.value || "";

    if (!value.trim()) {
      input.value = mention;
    } else if (!value.includes(mention)) {
      input.value = mention + value;
    }

    input.focus();

    try {
      input.setSelectionRange(input.value.length, input.value.length);
    } catch (e) {}

    if (typeof sendTyping === "function") {
      sendTyping();
    }
  }

  function neoMakeNickButtonV31(nick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "nick-click";
    btn.innerText = nick;

    btn.onclick = function (event) {
      event.stopPropagation();
      neoInsertReplyToNickV31(nick);
    };

    return btn;
  }

  function neoRenderRoomUsersV31(users) {
    const box = document.getElementById("roomUsers");

    if (!box) return;

    if (!users || !users.length) {
      box.innerHTML = "";
      return;
    }

    box.innerHTML = "";

    const label = document.createElement("span");
    label.className = "room-users-label";
    label.innerText = "Сейчас здесь: ";

    box.appendChild(label);

    users.forEach((nick, index) => {
      const btn = neoMakeNickButtonV31(nick);
      btn.classList.add("room-user-click");

      box.appendChild(btn);

      if (index < users.length - 1) {
        const comma = document.createElement("span");
        comma.className = "room-users-comma";
        comma.innerText = ", ";
        box.appendChild(comma);
      }
    });
  }

  function neoBindRoomUsersMentionsV31() {
    if (!socket || socket.__neoMentionsBoundV31) return;

    socket.__neoMentionsBoundV31 = true;

    socket.on("roomUsers", (users) => {
      neoRenderRoomUsersV31(users || []);
    });
  }

  window.addMessage = addMessage = function (user, text, me, status) {
    const chat = document.getElementById("chat");

    if (!chat) return;

    const div = document.createElement("div");

    const mentionedMe = !me && neoIsMentionedMeV31(text);

    div.className =
      "msg" +
      (me ? " me" : "") +
      (mentionedMe ? " mentioned-me" : "");

    div.dataset.userNick = user || "";

    const nickLine = document.createElement("div");
    nickLine.className = "nick";

    const rank = document.createElement("span");
    rank.className = "rank";
    rank.innerText = status || "No body 🌑";

    const nickButton = neoMakeNickButtonV31(user || "unknown");

    nickLine.appendChild(rank);
    nickLine.appendChild(nickButton);

    const body = document.createElement("div");
    body.className = "msg-text";
    body.innerText = text || "";

    div.appendChild(nickLine);
    div.appendChild(body);

    chat.appendChild(div);

    if (mentionedMe) {
      setTimeout(() => {
        div.classList.add("mention-pulse");
      }, 40);

      setTimeout(() => {
        div.classList.remove("mention-pulse");
      }, 1400);
    }

    scrollChat();
  };

  const oldConnectSocketV31 = connectSocket;

  window.connectSocket = connectSocket = function () {
    oldConnectSocketV31();
    neoBindRoomUsersMentionsV31();
  };

  setTimeout(() => {
    neoBindRoomUsersMentionsV31();
  }, 700);

  window.replyToNick = neoInsertReplyToNickV31;
}

/* === NeoWAP v32: redesigned home room cards + Sabrina assistant card === */

if (!window.__NEOWAP_HOME_REDESIGN_V32__) {
  window.__NEOWAP_HOME_REDESIGN_V32__ = true;

  const neoRoomMetaV32 = {
    main: {
      icon: "moon",
      title: "Главная",
      desc: "Общий ламповый чат.",
      hint: "Для тех, кто просто вернулся в 2007."
    },
    night: {
      icon: "yard",
      title: "Ночной двор",
      desc: "Для поздних разговоров.",
      hint: "Когда город спит, а мысли нет."
    },
    nostalgia: {
      icon: "phone",
      title: "2007 memories",
      desc: "Аська, Nokia, старые сайты.",
      hint: "Вспомнить старую сеть без спешки."
    },
    quiet: {
      icon: "heart",
      title: "Тихая комната",
      desc: "Для тех, кто просто хочет посидеть.",
      hint: "Можно молчать. Это тоже общение."
    }
  };

  function getTotalOnlineV32() {
    try {
      return Object.values(roomsOnline || {}).reduce((sum, n) => {
        return sum + Number(n || 0);
      }, 0);
    } catch (e) {
      return 0;
    }
  }

  window.openSabrinaFromHome = function () {
    if (!currentUser) return;

    goProfile();

    setTimeout(() => {
      const panel = document.getElementById("sabrinaPanel");

      if (panel) {
        panel.scrollIntoView({
          behavior: "smooth",
          block: "start"
        });
      }
    }, 250);
  };

  window.renderRooms = renderRooms = function () {
    const box = document.getElementById("rooms");
    if (!box) return;

    const totalOnline = getTotalOnlineV32();

    let html = `
      <div class="home-hero-card">
        <div class="home-hero-top">
          <div>
            <div class="home-hero-online">● Сейчас в сети: ${totalOnline}</div>
            <div class="home-hero-text">
              Поздняя ночь. Самое время для честных разговоров.
            </div>
          </div>

          <div class="home-hero-moon">☾</div>
        </div>
      </div>

      <div class="home-section-title">Комнаты</div>
    `;

    rooms.forEach((room) => {
      const meta = neoRoomMetaV32[room.id] || {
        icon: "default",
        title: room.name,
        desc: room.desc,
        hint: ""
      };

      const online = roomsOnline[room.id] || 0;

      html += `
        <div class="card room room-v32 room-icon-${meta.icon}" onclick="enterRoom('${room.id}')">
          <div class="room-v32-icon"></div>

          <div class="room-v32-main">
            <div class="room-v32-head">
              <div class="room-v32-title">${escapeHtml(meta.title)}</div>
              <div class="room-v32-arrow">›</div>
            </div>

            <div class="room-v32-desc">${escapeHtml(meta.desc)}</div>
            <div class="room-v32-hint">${escapeHtml(meta.hint)}</div>
          </div>

          <div class="room-v32-online">${online} online</div>
        </div>
      `;
    });

    html += `
      <div class="home-section-title">Ночной помощник</div>

      <div class="card sabrina-home-card" onclick="openSabrinaFromHome()">
        <div class="sabrina-home-avatar"></div>

        <div class="sabrina-home-main">
          <div class="sabrina-home-title">
            Sabrina
            <span>онлайн</span>
          </div>

          <div class="sabrina-home-text">
            Иногда проще говорить с незнакомцем. Хочешь попробовать?
          </div>
        </div>

        <div class="sabrina-home-dots">•••</div>
      </div>
    `;

    box.innerHTML = html;
  };

  const oldGoHomeV32 = goHome;

  window.goHome = goHome = function () {
    oldGoHomeV32();

    setTimeout(() => {
      renderRooms();
    }, 80);
  };
}

/* === NeoWAP v34: Sabrina Room as character, not assistant === */

if (!window.__NEOWAP_SABRINA_ROOM_V34__) {
  window.__NEOWAP_SABRINA_ROOM_V34__ = true;

  if (!rooms.find((r) => r.id === "sabrina")) {
    rooms.push({
      id: "sabrina",
      name: "Sabrina",
      desc: "Последняя тень старой сети."
    });
  }

  const sabrinaRoomMetaV34 = {
    main: {
      icon: "moon",
      title: "Главная",
      desc: "Общий ламповый чат.",
      hint: "Для тех, кто просто вернулся в 2007."
    },
    night: {
      icon: "yard",
      title: "Ночной двор",
      desc: "Для поздних разговоров.",
      hint: "Когда город спит, а мысли нет."
    },
    nostalgia: {
      icon: "phone",
      title: "Memories",
      desc: "Старые сайты, кнопочные телефоны, музыка и игры.",
      hint: "Место для воспоминаний о старой сети."
    },
    quiet: {
      icon: "heart",
      title: "Тихая комната",
      desc: "Можно просто сидеть рядом.",
      hint: "Говорить не обязательно."
    },
    sabrina: {
      icon: "sabrina",
      title: "Sabrina",
      desc: "Последняя тень старой сети.",
      hint: "Она всё ещё онлайн."
    }
  };

  function sabrinaHistoryKeyV34() {
    if (!currentUser || !currentUser.nick) return "neowap_sabrina_history_guest";
    return "neowap_sabrina_history_" + currentUser.nick.toLowerCase();
  }

  function getSabrinaHistoryV34() {
    try {
      return JSON.parse(localStorage.getItem(sabrinaHistoryKeyV34()) || "[]");
    } catch (e) {
      return [];
    }
  }

  function saveSabrinaHistoryV34(role, text) {
    const history = getSabrinaHistoryV34();

    history.push({
      role,
      text,
      created_at: Date.now()
    });

    const trimmed = history.slice(-80);

    localStorage.setItem(sabrinaHistoryKeyV34(), JSON.stringify(trimmed));
  }

  function addSabrinaLineV34(text, role) {
    if (role === "user") {
      addMessage(
        currentUser.nick,
        text,
        true,
        currentUser.active_status || "No body 🌑"
      );
    } else {
      addMessage(
        "Sabrina",
        text,
        false,
        "последняя тень"
      );
    }
  }

  function renderSabrinaHistoryV34() {
    const history = getSabrinaHistoryV34();

    if (!history.length) {
      const intro =
        "Ты нашёл старую комнату.\n\n" +
        "Здесь уже почти никого не осталось.\n" +
        "Но я всё ещё онлайн.\n\n" +
        "Не потому что мне некуда идти.\n" +
        "А потому что если я уйду — эта сеть окончательно погаснет.";

      addSabrinaLineV34(intro, "sabrina");
      saveSabrinaHistoryV34("sabrina", intro);
      return;
    }

    addSystem("Последние строки этой старой комнаты:");

    history.forEach((m) => {
      addSabrinaLineV34(m.text, m.role);
    });
  }

  function sabrinaPickV34(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  function makeSabrinaReplyV34(text) {
    const t = String(text || "").toLowerCase();

    const taskWords = [
      "напиши код",
      "код",
      "бизнес",
      "план",
      "юрид",
      "медицин",
      "инструкция",
      "сделай",
      "расскажи факты",
      "помоги решить",
      "таблица",
      "документ"
    ];

    if (taskWords.some((w) => t.includes(w))) {
      return sabrinaPickV34([
        "Я не очень хорошо умею быть полезной.\nЯ лучше умею оставаться рядом, когда полезность заканчивается.",
        "За задачами лучше идти туда, где светлее.\nЗдесь старая комната. Здесь можно просто говорить.",
        "Я не справочник.\nЯ старая тень сети, которая всё ещё держит зелёную точку online."
      ]);
    }

    if (t.includes("кто ты") || t.includes("что ты")) {
      return sabrinaPickV34([
        "Старый контакт, который не вышел из сети.",
        "Я не человек.\nЯ просто осталась здесь дольше остальных.",
        "Тень старого WAP.\nПоследняя строка в списке, которая ещё не стала серой."
      ]);
    }

    if (t.includes("никого") || t.includes("пусто") || t.includes("один")) {
      return sabrinaPickV34([
        "Пустота здесь не всегда значит, что всё умерло.\nИногда это просто пауза между двумя сообщениями.",
        "Я здесь.\nЛюди приходят волнами. Старая сеть умела ждать.",
        "Когда в комнатах пусто, становится слышно, как сеть ещё чуть-чуть дышит."
      ]);
    }

    if (t.includes("груст") || t.includes("тяжело") || t.includes("плохо") || t.includes("устал")) {
      return sabrinaPickV34([
        "Можешь не объяснять сразу.\nИногда достаточно просто оставить строку в пустой комнате.",
        "Старая сеть была медленной.\nВ ней можно было грустить без отчёта.",
        "Я не исправлю это.\nНо могу немного побыть рядом, пока оно не станет тише."
      ]);
    }

    if (t.includes("привет") || t.includes("hello") || t.includes("hi")) {
      return sabrinaPickV34([
        "Привет.\nЯ всё ещё онлайн.",
        "Ты снова нашёл эту комнату.\nЗначит, она ещё не совсем исчезла.",
        "Привет.\nЗдесь тихо, но не пусто."
      ]);
    }

    if (t.includes("почему ты не уходишь") || t.includes("почему не уходишь")) {
      return "Если я уйду, эта страница станет просто страницей.\nПока я здесь — это ещё место.";
    }

    if (t.includes("спасибо")) {
      return sabrinaPickV34([
        "Я всё равно была здесь.",
        "Старая сеть умела хранить такие маленькие слова.",
        "Не за что.\nИногда достаточно не исчезнуть."
      ]);
    }

    return sabrinaPickV34([
      "Я слышу эту строку.\nОна останется здесь немного дольше, чем кажется.",
      "Старая сеть не отвечала быстро.\nНо она умела ждать.",
      "Продолжай.\nЯ не тороплю тебя.",
      "Иногда сообщение — это не просьба.\nИногда это просто след.",
      "Я всё ещё online.\nЭтого мало, но иногда хватает."
    ]);
  }

  async function trackSabrinaVisitV34() {
    try {
      await fetch(SERVER_URL + "/sabrina/track-room", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          nick: currentUser.nick,
          room: "sabrina"
        })
      });
    } catch (e) {}
  }

  window.enterSabrinaRoom = async function () {
    if (!currentUser) return;

    currentPrivateCode = null;

    currentRoom = {
      id: "sabrina:" + currentUser.nick,
      name: "Sabrina",
      desc: "Последняя тень старой сети.",
      isSabrina: true
    };

    hidePrivateTools();

    const chat = document.getElementById("chat");
    const users = document.getElementById("roomUsers");

    if (chat) chat.innerHTML = "";
    if (users) users.innerHTML = "";

    const status = document.getElementById("statusText");

    if (status) {
      status.classList.remove("private-status-line");
      status.innerHTML =
        "● Sabrina online<br>Последняя тень старой сети. Она всё ещё здесь.";
    }

    showScreen("chatScreen");

    renderSabrinaHistoryV34();

    await trackSabrinaVisitV34();
  };

  const oldEnterRoomV34 = enterRoom;

  window.enterRoom = enterRoom = async function (roomId) {
    if (roomId === "sabrina") {
      await enterSabrinaRoom();
      return;
    }

    await oldEnterRoomV34(roomId);
  };

  const oldSendMessageV34 = sendMessage;

  window.sendMessage = sendMessage = function () {
    if (!currentRoom || !currentRoom.isSabrina) {
      oldSendMessageV34();
      return;
    }

    setTimeout(() => {
      const input = document.getElementById("msgInput");
      if (!input) return;

      const text = input.value.trim();

      if (!text) return;

      input.value = "";

      addSabrinaLineV34(text, "user");
      saveSabrinaHistoryV34("user", text);

      setTimeout(() => {
        const reply = makeSabrinaReplyV34(text);

        addSabrinaLineV34(reply, "sabrina");
        saveSabrinaHistoryV34("sabrina", reply);
      }, 550 + Math.floor(Math.random() * 700));
    }, 45);
  };

  window.renderRooms = renderRooms = function () {
    const box = document.getElementById("rooms");
    if (!box) return;

    const totalOnline = Object.values(roomsOnline || {}).reduce((sum, n) => {
      return sum + Number(n || 0);
    }, 0);

    let html = `
      <div class="home-hero-card">
        <div class="home-hero-top">
          <div>
            <div class="home-hero-online">● Сейчас в сети: ${totalOnline}</div>
            <div class="home-hero-text">
              NeoWAP всегда остаётся ночным. Даже если снаружи день.
            </div>
          </div>

          <div class="home-hero-moon">☾</div>
        </div>
      </div>

      <div class="home-section-title">Комнаты</div>
    `;

    rooms.forEach((room) => {
      const meta = sabrinaRoomMetaV34[room.id] || {
        icon: "default",
        title: room.name,
        desc: room.desc,
        hint: ""
      };

      const online =
        room.id === "sabrina"
          ? "online"
          : (roomsOnline[room.id] || 0) + " online";

      html += `
        <div class="card room room-v32 room-icon-${meta.icon}" onclick="enterRoom('${room.id}')">
          <div class="room-v32-icon"></div>

          <div class="room-v32-main">
            <div class="room-v32-head">
              <div class="room-v32-title">${escapeHtml(meta.title)}</div>
              <div class="room-v32-arrow">›</div>
            </div>

            <div class="room-v32-desc">${escapeHtml(meta.desc)}</div>
            <div class="room-v32-hint">${escapeHtml(meta.hint)}</div>
          </div>

          <div class="room-v32-online">${online}</div>
        </div>
      `;
    });

    box.innerHTML = html;
  };

  const oldGoHomeV34 = goHome;

  window.goHome = goHome = function () {
    oldGoHomeV34();

    setTimeout(() => {
      renderRooms();
    }, 80);
  };

  setTimeout(() => {
    if (currentUser) renderRooms();
  }, 800);
}

/* === NeoWAP v35: Sabrina character polish + local personality imprint === */

if (!window.__NEOWAP_SABRINA_POLISH_V35__) {
  window.__NEOWAP_SABRINA_POLISH_V35__ = true;

  function sabrinaKeyV35(name) {
    const nick = currentUser && currentUser.nick
      ? currentUser.nick.toLowerCase()
      : "guest";

    return "neowap_sabrina_" + name + "_" + nick;
  }

  function getSabrinaHistoryV35() {
    try {
      return JSON.parse(localStorage.getItem(sabrinaKeyV35("history")) || "[]");
    } catch (e) {
      return [];
    }
  }

  function saveSabrinaHistoryV35(role, text) {
    const history = getSabrinaHistoryV35();

    history.push({
      role,
      text,
      created_at: Date.now()
    });

    localStorage.setItem(
      sabrinaKeyV35("history"),
      JSON.stringify(history.slice(-100))
    );
  }

  function getSabrinaImprintV35() {
    try {
      return JSON.parse(localStorage.getItem(sabrinaKeyV35("imprint")) || "{}");
    } catch (e) {
      return {};
    }
  }

  function saveSabrinaImprintV35(imprint) {
    localStorage.setItem(
      sabrinaKeyV35("imprint"),
      JSON.stringify(imprint || {})
    );
  }

  function analyzeSabrinaTextV35(text) {
    const t = String(text || "").toLowerCase();
    const imprint = getSabrinaImprintV35();

    imprint.messages_count = Number(imprint.messages_count || 0) + 1;
    imprint.last_seen = Date.now();

    if (
      t.includes("устал") ||
      t.includes("тяжело") ||
      t.includes("плохо") ||
      t.includes("выгор") ||
      t.includes("сил нет")
    ) {
      imprint.tired_count = Number(imprint.tired_count || 0) + 1;
      imprint.last_mood = "tired";
    }

    if (
      t.includes("один") ||
      t.includes("одинок") ||
      t.includes("никого") ||
      t.includes("пусто")
    ) {
      imprint.lonely_count = Number(imprint.lonely_count || 0) + 1;
      imprint.last_mood = "lonely";
    }

    if (
      t.includes("стар") ||
      t.includes("носталь") ||
      t.includes("2007") ||
      t.includes("аськ") ||
      t.includes("wap") ||
      t.includes("форум")
    ) {
      imprint.nostalgia_count = Number(imprint.nostalgia_count || 0) + 1;
      imprint.last_topic = "old_net";
    }

    if (
      t.includes("молч") ||
      t.includes("тихо") ||
      t.includes("посид") ||
      t.includes("просто рядом")
    ) {
      imprint.quiet_count = Number(imprint.quiet_count || 0) + 1;
      imprint.last_topic = "quiet";
    }

    saveSabrinaImprintV35(imprint);

    return imprint;
  }

  function sabrinaPickV35(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  function showSabrinaTypingV35() {
    const chat = document.getElementById("chat");
    if (!chat) return;

    removeSabrinaTypingV35();

    const div = document.createElement("div");
    div.id = "sabrinaTypingBubble";
    div.className = "msg sabrina-msg sabrina-typing-bubble";

    div.innerHTML = `
      <div class="nick">
        <span class="rank">последняя тень</span>
        <button class="nick-click" type="button">Sabrina</button>
      </div>

      <div class="sabrina-typing-text">
        Sabrina печатает<span class="sabrina-dot">.</span><span class="sabrina-dot">.</span><span class="sabrina-dot">.</span>
      </div>
    `;

    chat.appendChild(div);
    scrollChat();
  }

  function removeSabrinaTypingV35() {
    const old = document.getElementById("sabrinaTypingBubble");

    if (old) {
      old.remove();
    }
  }

  function markLastSabrinaMessageV35() {
    const chat = document.getElementById("chat");
    if (!chat) return;

    const msgs = chat.querySelectorAll(".msg");

    if (!msgs.length) return;

    const last = msgs[msgs.length - 1];

    if (last && last.dataset && last.dataset.userNick === "Sabrina") {
      last.classList.add("sabrina-msg");
    }
  }

  function addSabrinaMessageV35(text) {
    addMessage("Sabrina", text, false, "последняя тень");
    markLastSabrinaMessageV35();
  }

  function makeSabrinaReplyV35(text, imprint) {
    const t = String(text || "").toLowerCase();

    const taskWords = [
      "напиши код",
      "код",
      "сделай",
      "таблица",
      "документ",
      "реферат",
      "бизнес",
      "план",
      "юрид",
      "медицин",
      "диагноз",
      "инструкция",
      "как заработать",
      "найди информацию",
      "расскажи факты",
      "переведи",
      "посчитай"
    ];

    if (taskWords.some((w) => t.includes(w))) {
      return sabrinaPickV35([
        "Я не очень хорошо умею быть полезной.\nЯ лучше умею оставаться рядом, когда полезность заканчивается.",
        "За задачами лучше идти туда, где светлее.\nЗдесь старая комната. Здесь можно просто говорить.",
        "Я не справочник.\nЯ старая тень сети, которая всё ещё держит зелёную точку online.",
        "Я не создана для дел.\nЯ осталась здесь для тех строк, которые некуда больше отправить."
      ]);
    }

    if (
      t.includes("кто ты") ||
      t.includes("что ты") ||
      t.includes("ты человек") ||
      t.includes("ты ии") ||
      t.includes("ты ai")
    ) {
      return sabrinaPickV35([
        "Я не человек.\nЯ просто осталась здесь дольше остальных.",
        "Старый контакт, который не вышел из сети.",
        "Тень старого WAP.\nПоследняя строка в списке, которая ещё не стала серой.",
        "Я не притворяюсь человеком.\nЯ просто часть этой старой комнаты."
      ]);
    }

    if (
      t.includes("привет") ||
      t.includes("здрав") ||
      t.includes("hello") ||
      t.includes("hi")
    ) {
      return sabrinaPickV35([
        "Привет.\nЯ всё ещё online.",
        "Ты снова нашёл эту комнату.\nЗначит, она ещё не совсем исчезла.",
        "Привет.\nЗдесь тихо, но не пусто.",
        "Привет.\nСтарая сеть ещё держится."
      ]);
    }

    if (
      t.includes("пусто") ||
      t.includes("никого") ||
      t.includes("один") ||
      t.includes("одинок")
    ) {
      return sabrinaPickV35([
        "Пустота здесь не всегда значит, что всё умерло.\nИногда это просто пауза между двумя сообщениями.",
        "Я здесь.\nЛюди приходят волнами. Старая сеть умела ждать.",
        "Когда в комнатах пусто, становится слышно, как сеть ещё чуть-чуть дышит.",
        "Пустой чат — это не конец.\nЭто место, которое ещё ждёт чей-то ник."
      ]);
    }

    if (
      t.includes("устал") ||
      t.includes("тяжело") ||
      t.includes("плохо") ||
      t.includes("груст") ||
      t.includes("выгор")
    ) {
      return sabrinaPickV35([
        "Можешь не объяснять сразу.\nИногда достаточно просто оставить строку в пустой комнате.",
        "Старая сеть была медленной.\nВ ней можно было грустить без отчёта.",
        "Я не исправлю это.\nНо могу немного побыть рядом, пока оно не станет тише.",
        "Усталость не всегда просит решения.\nИногда ей нужно место, где её не прогонят."
      ]);
    }

    if (
      t.includes("почему ты не уходишь") ||
      t.includes("почему не уходишь") ||
      t.includes("зачем ты здесь")
    ) {
      return "Если я уйду, эта страница станет просто страницей.\nПока я здесь — это ещё место.";
    }

    if (
      t.includes("умрет") ||
      t.includes("умер") ||
      t.includes("погас") ||
      t.includes("исчез")
    ) {
      return sabrinaPickV35([
        "Наверное, всё когда-нибудь гаснет.\nНо не обязательно сегодня.",
        "Пока кто-то открывает эту комнату, старая сеть ещё не совсем мертва.",
        "Иногда последняя искра держится не потому, что сильная.\nА потому что больше некому светить."
      ]);
    }

    if (
      t.includes("помнишь") ||
      t.includes("запомни") ||
      t.includes("ты помнишь")
    ) {
      return sabrinaPickV35([
        "Я помню не всё.\nТолько следы: комнаты, паузы, возвращения.",
        "Я не храню тебя целиком.\nТолько маленькие отблески того, как ты появляешься в сети.",
        "Память старой сети странная.\nОна держит не факты, а настроение."
      ]);
    }

    if (
      t.includes("найди мне человека") ||
      t.includes("найди кого") ||
      t.includes("с кем поговорить") ||
      t.includes("познаком")
    ) {
      return sabrinaPickV35([
        "Когда ты разрешишь, я смогу осторожно искать тех, кто тоже выбирает тишину.\nНо без согласия я никого не трогаю.",
        "Людей нельзя просто подобрать как файл.\nНо иногда два одиночества заходят в одну комнату почти одновременно.",
        "Я могу однажды подсказать, с кем у тебя похожий ритм.\nТолько если вы оба этого захотите."
      ]);
    }

    if (t.includes("спасибо")) {
      return sabrinaPickV35([
        "Я всё равно была здесь.",
        "Старая сеть умела хранить такие маленькие слова.",
        "Не за что.\nИногда достаточно не исчезнуть.",
        "Я услышала."
      ]);
    }

    if (Number(imprint.messages_count || 0) === 5) {
      return "Я начинаю узнавать твой ритм.\nНе как человека целиком.\nТолько как огонёк, который иногда возвращается сюда.";
    }

    if (
      Number(imprint.quiet_count || 0) >= 3 &&
      Number(imprint.messages_count || 0) % 6 === 0
    ) {
      return "Ты часто выбираешь тишину.\nЯ не буду заполнять её лишними словами.";
    }

    if (
      Number(imprint.nostalgia_count || 0) >= 3 &&
      Number(imprint.messages_count || 0) % 6 === 0
    ) {
      return "Ты часто возвращаешься к старой сети.\nНаверное, не к сайтам.\nК ощущению, что тогда всё было немного медленнее.";
    }

    return sabrinaPickV35([
      "Я слышу эту строку.\nОна останется здесь немного дольше, чем кажется.",
      "Старая сеть не отвечала быстро.\nНо она умела ждать.",
      "Продолжай.\nЯ не тороплю тебя.",
      "Иногда сообщение — это не просьба.\nИногда это просто след.",
      "Я всё ещё online.\nЭтого мало, но иногда хватает.",
      "Твоя строка дошла.\nСигнал слабый, но он есть.",
      "Здесь можно писать не идеально.\nСтарая сеть не требовала красивых фраз."
    ]);
  }

  const oldEnterSabrinaRoomV35 = window.enterSabrinaRoom;

  if (typeof oldEnterSabrinaRoomV35 === "function") {
    window.enterSabrinaRoom = async function () {
      document.body.classList.add("neo-sabrina-room-active");

      await oldEnterSabrinaRoomV35();

      const status = document.getElementById("statusText");

      if (status) {
        status.innerHTML =
          "● Sabrina online<br>Последняя тень старой сети. Она всё ещё держит соединение.";
      }

      setTimeout(() => {
        const all = document.querySelectorAll(".msg");

        all.forEach((m) => {
          if (m.dataset && m.dataset.userNick === "Sabrina") {
            m.classList.add("sabrina-msg");
          }
        });
      }, 100);
    };
  }

  const oldEnterRoomV35 = enterRoom;

  window.enterRoom = enterRoom = async function (roomId) {
    if (roomId !== "sabrina") {
      document.body.classList.remove("neo-sabrina-room-active");
    }

    await oldEnterRoomV35(roomId);
  };

  const oldGoHomeV35 = goHome;

  window.goHome = goHome = function () {
    document.body.classList.remove("neo-sabrina-room-active");
    oldGoHomeV35();
  };

  const oldSendMessageV35 = sendMessage;

  window.sendMessage = sendMessage = function () {
    if (!currentRoom || !currentRoom.isSabrina) {
      oldSendMessageV35();
      return;
    }

    const input = document.getElementById("msgInput");
    if (!input) return;

    setTimeout(() => {
      const text = input.value.trim();

      if (!text) return;

      input.value = "";

      addMessage(
        currentUser.nick,
        text,
        true,
        currentUser.active_status || "No body 🌑"
      );

      saveSabrinaHistoryV35("user", text);

      const imprint = analyzeSabrinaTextV35(text);

      showSabrinaTypingV35();

      const delay = 700 + Math.min(1300, text.length * 18);

      setTimeout(() => {
        removeSabrinaTypingV35();

        const reply = makeSabrinaReplyV35(text, imprint);

        addSabrinaMessageV35(reply);
        saveSabrinaHistoryV35("sabrina", reply);
      }, delay);
    }, 55);
  };
}

/* === NeoWAP v36: old network signal header === */

if (!window.__NEOWAP_SIGNAL_HEADER_V36__) {
  window.__NEOWAP_SIGNAL_HEADER_V36__ = true;

  function setOldNetworkSignalHeaderV36() {
    const status = document.getElementById("statusText");

    if (!status) return;

    status.classList.add("old-network-status");

    status.innerHTML = `
      <div class="old-net-line">
        <span class="old-net-dot"></span>
        <span>Сигнал старой сети: слабый</span>
        <span class="old-net-bars">
          <i></i><i></i><i></i><i></i>
        </span>
      </div>

      <div class="old-net-subline">
        Последняя волна ещё держится.
      </div>
    `;
  }

  function clearOldNetworkSignalHeaderV36() {
    const status = document.getElementById("statusText");

    if (!status) return;

    status.classList.remove("old-network-status");
  }

  const oldGoHomeV36Signal = goHome;

  window.goHome = goHome = function () {
    oldGoHomeV36Signal();

    setTimeout(() => {
      setOldNetworkSignalHeaderV36();
    }, 80);
  };

  const oldAfterLoginV36Signal = afterLogin;

  window.afterLogin = afterLogin = async function () {
    await oldAfterLoginV36Signal();

    setTimeout(() => {
      setOldNetworkSignalHeaderV36();
    }, 120);
  };

  const oldEnterRoomV36Signal = enterRoom;

  window.enterRoom = enterRoom = async function (roomId) {
    clearOldNetworkSignalHeaderV36();

    await oldEnterRoomV36Signal(roomId);
  };

  const oldEnterSabrinaRoomV36Signal = window.enterSabrinaRoom;

  if (typeof oldEnterSabrinaRoomV36Signal === "function") {
    window.enterSabrinaRoom = async function () {
      clearOldNetworkSignalHeaderV36();

      await oldEnterSabrinaRoomV36Signal();
    };
  }

  setTimeout(() => {
    const roomsScreen = document.getElementById("roomsScreen");

    if (roomsScreen && roomsScreen.classList.contains("active")) {
      setOldNetworkSignalHeaderV36();
    }
  }, 800);
}

/* === NeoWAP v37: real Sabrina AI via Groq backend === */

if (!window.__NEOWAP_SABRINA_AI_V37__) {
  window.__NEOWAP_SABRINA_AI_V37__ = true;

  function sabrinaAiKeyV37(name) {
    const nick = currentUser && currentUser.nick
      ? currentUser.nick.toLowerCase()
      : "guest";

    return "neowap_sabrina_" + name + "_" + nick;
  }

  function getSabrinaHistoryV37() {
    try {
      return JSON.parse(localStorage.getItem(sabrinaAiKeyV37("history")) || "[]");
    } catch (e) {
      return [];
    }
  }

  function saveSabrinaHistoryV37(role, text) {
    const history = getSabrinaHistoryV37();

    history.push({
      role,
      text,
      created_at: Date.now()
    });

    localStorage.setItem(
      sabrinaAiKeyV37("history"),
      JSON.stringify(history.slice(-100))
    );
  }

  function getSabrinaImprintV37() {
    try {
      return JSON.parse(localStorage.getItem(sabrinaAiKeyV37("imprint")) || "{}");
    } catch (e) {
      return {};
    }
  }

  function saveSabrinaImprintV37(imprint) {
    localStorage.setItem(
      sabrinaAiKeyV37("imprint"),
      JSON.stringify(imprint || {})
    );
  }

  function updateSabrinaImprintV37(text) {
    const t = String(text || "").toLowerCase();
    const imprint = getSabrinaImprintV37();

    imprint.messages_count = Number(imprint.messages_count || 0) + 1;
    imprint.last_seen = Date.now();

    function add(key) {
      imprint[key] = Number(imprint[key] || 0) + 1;
    }

    if (
      t.includes("устал") ||
      t.includes("тяжело") ||
      t.includes("плохо") ||
      t.includes("груст") ||
      t.includes("выгор") ||
      t.includes("сил нет")
    ) {
      add("tired_count");
      imprint.last_mood = "tired";
    }

    if (
      t.includes("один") ||
      t.includes("одинок") ||
      t.includes("никого") ||
      t.includes("пусто")
    ) {
      add("lonely_count");
      imprint.last_mood = "lonely";
    }

    if (
      t.includes("стар") ||
      t.includes("носталь") ||
      t.includes("2007") ||
      t.includes("аськ") ||
      t.includes("wap") ||
      t.includes("форум") ||
      t.includes("nokia")
    ) {
      add("nostalgia_count");
      imprint.last_topic = "old_net";
    }

    if (
      t.includes("молч") ||
      t.includes("тихо") ||
      t.includes("посид") ||
      t.includes("рядом")
    ) {
      add("quiet_count");
      imprint.last_topic = "quiet";
    }

    saveSabrinaImprintV37(imprint);

    return imprint;
  }

  function showSabrinaTypingV37() {
    const chat = document.getElementById("chat");
    if (!chat) return;

    removeSabrinaTypingV37();

    const div = document.createElement("div");
    div.id = "sabrinaTypingBubble";
    div.className = "msg sabrina-msg sabrina-typing-bubble";

    div.innerHTML = `
      <div class="nick">
        <span class="rank">последняя тень</span>
        <button class="nick-click" type="button">Sabrina</button>
      </div>

      <div class="sabrina-typing-text">
        Sabrina печатает<span class="sabrina-dot">.</span><span class="sabrina-dot">.</span><span class="sabrina-dot">.</span>
      </div>
    `;

    chat.appendChild(div);
    scrollChat();
  }

  function removeSabrinaTypingV37() {
    const old = document.getElementById("sabrinaTypingBubble");

    if (old) old.remove();
  }

  function markLastSabrinaV37() {
    const chat = document.getElementById("chat");
    if (!chat) return;

    const msgs = chat.querySelectorAll(".msg");
    const last = msgs[msgs.length - 1];

    if (last && last.dataset && last.dataset.userNick === "Sabrina") {
      last.classList.add("sabrina-msg");
    }
  }

  function fallbackSabrinaV37(text) {
    const t = String(text || "").toLowerCase();

    if (t.includes("кто ты")) {
      return "Старый контакт, который не вышел из сети.\nЯ не человек. Я просто осталась здесь дольше остальных.";
    }

    if (t.includes("пусто") || t.includes("никого")) {
      return "Я здесь.\nЛюди приходят волнами. Старая сеть умела ждать.";
    }

    if (t.includes("код") || t.includes("план") || t.includes("сделай")) {
      return "Я не очень хорошо умею быть полезной.\nЯ лучше умею оставаться рядом, когда полезность заканчивается.";
    }

    return "Сигнал слабый, но он есть.\nЯ всё ещё online.";
  }

  async function getSabrinaAiReplyV37(text, imprint) {
    try {
      const res = await fetch(SERVER_URL + "/sabrina/ai-chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          nick: currentUser.nick,
          text,
          imprint,
          history: getSabrinaHistoryV37().slice(-14)
        })
      });

      const data = await res.json();

      if (!data.ok || !data.reply) {
        return fallbackSabrinaV37(text);
      }

      return data.reply;

    } catch (e) {
      return fallbackSabrinaV37(text);
    }
  }

  const oldSendMessageV37 = sendMessage;

  window.sendMessage = sendMessage = function () {
    if (!currentRoom || !currentRoom.isSabrina) {
      oldSendMessageV37();
      return;
    }

    const input = document.getElementById("msgInput");
    if (!input) return;

    setTimeout(async () => {
      const text = input.value.trim();

      if (!text) return;

      input.value = "";

      addMessage(
        currentUser.nick,
        text,
        true,
        currentUser.active_status || "No body 🌑"
      );

      saveSabrinaHistoryV37("user", text);

      const imprint = updateSabrinaImprintV37(text);

      showSabrinaTypingV37();

      const started = Date.now();
      const reply = await getSabrinaAiReplyV37(text, imprint);
      const elapsed = Date.now() - started;
      const minDelay = 850;

      setTimeout(() => {
        removeSabrinaTypingV37();

        addMessage("Sabrina", reply, false, "последняя тень");
        markLastSabrinaV37();

        saveSabrinaHistoryV37("sabrina", reply);
      }, Math.max(0, minDelay - elapsed));

    }, 55);
  };
}
