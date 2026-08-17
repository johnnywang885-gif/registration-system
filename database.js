const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');

let db = null;

async function initDatabase() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url) {
    throw new Error('TURSO_DATABASE_URL environment variable is required');
  }

  db = createClient({ url, authToken: authToken || undefined });

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
    )`,
    `CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      club_id INTEGER,
      display_name TEXT,
      category TEXT DEFAULT '其他',
      message TEXT NOT NULL,
      status TEXT DEFAULT 'open',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS line_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      sender_id TEXT,
      message TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS line_sources (
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_name TEXT,
      member_count INTEGER,
      last_message_at DATETIME,
      PRIMARY KEY (source_type, source_id)
    )`,
    `CREATE TABLE IF NOT EXISTS knowledge (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      source_file TEXT
    )`
  ], 'write');

  // Migration: add admin_perms column (次管理者權限 JSON 陣列；NULL = 一般社團)
  await ensureAdminPermsColumn();

  // Migration: add source_file column (知識來源上傳檔名；NULL = 手動新增)
  await ensureKnowledgeSourceFileColumn();

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
      ['phase1_deadline', '2026-09-20'],
      ['payment_deadline', '2026-09-30'],
      ['phase2_deadline', '2026-10-20'],
      ['guaranteed_quota', '10'],
      ['phase1_total_quota', '160'],
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

// 冪等確認 admin_perms 欄位存在（啟動 migration ＋ 寫入前保險）
async function ensureAdminPermsColumn() {
  if (!db) throw new Error('Database not connected');
  try {
    await db.execute("ALTER TABLE clubs ADD COLUMN admin_perms TEXT");
    console.log('Migration: clubs.admin_perms 欄位已新增');
  } catch (err) {
    // column already exists — ignore
  }
}

// 冪等確認 knowledge.source_file 欄位存在（記錄知識來源檔名，供整檔刪除）
async function ensureKnowledgeSourceFileColumn() {
  if (!db) throw new Error('Database not connected');
  try {
    await db.execute("ALTER TABLE knowledge ADD COLUMN source_file TEXT");
    console.log('Migration: knowledge.source_file 欄位已新增');
  } catch (err) {
    // column already exists — ignore
  }
}

async function importClubs(clubsData) {
  if (!Array.isArray(clubsData) || clubsData.length === 0) return 0;
  const valid = clubsData.filter(c => c && c.club_id != null && c.club_name != null && String(c.club_name).trim() !== ''
    && /^\d+$/.test(String(c.club_id)) && Number(c.club_id) > 0);
  if (valid.length === 0) return 0;
  const stmts = valid.map(club => {
    const defaultPwd = String(club.club_id).slice(-4);
    const hash = bcrypt.hashSync(defaultPwd, 10);
    return {
      sql: "INSERT INTO clubs (club_id, club_name, password, is_admin) VALUES (?, ?, ?, 0) ON CONFLICT(club_id) DO UPDATE SET club_name = excluded.club_name, password = excluded.password WHERE is_admin = 0 AND (admin_perms IS NULL OR admin_perms = '')",
      args: [club.club_id, String(club.club_name).trim(), hash]
    };
  });
  await db.batch(stmts, 'write');
  return valid.length;
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
  importClubs,
  ensureAdminPermsColumn,
  ensureKnowledgeSourceFileColumn
};
