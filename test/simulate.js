const path = require('path');
const fs = require('fs');
const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'test_simulation.db');

const DEFAULT_CLUBS = [
  {club_id:2401,club_name:'眉溪'},{club_id:2402,club_name:'鹿谷'},{club_id:2403,club_name:'秀峰'},
  {club_id:2405,club_name:'竹山'},{club_id:2406,club_name:'中州'},{club_id:2407,club_name:'聖愛'},
  {club_id:2408,club_name:'羅娜'},{club_id:2409,club_name:'春陽'},{club_id:2410,club_name:'親愛'},
  {club_id:2412,club_name:'愛德'},{club_id:2413,club_name:'世光'},{club_id:2414,club_name:'華德'},
  {club_id:2415,club_name:'萬豐'},{club_id:2416,club_name:'主愛'},{club_id:2417,club_name:'敬宗'},
  {club_id:2419,club_name:'久美'},{club_id:2420,club_name:'武界'},{club_id:2421,club_name:'人倫'},
  {club_id:2422,club_name:'埔里'},{club_id:2423,club_name:'中正'},{club_id:2424,club_name:'芳蘭'},
  {club_id:2426,club_name:'豐丘'},{club_id:2427,club_name:'新鄉'},{club_id:2429,club_name:'望鄉'},
  {club_id:2430,club_name:'東埔'},{club_id:2432,club_name:'雙龍'},{club_id:2433,club_name:'潭南'},
  {club_id:2434,club_name:'雙豐'},{club_id:2436,club_name:'力行'},{club_id:2437,club_name:'十方'},
  {club_id:2439,club_name:'清流'}
];

const OVERSUBSCRIBED_IDS = [2401,2402,2403,2405,2406,2407,2408,2409,2410,2412];
const POSITIONS = ['理事','監事','聘任幹部','眷屬'];
const MEAL_TYPES = ['葷','素'];

let db, registrantIndex = 0;

