const { pool } = require("./db");

async function ensureSabrinaTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      nick TEXT PRIMARY KEY,
      remember_enabled BOOLEAN DEFAULT true,
      hints_enabled BOOLEAN DEFAULT true,
      match_enabled BOOLEAN DEFAULT false,
      can_be_suggested BOOLEAN DEFAULT false,
      quiet_mode BOOLEAN DEFAULT false,
      favorite_room TEXT,
      last_room TEXT,
      visits_count INTEGER DEFAULT 0,
      sabrina_notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_room_stats (
      id SERIAL PRIMARY KEY,
      nick TEXT NOT NULL,
      room TEXT NOT NULL,
      visits_count INTEGER DEFAULT 0,
      last_visit TIMESTAMP DEFAULT NOW(),
      UNIQUE(nick, room)
    );
  `);
}

async function ensureProfile(nick) {
  const cleanNick = String(nick || "").trim();

  if (!cleanNick) return null;

  await ensureSabrinaTables();

  await pool.query(
    `INSERT INTO user_profiles (nick)
     VALUES ($1)
     ON CONFLICT (nick) DO NOTHING`,
    [cleanNick]
  );

  const result = await pool.query(
    `SELECT *
     FROM user_profiles
     WHERE lower(nick) = lower($1)
     LIMIT 1`,
    [cleanNick]
  );

  return result.rows[0];
}

function makeSabrinaGreeting(profile) {
  if (!profile) {
    return "Sabrina пока тебя не знает.";
  }

  if (profile.quiet_mode) {
    return "Sabrina будет вести себя тише. Я рядом, но не буду часто вмешиваться.";
  }

  if (profile.favorite_room) {
    return `Sabrina: кажется, тебе чаще всего подходит комната ${profile.favorite_room}.`;
  }

  if (profile.visits_count <= 2) {
    return "Sabrina: я пока только знакомлюсь с тобой. Просто выбирай комнаты, а я запомню, где тебе спокойнее.";
  }

  return "Sabrina: я начинаю понимать твой ритм в NeoWAP.";
}

function publicProfile(profile) {
  return {
    nick: profile.nick,
    remember_enabled: profile.remember_enabled,
    hints_enabled: profile.hints_enabled,
    match_enabled: profile.match_enabled,
    can_be_suggested: profile.can_be_suggested,
    quiet_mode: profile.quiet_mode,
    favorite_room: profile.favorite_room,
    last_room: profile.last_room,
    visits_count: profile.visits_count,
    sabrina_notes: profile.sabrina_notes,
    greeting: makeSabrinaGreeting(profile)
  };
}

function setupSabrinaRoutes(app) {
  app.get("/sabrina/profile/:nick", async (req, res) => {
    try {
      const nick = String(req.params.nick || "").trim();

      if (!nick) {
        return res.status(400).json({
          ok: false,
          error: "Нужен ник"
        });
      }

      const profile = await ensureProfile(nick);

      res.json({
        ok: true,
        profile: publicProfile(profile)
      });

    } catch (e) {
      console.error("SABRINA PROFILE ERROR:", e);

      res.status(500).json({
        ok: false,
        error: "Ошибка загрузки профиля Sabrina"
      });
    }
  });

  app.post("/sabrina/profile/:nick/settings", async (req, res) => {
    try {
      const nick = String(req.params.nick || "").trim();

      if (!nick) {
        return res.status(400).json({
          ok: false,
          error: "Нужен ник"
        });
      }

      await ensureProfile(nick);

      const rememberEnabled = Boolean(req.body.remember_enabled);
      const hintsEnabled = Boolean(req.body.hints_enabled);
      const matchEnabled = Boolean(req.body.match_enabled);
      const canBeSuggested = Boolean(req.body.can_be_suggested);
      const quietMode = Boolean(req.body.quiet_mode);

      const result = await pool.query(
        `UPDATE user_profiles
         SET remember_enabled = $1,
             hints_enabled = $2,
             match_enabled = $3,
             can_be_suggested = $4,
             quiet_mode = $5,
             updated_at = NOW()
         WHERE lower(nick) = lower($6)
         RETURNING *`,
        [
          rememberEnabled,
          hintsEnabled,
          matchEnabled,
          canBeSuggested,
          quietMode,
          nick
        ]
      );

      res.json({
        ok: true,
        profile: publicProfile(result.rows[0])
      });

    } catch (e) {
      console.error("SABRINA SETTINGS ERROR:", e);

      res.status(500).json({
        ok: false,
        error: "Ошибка сохранения настроек Sabrina"
      });
    }
  });

  app.post("/sabrina/track-room", async (req, res) => {
    try {
      const nick = String(req.body.nick || "").trim();
      const room = String(req.body.room || "").trim();

      if (!nick || !room) {
        return res.status(400).json({
          ok: false,
          error: "Нужен ник и комната"
        });
      }

      const profile = await ensureProfile(nick);

      if (!profile.remember_enabled) {
        return res.json({
          ok: true,
          skipped: true
        });
      }

      await pool.query(
        `INSERT INTO user_room_stats (nick, room, visits_count, last_visit)
         VALUES ($1, $2, 1, NOW())
         ON CONFLICT (nick, room)
         DO UPDATE SET
           visits_count = user_room_stats.visits_count + 1,
           last_visit = NOW()`,
        [nick, room]
      );

      const favoriteResult = await pool.query(
        `SELECT room
         FROM user_room_stats
         WHERE lower(nick) = lower($1)
         ORDER BY visits_count DESC, last_visit DESC
         LIMIT 1`,
        [nick]
      );

      const favoriteRoom = favoriteResult.rows[0]?.room || room;

      const updated = await pool.query(
        `UPDATE user_profiles
         SET last_room = $1,
             favorite_room = $2,
             visits_count = COALESCE(visits_count, 0) + 1,
             updated_at = NOW()
         WHERE lower(nick) = lower($3)
         RETURNING *`,
        [room, favoriteRoom, nick]
      );

      res.json({
        ok: true,
        profile: publicProfile(updated.rows[0])
      });

    } catch (e) {
      console.error("SABRINA TRACK ROOM ERROR:", e);

      res.status(500).json({
        ok: false,
        error: "Ошибка обновления памяти Sabrina"
      });
    }
  });

  app.get("/sabrina/matches/:nick", async (req, res) => {
    try {
      const nick = String(req.params.nick || "").trim();

      if (!nick) {
        return res.status(400).json({
          ok: false,
          error: "Нужен ник"
        });
      }

      const profile = await ensureProfile(nick);

      if (!profile.match_enabled) {
        return res.json({
          ok: true,
          matches: [],
          message: "Подбор людей выключен."
        });
      }

      const result = await pool.query(
        `SELECT nick, favorite_room, last_room, visits_count
         FROM user_profiles
         WHERE lower(nick) <> lower($1)
         AND match_enabled = true
         AND can_be_suggested = true
         AND (
           favorite_room = $2
           OR last_room = $3
           OR quiet_mode = $4
         )
         ORDER BY updated_at DESC
         LIMIT 5`,
        [
          nick,
          profile.favorite_room,
          profile.last_room,
          profile.quiet_mode
        ]
      );

      const matches = result.rows.map((m) => ({
        nick: m.nick,
        favorite_room: m.favorite_room,
        last_room: m.last_room,
        reason:
          m.favorite_room && m.favorite_room === profile.favorite_room
            ? "похожий выбор комнат"
            : "похожий ритм общения"
      }));

      res.json({
        ok: true,
        matches
      });

    } catch (e) {
      console.error("SABRINA MATCHES ERROR:", e);

      res.status(500).json({
        ok: false,
        error: "Ошибка подбора людей"
      });
    }
  });
}

module.exports = {
  setupSabrinaRoutes
};
