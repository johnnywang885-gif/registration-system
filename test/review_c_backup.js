const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'review_c.db');
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.TURSO_DATABASE_URL = 'file:' + DB_PATH.replace(/\\/g, '/');
process.env.TURSO_AUTH_TOKEN = '';

const { initDatabase, getDb } = require('../database');
const { runEnforcement, getSettings, taipeiToday } = require('../deadlines');

const BACKUP_PATH = path.join(__dirname, '..', 'backup_2026-08-04 (2).json');

async function counts(label) {
  const res = await getDb().execute({
    sql: "SELECT phase, status, COUNT(*) as cnt FROM registrations GROUP BY phase, status ORDER BY phase, status"
  });
  console.log(`--- ${label} ---`);
  res.rows.forEach(r => console.log(`  phase ${r.phase} ${r.status}: ${r.cnt}`));
  const total = await getDb().execute({ sql: 'SELECT COUNT(*) as cnt FROM registrations' });
  console.log(`  total: ${total.rows[0].cnt}`);
}

async function main() {
  await initDatabase();
  const db = getDb();

  const backup = JSON.parse(fs.readFileSync(BACKUP_PATH, 'utf8'));
  console.log(`backup: clubs=${backup.clubs.length} regs=${backup.registrations.length} proofs=${backup.payment_proofs.length} settings=${backup.settings.length}`);

  await db.batch([
    "DELETE FROM payment_proofs",
    "DELETE FROM registrations",
    "DELETE FROM settings",
    "DELETE FROM clubs WHERE is_admin = 0"
  ], 'write');

  await db.batch(backup.clubs.map(c => ({
    sql: "INSERT OR REPLACE INTO clubs (club_id, club_name, password, is_admin) VALUES (?, ?, ?, ?)",
    args: [c.club_id, c.club_name, c.password, c.is_admin || 0]
  })), 'write');

  await db.batch(backup.registrations.map(r => ({
    sql: "INSERT OR REPLACE INTO registrations (id, club_id, position, name, id_card, birthday, phone, meal_type, phase, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    args: [r.id, r.club_id, r.position || '', r.name, r.id_card || '', r.birthday || '', r.phone || '', r.meal_type || '', r.phase || 1, r.status || 'registered', r.created_at || null]
  })), 'write');

  await db.batch(backup.payment_proofs.map(p => ({
    sql: "INSERT OR REPLACE INTO payment_proofs (id, registration_id, club_id, file_path, file_type, file_name, status, reviewed_by, reviewed_at, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    args: [p.id, p.registration_id, p.club_id, p.file_path, p.file_type, p.file_name || '', p.status || 'pending', p.reviewed_by || null, p.reviewed_at || null, p.uploaded_at || null]
  })), 'write');

  await db.batch(backup.settings.map(s => ({
    sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
    args: [s.key, s.value]
  })), 'write');

  const settings = await getSettings();
  console.log(`taipeiToday = ${taipeiToday()}`);
  console.log(`dates: p1=${settings.phase1_deadline} pay=${settings.payment_deadline} p2=${settings.phase2_deadline}`);
  const approved = await db.execute({ sql: "SELECT COUNT(*) as cnt FROM payment_proofs WHERE status = 'approved'" });
  console.log(`approved proofs: ${approved.rows[0].cnt} / ${backup.payment_proofs.length}`);

  await counts('還原後 / 執行 runEnforcement 前');

  console.log('\n--- 執行 runEnforcement() 一次 ---');
  await runEnforcement();

  await counts('執行後');

  const phase2deadline = settings.phase2_deadline;
  console.log(`\nphase2_deadline=${phase2deadline}；today=${taipeiToday()} > phase2_deadline -> ${taipeiToday() > phase2deadline}`);
  console.log('預期：phase1 與 phase2 未繳費 registered 被棄權；因窗口不重疊（phase2 已過），不應有遞補橫跳。');
  db.close();
  try { fs.unlinkSync(DB_PATH); } catch (e) {}
}

main().catch(err => { console.error(err); process.exit(1); });
