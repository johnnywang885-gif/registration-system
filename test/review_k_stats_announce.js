const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'review_k.db');
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.TURSO_DATABASE_URL = 'file:' + DB_PATH.replace(/\\/g, '/');
process.env.TURSO_AUTH_TOKEN = '';
process.env.JWT_SECRET = 'test-secret';
process.env.PORT = '34916';
delete process.env.LINE_CHANNEL_ACCESS_TOKEN;

const BASE = 'http://127.0.0.1:34916';

const { getDb, getOne, getAll, runQuery } = require('../database');
const bcrypt = require('bcryptjs');
const CLUB_HASH = bcrypt.hashSync('2401', 10);
const { dayMultiple5, buildStatsMessage, sendStatsAnnounce } = require('../stats_announce');
const { runEnforcement } = require('../deadlines');

async function waitDbReady() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/api/summary`);
      if (res.ok) return;
    } catch (e) {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('server / DB not ready in time');
}

async function seed() {
  const db = getDb();
  await db.batch([
    { sql: "INSERT INTO clubs (club_id, club_name, password, is_admin) VALUES (2401, '測試一社', ?, 0)", args: [CLUB_HASH] },
    { sql: "INSERT INTO clubs (club_id, club_name, password, is_admin) VALUES (2402, '測試二社', ?, 0)", args: [CLUB_HASH] },
    { sql: "INSERT INTO settings (key, value) VALUES ('phase1_deadline', '2026-12-31') ON CONFLICT(key) DO UPDATE SET value = excluded.value", args: [] },
    { sql: "INSERT INTO settings (key, value) VALUES ('payment_deadline', '2027-01-31') ON CONFLICT(key) DO UPDATE SET value = excluded.value", args: [] },
    { sql: "INSERT INTO settings (key, value) VALUES ('phase2_deadline', '2027-02-28') ON CONFLICT(key) DO UPDATE SET value = excluded.value", args: [] },
    { sql: "INSERT INTO settings (key, value) VALUES ('phase1_total_quota', '160') ON CONFLICT(key) DO UPDATE SET value = excluded.value", args: [] },
    { sql: "INSERT INTO settings (key, value) VALUES ('guaranteed_quota', '10') ON CONFLICT(key) DO UPDATE SET value = excluded.value", args: [] },
    { sql: "INSERT INTO registrations (club_id, position, name, id_card, birthday, phone, meal_type, phase, status) VALUES (2401, '社長', '甲一', 'A123456789', '2000-01-01', '0911', '素', 1, 'registered')", args: [] },
    { sql: "INSERT INTO registrations (club_id, position, name, id_card, birthday, phone, meal_type, phase, status) VALUES (2401, '社員', '甲二', 'B123456789', '2000-02-02', '0922', '葷', 1, 'registered')", args: [] },
    { sql: "INSERT INTO registrations (club_id, position, name, id_card, birthday, phone, meal_type, phase, status) VALUES (2402, '社長', '乙一', 'C123456789', '2000-03-03', '0933', '葷', 1, 'paid')", args: [] },
    { sql: "INSERT INTO registrations (club_id, position, name, id_card, birthday, phone, meal_type, phase, status) VALUES (2402, '社員', '乙二', 'D123456789', '2000-04-04', '0944', '素', 1, 'standby')", args: [] },
    { sql: "INSERT INTO registrations (club_id, position, name, id_card, birthday, phone, meal_type, phase, status) VALUES (2401, '社員', '甲三', 'E123456789', '2000-05-05', '0955', '葷', 1, 'forfeited')", args: [] },
    { sql: "INSERT INTO registrations (club_id, position, name, id_card, birthday, phone, meal_type, phase, status) VALUES (2402, '社員', '乙三', 'F123456789', '2000-06-06', '0966', '素', 2, 'registered')", args: [] },
    { sql: "INSERT INTO registrations (club_id, position, name, id_card, birthday, phone, meal_type, phase, status) VALUES (2402, '社員', '乙四', 'G123456789', '2000-07-07', '0977', '葷', 2, 'paid')", args: [] },
    { sql: "INSERT INTO registrations (club_id, position, name, id_card, birthday, phone, meal_type, phase, status) VALUES (2401, '社員', '甲四', 'H123456789', '2000-08-08', '0988', '素', 2, 'forfeited')", args: [] },
    { sql: "INSERT INTO payment_proofs (registration_id, club_id, file_path, file_type, file_name, status) VALUES (3, 2402, '/uploads/payments/x.png', 'image', 'x.png', 'approved')", args: [] }
  ], 'write');
}

async function main() {
  require('../server');
  await waitDbReady();
  await seed();

  // ===== 1. dayMultiple5 單元測試（5/10/15/20/25/30 為 true，其餘 false） =====
  console.log('--- dayMultiple5 ---');
  const cases = [
    ['2026-08-05', true], ['2026-08-10', true], ['2026-08-15', true], ['2026-08-20', true],
    ['2026-08-25', true], ['2026-08-30', true], ['2026-08-31', false], ['2026-08-04', false],
    ['2026-08-09', false], ['2026-02-28', false], ['2026-12-30', true], ['bad-date', false], ['', false]
  ];
  for (const [date, expect] of cases) {
    const got = dayMultiple5(date);
    console.log(`  ${date} → ${got}（期望 ${expect}）`);
    if (got !== expect) throw new Error(`dayMultiple5(${date}) 應為 ${expect}，實際 ${got}`);
  }

  // ===== 2. buildStatsMessage 內容 =====
  console.log('\n--- buildStatsMessage ---');
  const msg = await buildStatsMessage();
  console.log(msg);
  const checks = [
    ['第一階段：已報名 2 人（尚待繳費）、已繳費 1 人、候補 1 人、棄權 1 人', msg.includes('已報名 2 人（尚待繳費）、已繳費 1 人、候補 1 人、棄權 1 人')],
    ['繳費情形：已繳費社團 1 家、尚待繳費 2 人', msg.includes('已繳費社團 1 家、尚待繳費 2 人')],
    ['第二階段：已報名 2 人', msg.includes('第二階段：已報名 2 人')],
    ['總名額 160 人，目前正取 5 人，尚餘 155 人', msg.includes('總名額 160 人，目前正取 5 人，尚餘 155 人')]
  ];
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? 'OK' : 'FAIL'} ${label}`);
    if (!ok) throw new Error('buildStatsMessage 內容不符：' + label);
  }

  // ===== 3. 無 LINE 設定 → sendStatsAnnounce 優雅失敗且不寫 stats_announce_date =====
  console.log('\n--- sendStatsAnnounce（無 LINE 設定）---');
  const okChange = await sendStatsAnnounce('change');
  console.log('  change → ' + okChange);
  if (okChange !== false) throw new Error('無 LINE 設定時 sendStatsAnnounce 應回 false');
  const dateRow = await getOne("SELECT value FROM settings WHERE key = 'stats_announce_date'");
  if (dateRow) throw new Error('推送失敗時不應記錄 stats_announce_date');
  console.log('  推送失敗未記錄日期 OK');

  const okPeriodic = await sendStatsAnnounce('periodic');
  console.log('  periodic（今日為 5 倍數日）→ ' + okPeriodic + '（無 LINE 設定，應為 false 且不拋錯）');
  if (okPeriodic !== false) throw new Error('periodic 無 LINE 設定時應回 false');

  // ===== 4. 停用開關：stats_announce=off → 不發送 =====
  console.log('\n--- stats_announce=off 停用 ---');
  await runQuery("INSERT INTO settings (key, value) VALUES ('stats_announce', 'off') ON CONFLICT(key) DO UPDATE SET value = excluded.value", []);
  const off = await sendStatsAnnounce('change');
  console.log('  停用後 change → ' + off);
  if (off !== false) throw new Error('stats_announce=off 時不應發送');
  await runQuery("DELETE FROM settings WHERE key = 'stats_announce'", []);

  // ===== 5. 週期去重：當日已公告過（stats_announce_date=今天）→ periodic 不再發 =====
  console.log('\n--- periodic 去重 ---');
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
  if (dayMultiple5(today)) {
    await runQuery("INSERT INTO settings (key, value) VALUES ('stats_announce_date', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [today]);
    const dedup = await sendStatsAnnounce('periodic');
    console.log('  已公告過今日 → ' + dedup + '（應為 false，未嘗試推送）');
    if (dedup !== false) throw new Error('當日已公告過時 periodic 不應再發');
    console.log('  週期去重 OK');
  } else {
    console.log('  今日非 5 倍數日，跳過去重實測（邏輯由 dayMultiple5 單元測試守護）');
  }

  // ===== 6. 後端設定 PUT 白名單接受 stats_announce =====
  console.log('\n--- settings PUT stats_announce ---');
  const login = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clubId: 'admin', password: 'admin123' })
  });
  const { token } = await login.json();
  if (!token) throw new Error('admin login failed');
  const auth = { 'Authorization': `Bearer ${token}` };
  const putRes = await fetch(`${BASE}/api/admin/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ stats_announce: 'on' })
  });
  const putData = await putRes.json();
  console.log('  status=' + putRes.status + ' message=' + (putData.message || putData.error || ''));
  if (putRes.status !== 200) throw new Error('settings PUT 應接受 stats_announce');
  const getRes = await (await fetch(`${BASE}/api/admin/settings`, { headers: auth })).json();
  console.log('  讀回 stats_announce=' + getRes.stats_announce);
  if (getRes.stats_announce !== 'on') throw new Error('stats_announce 讀回值不符');

  // ===== 7. HTTP 報名異動會排程公告（不拋錯、報名成功） =====
  console.log('\n--- HTTP 報名（異動觸發）---');
  const clubLogin = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clubId: '2401', password: '2401' })
  });
  const clubAuth = { 'Authorization': `Bearer ${(await clubLogin.json()).token}` };
  const regRes = await fetch(`${BASE}/api/registrations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...clubAuth },
    body: JSON.stringify({ name: '新報名者' })
  });
  const regData = await regRes.json();
  console.log('  status=' + regRes.status + ' message=' + (regData.message || regData.error || ''));
  if (regRes.status !== 200) throw new Error('報名應成功');

  // ===== 8. runEnforcement 回傳 changed 旗標（未來截止日 → 無異動） =====
  console.log('\n--- runEnforcement changed 旗標 ---');
  const r1 = await runEnforcement();
  console.log('  未來截止日 → changed=' + r1.changed + '（應為 false）');
  if (r1.changed !== false) throw new Error('未來截止日不應有異動');
  // 把繳費截止日設為過去 → 未繳費 phase1 registered 會被棄權 → changed=true
  await runQuery("INSERT INTO settings (key, value) VALUES ('payment_deadline', '2026-01-01') ON CONFLICT(key) DO UPDATE SET value = excluded.value", []);
  await runQuery("INSERT INTO settings (key, value) VALUES ('phase2_deadline', '2026-02-28') ON CONFLICT(key) DO UPDATE SET value = excluded.value", []);
  const r2 = await runEnforcement();
  console.log('  繳費截止已過 → changed=' + r2.changed + '（應為 true，且已排程公告）');
  if (r2.changed !== true) throw new Error('逾期棄權應標記 changed=true');

  console.log('\nPASS');
  process.exit(0);
}

main().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});