const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'sim_phase2_144_30.db');
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.TURSO_DATABASE_URL = 'file:' + DB_PATH.replace(/\\/g, '/');
process.env.TURSO_AUTH_TOKEN = '';
process.env.JWT_SECRET = 'sim-secret';
process.env.PORT = '34893';

const BASE = 'http://127.0.0.1:34893';

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
  console.log(`  ${clubId} 報名 ${n} 人 → 成功 ${n - standby} 人 / 候補 ${standby} 人`);
  return { total: n, registered: n - standby, standby };
}

async function perClub() {
  const db = getDb();
  const res = await db.execute({
    sql: `SELECT c.club_id, c.club_name,
            SUM(CASE WHEN r.phase = 1 AND r.status = 'registered' THEN 1 ELSE 0 END) AS p1_reg,
            SUM(CASE WHEN r.phase = 1 AND r.status = 'standby' THEN 1 ELSE 0 END) AS p1_std,
            SUM(CASE WHEN r.phase = 1 AND r.status = 'paid' THEN 1 ELSE 0 END) AS p1_paid,
            SUM(CASE WHEN r.phase = 2 AND r.status = 'registered' THEN 1 ELSE 0 END) AS p2_reg,
            SUM(CASE WHEN r.phase = 2 AND r.status = 'standby' THEN 1 ELSE 0 END) AS p2_std,
            SUM(CASE WHEN r.phase = 2 AND r.status = 'forfeited' THEN 1 ELSE 0 END) AS p2_forf
          FROM clubs c LEFT JOIN registrations r ON c.club_id = r.club_id
          WHERE c.is_admin = 0
          GROUP BY c.club_id, c.club_name
          ORDER BY c.club_id`
  });
  return res.rows.map(r => ({
    id: r.club_id,
    name: r.club_name,
    p1_reg: Number(r.p1_reg), p1_std: Number(r.p1_std), p1_paid: Number(r.p1_paid),
    p2_reg: Number(r.p2_reg), p2_std: Number(r.p2_std), p2_forf: Number(r.p2_forf)
  }));
}

