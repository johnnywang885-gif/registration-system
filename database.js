const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');

let db = null;

async function initDatabase() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  console.log('initDatabase: URL exists =', !!url, ', Token exists =', !!authToken);
  if (url) console.log('initDatabase: URL =', url);

  if (!url) {
    throw new Error('TURSO_DATABASE_URL environment variable is required');
  }

  db = createClient({ url, authToken: authToken || undefined });
  console.log('initDatabase: Client created, testing connection...');

  // Create tables
  await db.batch([
    `CREATE TABLE IF NOT EXISTS clubs (
      club_id INTEGER PRIMARY KEY,
      club_name TEXT NOT NULL,
      password TEXT NOT NULL,
      is_admin INTEGER DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS registrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      club_id INTEGER NOT NULL,
      position TEXT,
      name TEXT NOT NULL,
      id_card TEXT,
      birthday TEXT,
      phone TEXT,
      meal_type TEXT,
      phase INTEGER DEFAULT 1,
      status TEXT DEFAULT 'registered',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (club_id) REFERENCES clubs(club_id)
    )`,
    `CREATE TABLE IF NOT EXISTS payment_proofs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      registration_id INTEGER,
      club_id INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      file_type TEXT NOT NULL,
      file_name TEXT,
      status TEXT DEFAULT 'pending',
      reviewed_by TEXT,
      reviewed_at DATETIME,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (registration_id) REFERENCES registrations(id),
      FOREIGN KEY (club_id) REFERENCES clubs(club_id)
    )`,
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )`
  ], 'write');

  console.log('initDatabase: Tables created, checking admin...');

  // Create default admin if not exists
  const adminCheck = await db.execute("SELECT COUNT(*) as cnt FROM clubs WHERE is_admin = 1");
  const adminCount = adminCheck.rows[0]?.cnt || 0;
  if (adminCount === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    await db.execute({
      sql: "INSERT OR IGNORE INTO clubs (club_id, club_name, password, is_admin) VALUES (?, ?, ?, ?)",
      args: [0, '系統管理員', hash, 1]
    });
  }

  // Create default settings if not exists
  const settingsCheck = await db.execute("SELECT COUNT(*) as cnt FROM settings");
  const settingsCount = settingsCheck.rows[0]?.cnt || 0;
  if (settingsCount === 0) {
    const defaultSettings = [
      ['phase1_deadline', '2025-09-20'],
      ['payment_deadline', '2025-09-30'],
      ['phase2_deadline', '2025-10-20'],
      ['guaranteed_quota', '10'],
      ['current_phase', '1']
    ];
    const stmts = defaultSettings.map(([key, value]) => ({
      sql: "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
      args: [key, value]
    }));
    await db.batch(stmts, 'write');
  }

  console.log('Database connected to Turso');
  return db;
}

function getDb() {
  return db;
}

async function runQuery(sql, params = []) {
  if (!db) throw new Error('Database not connected');
  await db.execute({ sql, args: params || [] });
}

async function getAll(sql, params = []) {
  if (!db) throw new Error('Database not connected');
  const result = await db.execute({ sql, args: params || [] });
  return result.rows;
}

async function getOne(sql, params = []) {
  if (!db) throw new Error('Database not connected');
  const result = await db.execute({ sql, args: params || [] });
  return result.rows[0] || null;
}

async function insert(sql, params = []) {
  if (!db) throw new Error('Database not connected');
  const result = await db.execute({ sql, args: params || [] });
  return Number(result.lastInsertRowid);
}

async function importClubs(clubsData) {
  const stmts = clubsData.map(club => {
    const defaultPwd = String(club.club_id).slice(-4);
    const hash = bcrypt.hashSync(defaultPwd, 10);
    return {
      sql: "INSERT OR REPLACE INTO clubs (club_id, club_name, password, is_admin) VALUES (?, ?, ?, 0)",
      args: [club.club_id, club.club_name, hash]
    };
  });
  await db.batch(stmts, 'write');
}

function saveDatabase() {
  // No-op: data is persisted in Turso cloud
}

module.exports = {
  initDatabase,
  getDb,
  saveDatabase,
  runQuery,
  getAll,
  getOne,
  insert,
  importClubs
};
