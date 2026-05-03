console.log("NeoWAP test app.js v16 loaded");

const SERVER_URL = "https://neowap-production.up.railway.app";

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

  ok.innerText = "Подключаюсь...";

  try {
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

    ok.innerText =
      "Вход работает. Пользователь: " +
      data.user.nick +
      " · роль: " +
      data.user.role;

    document.getElementById("topUser").innerText = data.user.nick;

  } catch (e) {
    ok.innerText = "";
    error.innerText = "Сервер не отвечает или app.js не может вызвать /auth.";
  }
}

window.login = login;
