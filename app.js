const bcrypt = require("bcryptjs");

const { pool } = require("./db");
const statusTools = require("./statuses");
const trustTools = require("./trust");
const userTools = require("./users");
const privateRooms = require("./privateRooms");

function getEarnedStatus(count) {
  return statusTools.getEarnedStatus(count);
}

function getActiveStatus(user) {
  return statusTools.getActiveStatus(user);
}

function getTrustLevel(score) {
  return trustTools.getTrustLevel(score);
}

async function ensureAdmin(user) {
  return userTools.ensureAdmin(user);
}

async function touchUser(nick) {
  return userTools.touchUser(nick);
}

async function getUserByNick(nick) {
  return userTools.getUserByNick(nick);
}

async function requireAdmin(adminNick) {
  const cleanNick = String(adminNick || "").trim();

  if (!cleanNick) return null;

  let user = await getUserByNick(cleanNick);
  user = await ensureAdmin(user);

  if (!user || user.role !== "admin") return null;

  return user;
}

function addHours(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

function setupRoutes(app, options = {}) {
  const getRoomsOnline = options.getRoomsOnline || (() => ({}));

  app.get("/", (req, res) => {
    res.send("NeoWAP server online");
  });

  app.get("/health", (req, res) => {
    res.json({ ok: true });
  });

  app.post("/auth", async (req, res) => {
    try {
      const { nick, password } = req.body;

      if (!nick || !password) {
        return res.status(400).json({
          ok: false,
          error: "Нужен ник и пароль"
        });
      }

      const cleanNick = String(nick).trim();
      const cleanPassword = String(password).trim();

      if (cleanNick.length < 3 || cleanNick.length > 20) {
        return res.status(400).json({
          ok: false,
          error: "Ник должен быть 3–20 символов"
        });
      }

      if (cleanPassword.length < 4 || cleanPassword.length > 60) {
        return res.status(400).json({
          ok: false,
          error: "Пароль должен быть 4–60 символов"
        });
      }

      const existing = await pool.query(
        "SELECT * FROM users WHERE lower(nick) = lower($1)",
        [cleanNick]
      );

      if (existing.rows.length === 0) {
        const hash = await bcrypt.hash(cleanPassword, 10);

        const created = await pool.query(
          `INSERT INTO users (nick, password_hash, trust_score, last_seen)
           VALUES ($1, $2, 35, NOW())
           RETURNING *`,
          [cleanNick, hash]
        );

        let user = created.rows[0];
        user = await ensureAdmin(user);

        return res.json({
          ok: true,
          mode: "registered",
          user: {
            ...user,
            active_status: getActiveStatus(user),
            earned_status: getEarnedStatus(user.messages_count),
            trust_level: getTrustLevel(user.trust_score)
          }
        });
      }

      let user = existing.rows[0];
      user = await ensureAdmin(user);

      const now = new Date();

      if (user.banned_forever) {
        return res.status(403).json({
          ok: false,
          error: "Этот ник забанен навсегда"
        });
      }

      if (user.ban_until && new Date(user.ban_until) > now) {
        return res.status(403).json({
          ok: false,
          error: "Этот ник временно забанен"
        });
      }

      const valid = await bcrypt.compare(cleanPassword, user.password_hash);

      if (!valid) {
        return res.status(401).json({
          ok: false,
          error: "Неверный пароль"
        });
      }

      await touchUser(user.nick);

      return res.json({
        ok: true,
        mode: "login",
        user: {
          ...user,
          active_status: getActiveStatus(user),
          earned_status: getEarnedStatus(user.messages_count),
          trust_level: getTrustLevel(user.trust_score)
        }
      });

    } catch (e) {
      console.error("AUTH ERROR:", e);

      res.status(500).json({
        ok: false,
        error: "Ошибка сервера"
      });
    }
  });

  app.get("/messages/:room", async (req, res) => {
    try {
      const room = req.params.room;

      const result = await pool.query(
        `SELECT m.*, u.messages_count, u.manual_status, u.paid_status, u.trust_score
         FROM messages m
         LEFT JOIN users u
         ON lower(u.nick) = lower(m.user_nick)
         WHERE m.room = $1
         ORDER BY m.id DESC
         LIMIT 50`,
        [room]
      );

      const messages = result.rows.reverse().map((m) => ({
        ...m,
        active_status:
          m.manual_status ||
          m.paid_status ||
          getEarnedStatus(m.messages_count || 0),
        trust_level: getTrustLevel(m.trust_score || 35)
      }));

      res.json({
        ok: true,
        messages
      });

    } catch (e) {
      console.error("MESSAGES ERROR:", e);

      res.status(500).json({
        ok: false
      });
    }
  });

  app.get("/rooms-online", (req, res) => {
    res.json({
      ok: true,
      rooms: getRoomsOnline()
    });
  });

  app.get("/private-invites/:nick", async (req, res) => {
    try {
      const nick = String(req.params.nick || "").trim();

      const result = await pool.query(
        `SELECT *
         FROM private_invites
         WHERE lower(to_nick) = lower($1)
         AND status = 'pending'
         ORDER BY id DESC
         LIMIT 20`,
        [nick]
      );

      res.json({
        ok: true,
        invites: result.rows
      });

    } catch (e) {
      console.error("PRIVATE INVITES ERROR:", e);

      res.status(500).json({
        ok: false,
        error: "Ошибка загрузки приглашений"
      });
    }
  });

  app.get("/private-rooms/:nick", async (req, res) => {
    try {
      const nick = String(req.params.nick || "").trim();

      const result = await pool.query(
        `SELECT prm.code, prm.role, prm.joined_at, pr.created_by, pr.is_active
         FROM private_room_members prm
         LEFT JOIN private_rooms pr ON pr.code = prm.code
         WHERE lower(prm.nick) = lower($1)
         AND pr.is_active = true
         ORDER BY prm.joined_at DESC
         LIMIT 20`,
        [nick]
      );

      res.json({
        ok: true,
        rooms: result.rows
      });

    } catch (e) {
      console.error("PRIVATE ROOMS ERROR:", e);

      res.status(500).json({
        ok: false,
        error: "Ошибка загрузки приватных комнат"
      });
    }
  });

  app.get("/admin/reports", async (req, res) => {
    try {
      const admin = await requireAdmin(req.query.admin);

      if (!admin) {
        return res.status(403).json({
          ok: false,
          error: "Нет прав администратора"
        });
      }

      const result = await pool.query(
        `SELECT id, code, reporter_nick, target_nick, reason, status,
                review_required, created_at, processed_at,
                admin_reviewed_by, admin_reviewed_at
         FROM private_reports
         ORDER BY id DESC
         LIMIT 50`
      );

      res.json({
        ok: true,
        reports: result.rows
      });

    } catch (e) {
      console.error("ADMIN REPORTS ERROR:", e);

      res.status(500).json({
        ok: false,
        error: "Ошибка загрузки жалоб"
      });
    }
  });

  app.get("/admin/reports/:id", async (req, res) => {
    try {
      const admin = await requireAdmin(req.query.admin);

      if (!admin) {
        return res.status(403).json({
          ok: false,
          error: "Нет прав администратора"
        });
      }

      const id = Number(req.params.id);

      if (!id) {
        return res.status(400).json({
          ok: false,
          error: "Некорректный id жалобы"
        });
      }

      const reportResult = await pool.query(
        `SELECT *
         FROM private_reports
         WHERE id = $1
         LIMIT 1`,
        [id]
      );

      const report = reportResult.rows[0];

      if (!report) {
        return res.status(404).json({
          ok: false,
          error: "Жалоба не найдена"
        });
      }

      const roomId = privateRooms.privateRoomId(report.code);

      const contextResult = await pool.query(
        `SELECT user_nick, text, created_at
         FROM messages
         WHERE room = $1
         ORDER BY id DESC
         LIMIT 20`,
        [roomId]
      );

      res.json({
        ok: true,
        report,
        context: contextResult.rows.reverse()
      });

    } catch (e) {
      console.error("ADMIN REPORT DETAIL ERROR:", e);

      res.status(500).json({
        ok: false,
        error: "Ошибка загрузки жалобы"
      });
    }
  });

  app.post("/admin/reports/:id/action", async (req, res) => {
    try {
      const { adminNick, action, note } = req.body;

      const admin = await requireAdmin(adminNick);

      if (!admin) {
        return res.status(403).json({
          ok: false,
          error: "Нет прав администратора"
        });
      }

      const id = Number(req.params.id);

      if (!id) {
        return res.status(400).json({
          ok: false,
          error: "Некорректный id жалобы"
        });
      }

      const reportResult = await pool.query(
        `SELECT *
         FROM private_reports
         WHERE id = $1
         LIMIT 1`,
        [id]
      );

      const report = reportResult.rows[0];

      if (!report) {
        return res.status(404).json({
          ok: false,
          error: "Жалоба не найдена"
        });
      }

      let status = "reviewed";
      let deltaTrust = 0;
      let warningsInc = 0;
      let mutesInc = 0;
      let bansInc = 0;
      let mutedUntil = null;
      let banUntil = null;
      let message = "Действие применено.";

      if (action === "no_violation") {
        status = "closed_no_violation";
        message = "Жалоба закрыта: нарушение не подтверждено.";
      } else if (action === "warn") {
        status = "action_warn";
        deltaTrust = -5;
        warningsInc = 1;
        message = "Выдано предупреждение, trust -5.";
      } else if (action === "mute_1h") {
        status = "action_mute_1h";
        deltaTrust = -10;
        mutesInc = 1;
        mutedUntil = addHours(1);
        message = "Выдан мут на 1 час, trust -10.";
      } else if (action === "mute_10h") {
        status = "action_mute_10h";
        deltaTrust = -25;
        mutesInc = 1;
        mutedUntil = addHours(10);
        message = "Выдан мут на 10 часов, trust -25.";
      } else if (action === "ban_1d") {
        status = "action_ban_1d";
        deltaTrust = -35;
        bansInc = 1;
        banUntil = addHours(24);
        message = "Выдан бан на 1 день, trust -35.";
      } else {
        return res.status(400).json({
          ok: false,
          error: "Неизвестное действие"
        });
      }

      if (action !== "no_violation") {
        await pool.query(
          `UPDATE users
           SET trust_score = LEAST(100, GREATEST(0, COALESCE(trust_score, 35) + $1)),
               warnings_count = COALESCE(warnings_count, 0) + $2,
               mutes_count = COALESCE(mutes_count, 0) + $3,
               bans_count = COALESCE(bans_count, 0) + $4,
               muted_until = CASE WHEN $5::timestamp IS NULL THEN muted_until ELSE $5::timestamp END,
               ban_until = CASE WHEN $6::timestamp IS NULL THEN ban_until ELSE $6::timestamp END
           WHERE lower(nick) = lower($7)`,
          [
            deltaTrust,
            warningsInc,
            mutesInc,
            bansInc,
            mutedUntil,
            banUntil,
            report.target_nick
          ]
        );
      }

      const updatedReport = await pool.query(
        `UPDATE private_reports
         SET status = $1,
             ai_action = $2,
             ai_notes = $3,
             review_required = false,
             processed_at = NOW(),
             admin_reviewed_by = $4,
             admin_reviewed_at = NOW()
         WHERE id = $5
         RETURNING *`,
        [
          status,
          action,
          note || message,
          admin.nick,
          id
        ]
      );

      res.json({
        ok: true,
        message,
        report: updatedReport.rows[0]
      });

    } catch (e) {
      console.error("ADMIN REPORT ACTION ERROR:", e);

      res.status(500).json({
        ok: false,
        error: "Ошибка применения действия"
      });
    }
  });
}

module.exports = {
  setupRoutes
};
/* === NeoWAP PATCH v11: admin reports list and quick actions === */

if (!window.__NEOWAP_PATCH_V11__) {
  window.__NEOWAP_PATCH_V11__ = true;

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

  const oldGoProfileV11 = goProfile;

  window.goProfile = goProfile = function () {
    oldGoProfileV11();
    ensureAdminReportsPanel();
  };

  window.loadAdminReports = async function () {
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

      data.reports.forEach(r => {
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
  };

  window.loadAdminReportDetail = async function (id) {
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
        ? context.map(m => {
            const time = m.created_at
              ? new Date(m.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
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

      detail.innerHTML += `
        <div class="rules-small">
          ✅ ${escapeHtml(data.message)}
        </div>
      `;

      await loadAdminReports();

    } catch (e) {
      appendAdminLog("Ошибка соединения с сервером.");
    }
  };
}
