const path = require('path');
const fs = require('fs');
const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'test_phase2.db');

async function main() {
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  const db = createClient({ url: `file:${DB_PATH}` });

  await db.batch([
    `CREATE TABLE clubs (club_id INTEGER PRIMARY KEY, club_name TEXT, password TEXT, is_admin INTEGER DEFAULT 0)`,
    `CREATE TABLE registrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, club_id INTEGER, position TEXT, name TEXT,
      id_card TEXT, birthday TEXT, phone TEXT, meal_type TEXT,
      phase INTEGER DEFAULT 1, status TEXT DEFAULT 'registered',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)`
  ], 'write');

  const hash = bcrypt.hashSync('2401', 10);
  await db.execute({ sql: "INSERT INTO clubs VALUES (?,?,?,0)", args: [2401, '眉溪', hash] });
  await db.batch([
    { sql: "INSERT OR REPLACE INTO settings VALUES (?,?)", args: ['current_phase', '1'] },
    { sql: "INSERT OR REPLACE INTO settings VALUES (?,?)", args: ['guaranteed_quota', '10'] },
    { sql: "INSERT OR REPLACE INTO settings VALUES (?,?)", args: ['phase1_total_quota', '160'] }
  ], 'write');

  console.log('=== Phase 1：眉溪社報名 15 人 ===');
  for (let i = 1; i <= 15; i++) {
    const count = await db.execute({
      sql: "SELECT COUNT(*) as cnt FROM registrations WHERE club_id = 2401 AND phase = 1 AND status != 'forfeited'"
    });
    const cnt = Number(count.rows[0].cnt);
    const isStandby = cnt >= 10 ? 'standby' : 'registered';
    await db.execute({
      sql: "INSERT INTO registrations (club_id, name, phase, status) VALUES (?,?,?,?)",
      args: [2401, `人員${String(i).padStart(2,'0')}`, 1, isStandby]
    });
    console.log(`  第${i}人 → ${isStandby}`);
  }
  const p1 = await db.execute({
    sql: "SELECT status, COUNT(*) as cnt FROM registrations WHERE club_id = 2401 AND phase = 1 GROUP BY status"
  });
  let reg=0, std=0;
  p1.rows.forEach(r => { if (r.status==='registered') reg=r.cnt; if (r.status==='standby') std=r.cnt; });
  console.log(`\n  Phase 1 結果：${reg} registered + ${std} standby`);

  // Switch to Phase 2
  console.log('\n=== 切換至 Phase 2 ===');
  await db.execute({ sql: "INSERT OR REPLACE INTO settings VALUES (?,?)", args: ['current_phase', '2'] });
  console.log('  current_phase = 2');

  // Phase 2 registrations
  console.log('\n=== Phase 2：眉溪社再報名 5 人 ===');
  for (let i = 16; i <= 20; i++) {
    await db.execute({
      sql: "INSERT INTO registrations (club_id, name, phase, status) VALUES (?,?,?,?)",
      args: [2401, `人員${i}`, 2, 'registered']
    });
    console.log(`  第${i}人 → registered (Phase 2 直接正取)`);
  }

  // Check standby status
  const standbyCheck = await db.execute({
    sql: "SELECT COUNT(*) as cnt FROM registrations WHERE club_id = 2401 AND status = 'standby'"
  });
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║ Phase 1 候補仍存在：${standbyCheck.rows[0].cnt} 人 (未自動遞補)      ║`);
  const regCheck = await db.execute({
    sql: "SELECT COUNT(*) as cnt FROM registrations WHERE club_id = 2401 AND phase = 1 AND status = 'registered'"
  });
  console.log(`║ Phase 1 正取：${regCheck.rows[0].cnt} 人                  ║`);
  const p2Check = await db.execute({
    sql: "SELECT COUNT(*) as cnt FROM registrations WHERE club_id = 2401 AND phase = 2"
  });
  console.log(`║ Phase 2 報名：${p2Check.rows[0].cnt} 人                  ║`);
  console.log(`╚══════════════════════════════════════╝`);

  // Try auto-promote (now works in any phase)
  console.log(`\n=== 執行自動遞補 (任何階段皆可) ===`);
  const phase1TotalQuota = 160;
  const currentTotal = await db.execute({
    sql: "SELECT COUNT(*) as cnt FROM registrations WHERE phase = 1 AND status IN ('registered', 'standby')"
  });
  const availableSpots = phase1TotalQuota - Number(currentTotal.rows[0].cnt);
  console.log(`  Phase 1 quota 剩餘：${availableSpots} 個名額`);

  const standbyList = await db.execute({
    sql: "SELECT id FROM registrations WHERE phase = 1 AND status = 'standby' ORDER BY created_at ASC"
  });
  const toPromote = standbyList.rows.slice(0, Math.max(0, availableSpots));
  if (toPromote.length > 0) {
    await db.batch(
      toPromote.map(r => ({ sql: "UPDATE registrations SET status = 'registered' WHERE id = ?", args: [r.id] })),
      'write'
    );
    console.log(`  ✓ 自動遞補 ${toPromote.length} 人`);
  } else {
    console.log(`  無候補可遞補`);
  }

  const remain = await db.execute({ sql: "SELECT COUNT(*) as cnt FROM registrations WHERE status = 'standby'" });
  console.log(`  剩餘候補：${remain.rows[0].cnt} 人`);

  // Cleanup
  db.close();
  try { fs.unlinkSync(DB_PATH); } catch(e) {}
  console.log(`\n✓ 測試完成`);
}

main().catch(err => { console.error(err); process.exit(1); });
