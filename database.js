const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'data', 'registration.db');

let db = null;

async function initDatabase() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS clubs (
      club_id INTEGER PRIMARY KEY,
      club_name TEXT NOT NULL,
      password TEXT NOT NULL,
      is_admin INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS registrations (
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
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS payment_proofs (
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
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  const adminCheck = db.exec("SELECT COUNT(*) as cnt FROM clubs WHERE is_admin = 1");
  const adminCount = adminCheck[0]?.values[0][0] || 0;
  if (adminCount === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.run("INSERT OR IGNORE INTO clubs (club_id, club_name, password, is_admin) VALUES (?, ?, ?, ?)",
      [0, '系統管理員', hash, 1]);
  }

  const settingsCheck = db.exec("SELECT COUNT(*) as cnt FROM settings");
  const settingsCount = settingsCheck[0]?.values[0][0] || 0;
  if (settingsCount === 0) {
    const defaultSettings = [
      ['phase1_deadline', '2025-09-20'],
      ['payment_deadline', '2025-09-30'],
      ['phase2_deadline', '2025-10-20'],
      ['guaranteed_quota', '10'],
      ['current_phase', '1']
    ];
    for (const [key, value] of defaultSettings) {
      db.run("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", [key, value]);
    }
  }

  saveDatabase();
  console.log('Database initialized');
  return db;
}

function saveDatabase() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

function getDb() {
  return db;
}

function runQuery(sql, params = []) {
  db.run(sql, params);
  saveDatabase();
}

function getAll(sql, params = []) {
  const result = db.exec(sql, params);
  if (result.length === 0) return [];
  const columns = result[0].columns;
  return result[0].values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

function getOne(sql, params = []) {
  const result = db.exec(sql, params);
  if (result.length === 0) return null;
  const columns = result[0].columns;
  const row = result[0].values[0];
  const obj = {};
  columns.forEach((col, i) => { obj[col] = row[i]; });
  return obj;
}

function insert(sql, params = []) {
  db.run(sql, params);
  const lastId = db.exec("SELECT last_insert_rowid() as id")[0]?.values[0][0];
  saveDatabase();
  return lastId;
}

function importClubs(clubsData) {
  const stmt = db.prepare("INSERT OR REPLACE INTO clubs (club_id, club_name, password, is_admin) VALUES (?, ?, ?, 0)");
  for (const club of clubsData) {
    const defaultPwd = String(club.club_id).slice(-4);
    const hash = bcrypt.hashSync(defaultPwd, 10);
    stmt.run([club.club_id, club.club_name, hash]);
  }
  stmt.free();
  saveDatabase();
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
