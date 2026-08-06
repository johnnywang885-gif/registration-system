const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'sim_185_30.db');
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.TURSO_DATABASE_URL = 'file:' + DB_PATH.replace(/\\/g, '/');
process.env.TURSO_AUTH_TOKEN = '';
process.env.JWT_SECRET = 'sim-secret';
process.env.PORT = '34904';

const BASE = 'http://127.0.0.1:34904';

const { getDb } = require('../database');
const bcrypt = require('bcryptjs');
const { taipeiToday } = require('../deadlines');

function pad(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); }

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

async function login(clubId, password) {
  const res = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clubId, password })
  });
  const data = await res.json();
  if (!data.token) throw new Error('login failed for ' + clubId + ': ' + JSON.stringify(data));
  return data.token;
}

async function api(method, url, { token, body } = {}) {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

async function regBatch(clubId, n, prefix) {
  const token = await login(clubId, String(clubId).slice(-4));
  let standby = 0;
  for (let i = 1; i <= n; i++) {
    const r = await api('POST', '/api/registrations', { token, body: { name: `${prefix}${i}`, position: '會友' } });
    if (r.status !== 200) throw new Error(`club ${clubId} reg ${i} failed: ` + JSON.stringify(r.data));
    if (r.data.message.includes('候補')) standby++;
  }
  return { total: n, registered: n - standby, standby };
}

async function triggerEnforcement() {
  await new Promise(r => setTimeout(r, 5100));
  await fetch(`${BASE}/api/summary`);
  await new Promise(r => setTimeout(r, 800));
}

async function perClub() {
  const db = getDb();
  const res = await db.execute({
    sql: `SELECT c.club_id, c.club_name,
            SUM(CASE WHEN r.phase = 1 AND r.status = 'registered' THEN 1 ELSE 0 END) AS p1_reg,
            SUM(CASE WHEN r.phase = 1 AND r.status = 'standby' THEN 1 ELSE 0 END) AS p1_std,
            SUM(CASE WHEN r.phase = 1 AND r.status = 'paid' THEN 1 ELSE 0 END) AS p1_paid,
            SUM(CASE WHEN r.phase = 1 AND r.status = 'forfeited' THEN 1 ELSE 0 END) AS p1_forf,
            SUM(CASE WHEN r.phase = 2 AND r.status = 'registered' THEN 1 ELSE 0 END) AS p2_reg,
            SUM(CASE WHEN r.phase = 2 AND r.status = 'standby' THEN 1 ELSE 0 END) AS p2_std
          FROM clubs c LEFT JOIN registrations r ON c.club_id = r.club_id
          WHERE c.is_admin = 0
          GROUP BY c.club_id, c.club_name
          ORDER BY c.club_id`
  });
  return res.rows.map(r => ({
    id: r.club_id,
    name: r.club_name,
    p1_reg: Number(r.p1_reg), p1_std: Number(r.p1_std), p1_paid: Number(r.p1_paid), p1_forf: Number(r.p1_forf),
    p2_reg: Number(r.p2_reg), p2_std: Number(r.p2_std)
  }));
}

async function printTable(title, rows) {
  console.log('\n' + title);
  console.log('  ' + pad('社號', 7) + pad('社名', 8) + pad('一階正式', 8) + pad('一階候補', 8) + pad('一階已繳', 8) + pad('一階棄權', 8) + pad('二階已報', 8) + pad('二階候補', 8));
  let t = { p1_reg: 0, p1_std: 0, p1_paid: 0, p1_forf: 0, p2_reg: 0, p2_std: 0 };
  for (const r of rows) {
    console.log('  ' + pad(r.id, 7) + pad(r.name, 8) + pad(r.p1_reg, 8) + pad(r.p1_std, 8) + pad(r.p1_paid, 8) + pad(r.p1_forf, 8) + pad(r.p2_reg, 8) + pad(r.p2_std, 8));
    t.p1_reg += r.p1_reg; t.p1_std += r.p1_std; t.p1_paid += r.p1_paid; t.p1_forf += r.p1_forf; t.p2_reg += r.p2_reg; t.p2_std += r.p2_std;
  }
  console.log('  ' + pad('合計', 7) + pad('', 8) + pad(t.p1_reg, 8) + pad(t.p1_std, 8) + pad(t.p1_paid, 8) + pad(t.p1_forf, 8) + pad(t.p2_reg, 8) + pad(t.p2_std, 8));
  const confirmed = t.p1_reg + t.p1_paid + t.p2_reg;
  console.log(`\n  確認名額 (occupancy) = ${confirmed} / 160`);
  console.log(`  剩餘名額 = ${Math.max(0, 160 - confirmed)}`);
  console.log(`  候補總人數 = ${t.p1_std + t.p2_std}（一階 ${t.p1_std} + 二階 ${t.p2_std}）`);
}

async function standbyQueue() {
  const db = getDb();
  const res = await db.execute({
    sql: `SELECT r.id, r.club_id, c.club_name, r.name, r.phase, r.created_at
          FROM registrations r JOIN clubs c ON r.club_id = c.club_id
          WHERE r.status = 'standby' ORDER BY r.created_at ASC, r.id ASC`
  });
  console.log('\n候補名單（依報名時間先後）：');
  if (res.rows.length === 0) { console.log('  （無）'); return; }
  for (const r of res.rows) {
    const t = new Date(r.created_at + 'Z').toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    console.log(`  ${r.club_id} ${r.club_name} ${r.name}（第${r.phase}階段，${t}）`);
  }
}

async function setDeadlines(paymentDeadline) {
  const db = getDb();
  await db.batch([
    { sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", args: ['phase1_deadline', '2026-07-31'] },
    { sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", args: ['payment_deadline', paymentDeadline] },
    { sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", args: ['phase2_deadline', '2026-10-20'] },
    { sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", args: ['guaranteed_quota', '10'] },
    { sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", args: ['phase1_total_quota', '160'] }
  ], 'write');
}

async function main() {
  require('../server');
  await waitDbReady();
  const db = getDb();

  console.log('==== 模擬設定 ====');
  console.log('今天(台北) = ' + taipeiToday());
  console.log('第一階段截止 = 2026-07-31、第二階段截止 = 2026-10-20（繳費截止按階段調整）');
  console.log('第一階段報名人數 = 185（160 正式 + 25 候補）');
  console.log('  5 個大社（2401-2405）各報 15 人 → 每社超過保障 10 人，各 5 人候補');
  console.log('  20 個中社（2406-2425）各報 4 人、6 個小社（2426-2431）各報 5 人');
  console.log('繳費狀態：2401-2403、2406-2425（23 社）已繳費；2404-2405、2426-2431（8 社）未繳費\n');

  await setDeadlines('2026-08-31');

  const clubs = [];
  for (let i = 2401; i <= 2431; i++) clubs.push([i, '社' + i]);
  await db.batch(clubs.map(([id, name]) => ({
    sql: "INSERT INTO clubs (club_id, club_name, password, is_admin) VALUES (?, ?, ?, 0)",
    args: [id, name, bcrypt.hashSync(String(id).slice(-4), 10)]
  })), 'write');

  const stmts = [];
  for (let i = 2401; i <= 2405; i++) {
    for (let j = 1; j <= 10; j++) stmts.push({ sql: "INSERT INTO registrations (club_id, name, phase, status) VALUES (?, ?, 1, 'registered')", args: [i, `${i}正式${j}`] });
    for (let j = 1; j <= 5; j++) stmts.push({ sql: "INSERT INTO registrations (club_id, name, phase, status) VALUES (?, ?, 1, 'standby')", args: [i, `${i}候補${j}`] });
  }
  for (let i = 2406; i <= 2425; i++) {
    for (let j = 1; j <= 4; j++) stmts.push({ sql: "INSERT INTO registrations (club_id, name, phase, status) VALUES (?, ?, 1, 'registered')", args: [i, `${i}正式${j}`] });
  }
  for (let i = 2426; i <= 2431; i++) {
    for (let j = 1; j <= 5; j++) stmts.push({ sql: "INSERT INTO registrations (club_id, name, phase, status) VALUES (?, ?, 1, 'registered')", args: [i, `${i}正式${j}`] });
  }
  await db.batch(stmts, 'write');

  const paidClubs = [];
  for (let i = 2401; i <= 2403; i++) paidClubs.push(i);
  for (let i = 2406; i <= 2425; i++) paidClubs.push(i);
  await db.batch(paidClubs.map(id => ({
    sql: "INSERT INTO payment_proofs (club_id, file_path, file_type, status) VALUES (?, ?, ?, 'approved')",
    args: [id, `/uploads/payments/${id}.png`, 'image']
  })), 'write');

  console.log('① 第一階段報名截止後（185 人，全員尚未被棄權）：');
  let rows = await perClub();
  await printTable('  期程：一階截止 ~ 繳費截止（enforcement 遞補：名額已滿 160 → 無人遞補）', rows);

  console.log('\n② 繳費截止日已過 → 50 人未繳費棄權（2 大社 × 10 + 6 小社 × 5）＋ 自動遞補已繳費社的一階候補：');
  await setDeadlines('2026-08-01');
  await triggerEnforcement();
  rows = await perClub();
  await printTable('  棄權與遞補後', rows);

  console.log('\n③ 第二階段報名 30 人（2404、2405 兩社各 15 人）：');
  await regBatch(2404, 15, '二階甲');
  await regBatch(2405, 15, '二階乙');

  console.log('\n==== 最終結果 ====');
  rows = await perClub();
  await printTable('各社團最終狀態', rows);
  await standbyQueue();

  const occ = await db.execute({ sql: "SELECT COUNT(*) as cnt FROM registrations WHERE status IN ('registered','paid')" });
  const totalStd = await db.execute({ sql: "SELECT COUNT(*) as cnt FROM registrations WHERE status = 'standby'" });
  console.log(`\n  確認名額 ${Number(occ.rows[0].cnt)}/160、剩餘 ${160 - Number(occ.rows[0].cnt)}、候補 ${Number(totalStd.rows[0].cnt)} 人`);
  console.log('  預期：155/160、剩 5、候補 10 人（2404/2405 一階候補，未繳費社永不自動遞補）');
  const ok = Number(occ.rows[0].cnt) === 155 && Number(totalStd.rows[0].cnt) === 10;
  console.log(ok ? '\n全部階段 PASS' : '\nFAIL');

  console.log('\nSIM_185_READY on ' + BASE + ' (DB kept for browser verification)');
  setInterval(() => {}, 1 << 30);
}

main().catch(err => { console.error(err); process.exit(1); });