async function printTable(title, rows) {
  console.log('\n' + title);
  console.log('  ' + pad('社號', 7) + pad('社名', 8) + pad('一階已報', 8) + pad('一階候補', 8) + pad('一階已繳', 8) + pad('二階已報', 8) + pad('二階候補', 8));
  let t = { p1_reg: 0, p1_std: 0, p1_paid: 0, p2_reg: 0, p2_std: 0 };
  for (const r of rows) {
    console.log('  ' + pad(r.id, 7) + pad(r.name, 8) + pad(r.p1_reg, 8) + pad(r.p1_std, 8) + pad(r.p1_paid, 8) + pad(r.p2_reg, 8) + pad(r.p2_std, 8));
    t.p1_reg += r.p1_reg; t.p1_std += r.p1_std; t.p1_paid += r.p1_paid; t.p2_reg += r.p2_reg; t.p2_std += r.p2_std;
  }
  console.log('  ' + pad('合計', 7) + pad('', 8) + pad(t.p1_reg, 8) + pad(t.p1_std, 8) + pad(t.p1_paid, 8) + pad(t.p2_reg, 8) + pad(t.p2_std, 8));
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

async function main() {
  require('../server');
  await waitDbReady();
  const db = getDb();

  console.log('==== 模擬設定 ====');
  console.log('今天(台北) = ' + taipeiToday());
  console.log('第一階段截止 = 2026-07-31、繳費截止 = 2026-08-01、第二階段截止 = 2026-10-20');
  console.log('→ 現在處於「第二階段報名開放」時段（繳費截止已過）\n');

  await db.batch([
    { sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", args: ['phase1_deadline', '2026-07-31'] },
    { sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", args: ['payment_deadline', '2026-08-01'] },
    { sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", args: ['phase2_deadline', '2026-10-20'] },
    { sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", args: ['guaranteed_quota', '10'] },
    { sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", args: ['phase1_total_quota', '160'] }
  ], 'write');

  const phase1Clubs = [
    [2601, '草屯'], [2602, '國姓'], [2603, '中寮'], [2604, '名間'], [2605, '竹山'], [2606, '鹿谷'],
    [2607, '集集'], [2608, '水里'], [2609, '魚池'], [2610, '信義'], [2611, '仁愛'], [2612, '埔里'],
    [2613, '埔鹽'], [2614, '芬園'], [2615, '花壇']
  ];
  const phase2Clubs = [[2616, '和美'], [2617, '線西']];
  await db.batch(phase1Clubs.concat(phase2Clubs).map(([id, name]) => ({
    sql: "INSERT INTO clubs (club_id, club_name, password, is_admin) VALUES (?, ?, ?, 0)",
    args: [id, name, bcrypt.hashSync(String(id).slice(-4), 10)]
  })), 'write');

  console.log('第一階段正式報名 144 人（全部社團皆已通過繳費）：');
  const stmts = [];
  for (let i = 2601; i <= 2612; i++) for (let j = 1; j <= 10; j++) stmts.push({ sql: "INSERT INTO registrations (club_id, name, phase, status) VALUES (?, ?, 1, 'paid')", args: [i, `一階${j}`] });
  for (let j = 1; j <= 10; j++) stmts.push({ sql: "INSERT INTO registrations (club_id, name, phase, status) VALUES (?, ?, 1, 'paid')", args: [2613, `一階${j}`] });
  for (let j = 1; j <= 10; j++) stmts.push({ sql: "INSERT INTO registrations (club_id, name, phase, status) VALUES (?, ?, 1, 'paid')", args: [2614, `一階${j}`] });
  for (let j = 1; j <= 4; j++) stmts.push({ sql: "INSERT INTO registrations (club_id, name, phase, status) VALUES (?, ?, 1, 'paid')", args: [2615, `一階${j}`] });
  stmts.push({ sql: "INSERT INTO registrations (club_id, name, phase, status) VALUES (?, ?, 1, 'standby')", args: [2613, '一階候補1'] });
  stmts.push({ sql: "INSERT INTO registrations (club_id, name, phase, status) VALUES (?, ?, 1, 'standby')", args: [2613, '一階候補2'] });
  stmts.push({ sql: "INSERT INTO registrations (club_id, name, phase, status) VALUES (?, ?, 1, 'standby')", args: [2613, '一階候補3'] });
  stmts.push({ sql: "INSERT INTO registrations (club_id, name, phase, status) VALUES (?, ?, 1, 'standby')", args: [2614, '一階候補1'] });
  stmts.push({ sql: "INSERT INTO registrations (club_id, name, phase, status) VALUES (?, ?, 1, 'standby')", args: [2614, '一階候補2'] });
  stmts.push({ sql: "INSERT INTO registrations (club_id, name, phase, status) VALUES (?, ?, 1, 'standby')", args: [2614, '一階候補3'] });
  await db.batch(stmts, 'write');
  await db.batch(phase1Clubs.map(([id]) => ({
    sql: "INSERT INTO payment_proofs (club_id, file_path, file_type, status) VALUES (?, ?, ?, 'approved')",
    args: [id, `/uploads/payments/${id}.png`, 'image']
  })), 'write');

  let rows = await perClub();
  await printTable('① 第一階段結束時（144 正式 + 6 候補，未觸發期程轉換）', rows);

  console.log('\n② 第二階段開放後首次觸發期程檢查（enforcement）：');
  console.log('   → 未繳費社團棄權：無（一階社團全數已繳費）');
  console.log('   → 自動遞補「已繳費社團」的一階候補 6 人（優先於二階報名者）');
  await fetch(`${BASE}/api/summary`);
  rows = await perClub();
  await printTable('  遞補後狀態', rows);

  console.log('\n③ 第二階段報名 30 人（含上述 6 名一階繳費候補 + 新報名 24 人），依報名順序：');
  const club2613 = await regBatch(2613, 2, '二階A');
  const club2614 = await regBatch(2614, 2, '二階B');
  const club2616 = await regBatch(2616, 10, '二階C');
  const club2617 = await regBatch(2617, 10, '二階D');

  console.log('\n==== 最終結果 ====');
  rows = await perClub();
  await printTable('各社團最終狀態', rows);
  await standbyQueue();

  const db2 = getDb();
  const occ = await db2.execute({ sql: "SELECT COUNT(*) as cnt FROM registrations WHERE status IN ('registered','paid')" });
  const totalStd = await db2.execute({ sql: "SELECT COUNT(*) as cnt FROM registrations WHERE status = 'standby'" });
  console.log(`\n  確認名額 ${Number(occ.rows[0].cnt)}/160、剩餘 ${160 - Number(occ.rows[0].cnt)}、候補 ${Number(totalStd.rows[0].cnt)} 人`);
  console.log('  （第二階段 24 名新報名中：10 人遞入名額內、14 人進入候補名單）');

  db2.close();
  try { fs.unlinkSync(DB_PATH); } catch (e) {}
  setTimeout(() => process.exit(0), 150);
}

main().catch(err => { console.error(err); process.exit(1); });
