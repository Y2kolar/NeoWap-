const { pool } = require("./db");

function setupCleanupRoutes(app) {
  app.get("/admin/cleanup-test-data", async (req, res) => {
    const secret = String(req.query.secret || "").trim();

    if (!process.env.CLEAN_SECRET || secret !== process.env.CLEAN_SECRET) {
      return res.status(403).json({
        ok: false,
        error: "Нет доступа"
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      await client.query("TRUNCATE TABLE messages RESTART IDENTITY CASCADE");
      await client.query("TRUNCATE TABLE private_reports RESTART IDENTITY CASCADE");
      await client.query("TRUNCATE TABLE notifications RESTART IDENTITY CASCADE");
      await client.query("TRUNCATE TABLE private_invites RESTART IDENTITY CASCADE");
      await client.query("TRUNCATE TABLE private_invite_requests RESTART IDENTITY CASCADE");
      await client.query("TRUNCATE TABLE private_invite_request_votes RESTART IDENTITY CASCADE");
      await client.query("TRUNCATE TABLE private_room_members RESTART IDENTITY CASCADE");
      await client.query("TRUNCATE TABLE private_rooms RESTART IDENTITY CASCADE");
      await client.query("TRUNCATE TABLE sabrina_imprints CASCADE");

      await client.query("COMMIT");

      res.json({
        ok: true,
        message: "Тестовые данные очищены. Пользователи сохранены."
      });

    } catch (e) {
      await client.query("ROLLBACK");

      console.error("CLEANUP ERROR:", e);

      res.status(500).json({
        ok: false,
        error: "Ошибка очистки"
      });

    } finally {
      client.release();
    }
  });
}

module.exports = {
  setupCleanupRoutes
};
