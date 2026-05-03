const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      nick TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      messages_count INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      room TEXT NOT NULL,
      user_nick TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'user';`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS paid_status TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS manual_status TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_until TIMESTAMP;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_forever BOOLEAN DEFAULT false;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS muted_until TIMESTAMP;`);

  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS trust_score INTEGER DEFAULT 35;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS warnings_count INTEGER DEFAULT 0;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS reports_count INTEGER DEFAULT 0;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS mutes_count INTEGER DEFAULT 0;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bans_count INTEGER DEFAULT 0;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMP;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS private_rooms (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      created_by TEXT NOT NULL,
      invited_nick TEXT NOT NULL,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS private_invites (
      id SERIAL PRIMARY KEY,
      code TEXT NOT NULL,
      from_nick TEXT NOT NULL,
      to_nick TEXT NOT NULL,
      warning_level TEXT DEFAULT 'none',
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW(),
      accepted_at TIMESTAMP,
      declined_at TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS private_room_members (
      id SERIAL PRIMARY KEY,
      code TEXT NOT NULL,
      nick TEXT NOT NULL,
      role TEXT DEFAULT 'member',
      joined_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(code, nick)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS private_reports (
      id SERIAL PRIMARY KEY,
      code TEXT NOT NULL,
      reporter_nick TEXT NOT NULL,
      target_nick TEXT NOT NULL,
      reason TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  
await pool.query(`
  CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    nick TEXT NOT NULL,
    type TEXT DEFAULT 'system',
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    is_read BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW()
  );
`);
  
  await pool.query(`ALTER TABLE private_reports ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';`);
  await pool.query(`ALTER TABLE private_reports ADD COLUMN IF NOT EXISTS ai_verdict TEXT;`);
  await pool.query(`ALTER TABLE private_reports ADD COLUMN IF NOT EXISTS ai_confidence INTEGER;`);
  await pool.query(`ALTER TABLE private_reports ADD COLUMN IF NOT EXISTS ai_action TEXT;`);
  await pool.query(`ALTER TABLE private_reports ADD COLUMN IF NOT EXISTS ai_notes TEXT;`);
  await pool.query(`ALTER TABLE private_reports ADD COLUMN IF NOT EXISTS review_required BOOLEAN DEFAULT true;`);
  await pool.query(`ALTER TABLE private_reports ADD COLUMN IF NOT EXISTS processed_at TIMESTAMP;`);
  await pool.query(`ALTER TABLE private_reports ADD COLUMN IF NOT EXISTS admin_reviewed_by TEXT;`);
  await pool.query(`ALTER TABLE private_reports ADD COLUMN IF NOT EXISTS admin_reviewed_at TIMESTAMP;`);

  console.log("Database ready");
}

module.exports = {
  pool,
  initDb
};
