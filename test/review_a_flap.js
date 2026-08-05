const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'review_a.db');
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.TURSO_DATABASE_URL = 'file:' + DB_PATH.replace(/\\/g, '/');
process.env.TURSO_AUTH_TOKEN = '';

const { initDatabase, getDb } = require('../database');
const { runEnforcement, getSettings } = require('../deadlines');

async function statusCounts(db, clubId, label) {
  const res = await db.execute({
    sql: "SELECT status, COUNT(*) as cnt FROM registrations WHERE club_id = ? GROUP BY status",
    args: [clubId]
  });
  const m = { registered: 0, standby: 0, paid: 0, forfeited: 0 };
  res.rows.forEach(r => { m[r.status] = Number(r.cnt); });
  console.log(`  ${label} -> registered=${m.registered} standby=${m.standby} paid=${m.paid} forfeited=${m.forfeited}`);
}

async function main() {
  console.log('STEP 1: initDatabase');
  await initDatabase();
  const db = getDb();
  console.log('STEP 2: settings batch');
  await db.batch([
    { sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", args: ['phase1_deadline', '2026-08-01'] },
    { sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", args: ['payment_deadline', '2026-08-03'] },
    { sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", args: ['phase2_deadline', '2026-08-10'] },
    { sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", args: ['guaranteed_quota', '10'] },
    { sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", args: ['phase1_total_quota', '160'] }
  ], 'write');

  console.log('STEP 3: clubs batch');
  await db.batch([
    { sql: "INSERT OR REPLACE INTO clubs (club_id, club_name, password, is_admin) VALUES (?, ?, ?, 0)", args: [2401, '未繳費社', 'x'] },
    { sql: "INSERT OR REPLACE INTO clubs (club_id, club_name, password, is_admin) VALUES (?, ?, ?, 0)", args: [2402, '已繳費社', 'x'] }
  ], 'write');

  console.log('STEP 4: registrations batch');
  const stmts = [];
  for (let i = 1; i <= 10; i++) stmts.push({ sql: "INSERT INTO registrations (club_id, name, phase, status) VALUES (?, ?, 1, 'registered')", args: [2401, `A${i}`] });
  for (let i = 1; i <= 3; i++) stmts.push({ sql: "INSERT INTO registrations (club_id, name, phase, status) VALUES (?, ?, 1, 'standby')", args: [2401, `S${i}`] });
  for (let i = 1; i <= 2; i++) stmts.push({ sql: "INSERT INTO registrations (club_id, name, phase, status) VALUES (?, ?, 1, 'standby')", args: [2402, `P${i}`] });
  await db.batch(stmts, 'write');

  console.log('STEP 5: approved proof insert');
  await db.execute({
    sql: "INSERT INTO payment_proofs (club_id, file_path, file_type, status) VALUES (?, ?, ?, 'approved')",
    args: [2402, '/uploads/payments/x.png', 'image']
  });

  console.log('STEP 6: getSettings');
  const settings = await getSettings();
  console.log(`taipeiToday = ${require('../deadlines').taipeiToday()}`);
  console.log(`dates: p1=${settings.phase1_deadline} pay=${settings.payment_deadline} p2=${settings.phase2_deadline}`);
  console.log('STEP 7: statusCounts initial');
  await statusCounts(db, 2401, '2401');
  await statusCounts(db, 2402, '2402');

  console.log('STEP 8: runEnforcement loop');
  for (let i = 1; i <= 5; i++) {
    console.log(`[iteration ${i}]`);
    await runEnforcement();
    await statusCounts(db, 2401, '2401');
    await statusCounts(db, 2402, '2402');
  }

  console.log('\n結論（修正後應為）：');
  console.log('  2401（未繳費社團）：10 registered 被棄權，3 名候補維持 standby（不自動遞補）');
  console.log('  2402（已繳費社團）：2 名候補被遞補為 registered 且穩定（不會被棄權）');
  console.log('  若以上狀態在 iterations 間完全穩定，代表 runEnforcement 修正生效（不再有遞補↔棄權橫跳）。');
  db.close();
  try { fs.unlinkSync(DB_PATH); } catch (e) {}
}

main().catch(err => { console.error(err); process.exit(1); });