async function setup() {
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  db = createClient({ url: `file:${DB_PATH}` });

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
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )`
  ], 'write');

  for (const c of DEFAULT_CLUBS) {
    const hash = bcrypt.hashSync(String(c.club_id).slice(-4), 10);
    await db.execute({
      sql: "INSERT INTO clubs (club_id, club_name, password, is_admin) VALUES (?, ?, ?, 0)",
      args: [c.club_id, c.club_name, hash]
    });
  }

  await db.batch([
    { sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", args: ['current_phase', '1'] },
    { sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", args: ['guaranteed_quota', '10'] },
    { sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", args: ['phase1_total_quota', '160'] }
  ], 'write');

  console.log(`✓ 已匯入 ${DEFAULT_CLUBS.length} 個社團（設定：保障 ${10} 人/社，總額 ${160} 人）\n`);
}

async function getSettings() {
  const rows = await db.execute("SELECT key, value FROM settings");
  const settings = {};
  rows.rows.forEach(s => { settings[s.key] = s.value; });
  return settings;
}

async function register(clubId, phase) {
  const idx = ++registrantIndex;
  const position = POSITIONS[Math.floor(Math.random() * POSITIONS.length)];
  const meal = MEAL_TYPES[Math.floor(Math.random() * MEAL_TYPES.length)];

  let newStatus = 'registered';
  if (phase === 1) {
    const phase1Count = await db.execute({
      sql: "SELECT COUNT(*) as cnt FROM registrations WHERE club_id = ? AND phase = 1 AND status != 'forfeited'",
      args: [clubId]
    });
    const guaranteedQuota = 10;
    if (phase1Count.rows[0].cnt >= guaranteedQuota) {
      newStatus = 'standby';
    }
  }

  await db.execute({
    sql: "INSERT INTO registrations (club_id, position, name, id_card, birthday, phone, meal_type, phase, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    args: [clubId, position, `測試人員${String(idx).padStart(3,'0')}`, `A${String(idx).padStart(8,'0')}`, '1990-01-01', `0912${String(idx).padStart(8,'0')}`, meal, phase, newStatus]
  });
  return { idx, newStatus };
}

async function showClubSummary() {
  const clubs = await db.execute(
    "SELECT c.club_id, c.club_name FROM clubs c WHERE c.is_admin = 0 ORDER BY c.club_id"
  );
  let totalReg = 0, totalStandby = 0;

  for (const club of clubs.rows) {
    const rows = await db.execute({
      sql: "SELECT status, COUNT(*) as cnt FROM registrations WHERE club_id = ? AND phase = 1 GROUP BY status",
      args: [club.club_id]
    });
    let reg = 0, stby = 0;
    for (const r of rows.rows) {
      if (r.status === 'registered') reg = Number(r.cnt);
      if (r.status === 'standby') stby = Number(r.cnt);
    }
    totalReg += reg; totalStandby += stby;
    const total = reg + stby;
    if (total > 0) {
      const parts = [];
      if (reg) parts.push(`已報名 ${reg}`);
      if (stby) parts.push(`候補 ${stby}`);
      const marker = stby > 0 ? ' ⚠超額' : '';
      console.log(`  ${club.club_id} ${String(club.club_name).padEnd(4)} ${String(total).padStart(3)} 人 (${parts.join(', ')})${marker}`);
    }
  }

  console.log('  ' + '─'.repeat(45));
  console.log(`  Phase 1 已報名: ${totalReg}`);
  console.log(`  Phase 1 候補:   ${totalStandby}`);
  console.log(`  Phase 1 總計:   ${totalReg + totalStandby}`);
  return { totalReg, totalStandby };
}

async function showStandbyList() {
  const list = await db.execute(`
    SELECT r.id, r.club_id, c.club_name, r.name, r.position, r.created_at
    FROM registrations r
    JOIN clubs c ON r.club_id = c.club_id
    WHERE r.phase = 1 AND r.status = 'standby'
    ORDER BY r.created_at ASC
  `);

  console.log(`\n========== 候補遞補順序名單（共 ${list.rows.length} 人） ==========`);
  console.log(`  順序  社號  社名    姓名        職稱      登記時間`);
  console.log(`  ${'─'.repeat(60)}`);

  for (let i = 0; i < list.rows.length; i++) {
    const s = list.rows[i];
    const ts = s.created_at ? new Date(s.created_at + 'Z').toLocaleString('zh-TW') : '-';
    console.log(`  ${String(i + 1).padStart(3)}  ${s.club_id}  ${String(s.club_name).padEnd(4)} ${String(s.name).padEnd(8)} ${String(s.position || '-').padEnd(8)} ${ts}`);
  }
  return list.rows.length;
}

async function simulate() {
  console.log('='.repeat(55));
  console.log('  區會報名系統 - 滿額候補模擬測試');
  console.log('='.repeat(55));
  console.log('');
  console.log('  【情境設定】');
  console.log('  • 可容納總人數：160 人');
  console.log('  • 總報名人數： 300 人');
  console.log('  • 保障名額：   10 人/社');
  console.log('  • 無法參加：   140 人 → 進入候補順序');
  console.log('');
  console.log('  【報名分布設計】');
  console.log('  • 10 社熱門社團：每社 24 人報名（10 正取 + 14 候補）');
  console.log('  • 21 社一般社團：每社約 2~3 人報名（全部正取）');
  console.log(`  ${'─'.repeat(55)}\n`);

  await setup();

  // ===== Phase 1: 300 registrations =====
  console.log('開始登記 Phase 1（300 人）...\n');

  const OVERSUBSCRIBED_COUNT = 24;  // 10 registered + 14 standby per oversubscribed club
  for (let i = 0; i < OVERSUBSCRIBED_COUNT; i++) {
    for (const cid of OVERSUBSCRIBED_IDS) {
      await register(cid, 1);
    }
  }

  // Remaining 21 clubs each get enough to make total of 60 registered
  const otherClubIds = DEFAULT_CLUBS.filter(c => !OVERSUBSCRIBED_IDS.includes(c.club_id)).map(c => c.club_id);
  // 60 registrations across 21 clubs: 18 clubs × 3, 3 clubs × 2
  for (let i = 0; i < otherClubIds.length; i++) {
    const count = i < 18 ? 3 : 2;
    for (let j = 0; j < count; j++) {
      await register(otherClubIds[i], 1);
    }
  }

  // ===== Summary =====
  const summary = await showClubSummary();

  // Verify
  console.log(`\n  ${'═'.repeat(45)}`);
  const expectedRegistered = 160, expectedStandby = 140;
  console.log(`  預期：${expectedRegistered} 已報名 + ${expectedStandby} 候補 = ${expectedRegistered + expectedStandby}`);
  console.log(`  實際：${summary.totalReg} 已報名 + ${summary.totalStandby} 候補 = ${summary.totalReg + summary.totalStandby}`);
  console.log(`  結果：${(summary.totalReg === expectedRegistered && summary.totalStandby === expectedStandby) ? '✓ 符合預期' : '✗ 不符預期'}`);
  console.log(`  ${'═'.repeat(45)}`);

  // ===== Standby list =====
  await showStandbyList();

  // ===== Simulate forfeit and promote =====
  console.log(`\n========== 模擬棄權遞補 ==========`);
  console.log('  情境：1 名已報名者棄權，自動遞補第 1 順位候補');

  // Pick a random registered person and mark as forfeited
  const forfeitTarget = await db.execute({
    sql: "SELECT id, club_id, name FROM registrations WHERE phase = 1 AND status = 'registered' LIMIT 1"
  });
  if (forfeitTarget.rows.length > 0) {
    const ft = forfeitTarget.rows[0];
    await db.execute({
      sql: "UPDATE registrations SET status = 'forfeited' WHERE id = ?",
      args: [ft.id]
    });
    console.log(`  • ${ft.name}（社號 ${ft.club_id}）已棄權 → 釋出名額 1 個`);

    // Get next standby from waitlist
    const nextStandby = await db.execute({
      sql: `SELECT r.id, r.club_id, c.club_name, r.name
            FROM registrations r
            JOIN clubs c ON r.club_id = c.club_id
            WHERE r.phase = 1 AND r.status = 'standby'
            ORDER BY r.created_at ASC LIMIT 1`
    });
    if (nextStandby.rows.length > 0) {
      const ns = nextStandby.rows[0];
      await db.execute({
        sql: "UPDATE registrations SET status = 'registered' WHERE id = ?",
        args: [ns.id]
      });
      console.log(`  • ${ns.name}（${ns.club_name}, 社號 ${ns.club_id}）遞補成功 ✓`);
    }

    // Show remaining standby count
    const remainingStandby = await db.execute({
      sql: "SELECT COUNT(*) as cnt FROM registrations WHERE phase = 1 AND status = 'standby'"
    });
    console.log(`  • 剩餘候補人數：${remainingStandby.rows[0].cnt} 人`);
  }

  // ===== Final summary =====
  const finalSummary = await showClubSummary();
  console.log(`\n  最終已報名：${finalSummary.totalReg} / 160 人`);
  console.log(`  最終候補：  ${finalSummary.totalStandby} 人（含遞補順序）`);

  // ===== Cleanup =====
  db.close();
  try {
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  } catch (e) {
    // ignore file lock
  }
  console.log(`\n✓ 測試完成`);
}

simulate().catch(err => {
  console.error('測試失敗:', err);
  process.exit(1);
});
