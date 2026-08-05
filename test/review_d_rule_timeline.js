const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'review_d.db');
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.TURSO_DATABASE_URL = 'file:' + DB_PATH.replace(/\\/g, '/');
process.env.TURSO_AUTH_TOKEN = '';
process.env.JWT_SECRET = 'test-secret';
process.env.PORT = '34892';

const BASE = 'http://127.0.0.1:34892';

const { getDb } = require('../database');
const { taipeiToday } = require('../deadlines');

let adminToken = null;

function check(cond, msg) {
  if (!cond) throw new Error('ASSERT FAIL: ' + msg);
  console.log('  PASS: ' + msg);
}

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

async function api(method, url, { token, body, form } = {}) {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  let payload;
  if (form) {
    payload = form;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + url, { method, headers, body: payload });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

async function adminApi(method, url, opts = {}) {
  if (!adminToken) adminToken = await login('admin', 'admin123');
  return api(method, url, { ...opts, token: adminToken });
}

async function setSettings(s) {
  return adminApi('PUT', '/api/admin/settings', {
    body: {
      phase1_deadline: s.phase1_deadline,
      payment_deadline: s.payment_deadline,
      phase2_deadline: s.phase2_deadline,
      guaranteed_quota: s.guaranteed_quota,
      phase1_total_quota: s.phase1_total_quota
    }
  });
}

async function trigger() {
  await fetch(`${BASE}/api/summary`);
}

async function counts(clubId) {
  const db = getDb();
  const res = await db.execute({
    sql: "SELECT phase, status, COUNT(*) as cnt FROM registrations WHERE club_id = ? GROUP BY phase, status",
    args: [clubId]
  });
  const m = {};
  res.rows.forEach(r => { m[`p${r.phase}_${r.status}`] = Number(r.cnt); });
  return m;
}

async function occupancy() {
  const db = getDb();
  const res = await db.execute({
    sql: "SELECT COUNT(*) as cnt FROM registrations WHERE status IN ('registered', 'paid')"
  });
  return Number(res.rows[0].cnt);
}

function stage(title) {
  console.log('\n===== ' + title + ' =====');
}

async function seedClubs(list) {
  const db = getDb();
  const bcrypt = require('bcryptjs');
  await db.batch(list.map(c => ({
    sql: "INSERT OR REPLACE INTO clubs (club_id, club_name, password, is_admin) VALUES (?, ?, ?, 0)",
    args: [c.id, c.name, bcrypt.hashSync(String(c.id).slice(-4), 10)]
  })), 'write');
}

async function main() {
  require('../server');
  await waitDbReady();
  const db = getDb();

  console.log('today = ' + taipeiToday());

  await seedClubs([
    { id: 2401, name: '眉溪' },
    { id: 2402, name: '鹿谷' },
    { id: 2406, name: '水沙連' }
  ]);

  // ---------- Stage 1: Phase 1 open (defaults: p1=2026-09-20 pay=2026-09-30 p2=2026-10-20) ----------
  stage('1) 第一階段報名中（預設設定）');
  const t1 = await login(2401, '2401');
  for (let i = 1; i <= 15; i++) {
    const r = await api('POST', '/api/registrations', { token: t1, body: { name: '人員' + i, position: '理事' } });
    if (r.status !== 200) throw new Error('2401 reg failed at ' + i + ': ' + JSON.stringify(r.data));
  }
  const t2 = await login(2402, '2402');
  for (let i = 1; i <= 3; i++) {
    const r = await api('POST', '/api/registrations', { token: t2, body: { name: 'B' + i, position: '理事' } });
    if (r.status !== 200) throw new Error('2402 reg failed at ' + i);
  }
  const c1s1 = await counts(2401);
  const c2s1 = await counts(2402);
  console.log('  2401 -> ' + JSON.stringify(c1s1));
  console.log('  2402 -> ' + JSON.stringify(c2s1));
  check(c1s1.p1_registered === 10 && c1s1.p1_standby === 5, '2401 超過保障名額 → 10 registered + 5 standby');
  check(c2s1.p1_registered === 3, '2402 3 人 registered');
  check(await occupancy() === 13, '占用 13 名額');

  // ---------- Stage 2: Phase 1 closed -> promote ALL phase-1 standby ----------
  stage('2) 第一階段截止 → 截止後~繳費截止：自動遞補所有第一階段候補');
  await setSettings({ phase1_deadline: '2026-08-01', payment_deadline: '2026-09-25', phase2_deadline: '2026-10-20', guaranteed_quota: '10', phase1_total_quota: '160' });
  await trigger();
  const c1s2 = await counts(2401);
  console.log('  2401 -> ' + JSON.stringify(c1s2));
  check(c1s2.p1_registered === 15 && !c1s2.p1_standby, '2401 候補全數遞補為 registered');
  check(await occupancy() === 18, '占用 18 名額');

  // ---------- Stage 3: Payment approval (still phase1_closed) ----------
  stage('3) 2401 上傳繳費證明 → 管理員核准 → 全部標記 paid');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), 'proof.png');
  form.append('registration_id', '');
  const up = await api('POST', '/api/payment/upload', { token: t1, form });
  if (up.status !== 200) throw new Error('upload failed: ' + JSON.stringify(up.data));
  const review = await adminApi('PUT', `/api/payment/review/${up.data.id}`, { body: { action: 'approve' } });
  if (review.status !== 200) throw new Error('review failed: ' + JSON.stringify(review.data));
  const c1s3 = await counts(2401);
  console.log('  2401 -> ' + JSON.stringify(c1s3));
  check(c1s3.p1_paid === 15, '2401 全部 15 人標記為 paid');

  // ---------- Stage 4: After payment deadline -> forfeit unpaid phase-1 ----------
  stage('4) 繳費截止已過 → 未繳費社團第一階段 registered 棄權');
  await setSettings({ phase1_deadline: '2026-08-01', payment_deadline: '2026-08-01', phase2_deadline: '2026-10-20', guaranteed_quota: '10', phase1_total_quota: '160' });
  await trigger();
  const c1s4 = await counts(2401);
  const c2s4 = await counts(2402);
  console.log('  2401 -> ' + JSON.stringify(c1s4));
  console.log('  2402 -> ' + JSON.stringify(c2s4));
  check(c1s4.p1_paid === 15, '已繳費 2401 不受影響');
  check(c2s4.p1_forfeited === 3, '未繳費 2402 全部棄權');

  // ---------- Stage 5: Overflow at 160 -> paid-club standby promoted, unpaid-club standby stay ----------
  stage('5) 第一階段名額滿 160 的溢流情境：已繳費社團候補遞補、未繳費社團候補保留');
  await seedClubs([{ id: 2403, name: '已繳溢流社' }, { id: 2404, name: '未繳溢流社' }, { id: 2405, name: '填充社' }]);
  const stmts = [];
  for (let i = 1; i <= 10; i++) stmts.push({ sql: "INSERT INTO registrations (club_id, name, phase, status) VALUES (?, ?, 1, 'registered')", args: [2403, 'P3-R' + i] });
  for (let i = 1; i <= 5; i++) stmts.push({ sql: "INSERT INTO registrations (club_id, name, phase, status) VALUES (?, ?, 1, 'standby')", args: [2403, 'P3-S' + i] });
  for (let i = 1; i <= 5; i++) stmts.push({ sql: "INSERT INTO registrations (club_id, name, phase, status) VALUES (?, ?, 1, 'registered')", args: [2404, 'P4-R' + i] });
  for (let i = 1; i <= 2; i++) stmts.push({ sql: "INSERT INTO registrations (club_id, name, phase, status) VALUES (?, ?, 1, 'standby')", args: [2404, 'P4-S' + i] });
  for (let i = 1; i <= 130; i++) stmts.push({ sql: "INSERT INTO registrations (club_id, name, phase, status) VALUES (?, ?, 1, 'registered')", args: [2405, 'F' + i] });
  await db.batch(stmts, 'write');
  await db.execute({
    sql: "INSERT INTO payment_proofs (club_id, file_path, file_type, status) VALUES (?, ?, ?, 'approved')",
    args: [2403, '/uploads/payments/2403.png', 'image']
  });
  check(await occupancy() === 160, '名額剛好滿 160（15 已繳費 + 10 + 5 + 130 = 160）');

  await trigger();
  const c3s5 = await counts(2403);
  const c4s5 = await counts(2404);
  const c5s5 = await counts(2405);
  console.log('  2403 -> ' + JSON.stringify(c3s5));
  console.log('  2404 -> ' + JSON.stringify(c4s5));
  console.log('  2405 -> ' + JSON.stringify(c5s5));
  check(c3s5.p1_registered === 15 && !c3s5.p1_standby, '已繳費 2403 的 5 名候補全數遞補（未繳費的棄權空出名額）');
  check(c4s5.p1_forfeited === 5 && c4s5.p1_standby === 2, '未繳費 2404：5 registered 棄權、2 候補保留');
  check(c5s5.p1_forfeited === 130, '未繳費填充 2405：130 人棄權');
  check(await occupancy() === 30, '占用回到 30（15 已繳費 + 15 遞補後）');

  // ---------- Stage 6: Phase 2 registration while occupancy < 160 -> registered ----------
  stage('6) 第二階段報名（名額未滿）→ 直接 registered，phase=2');
  await db.execute({
    sql: "INSERT INTO payment_proofs (club_id, file_path, file_type, status) VALUES (?, ?, ?, 'approved')",
    args: [2406, '/uploads/payments/2406.png', 'image']
  });
  const t6 = await login(2406, '2406');
  const reg6 = await api('POST', '/api/registrations', { token: t6, body: { name: '二階段A', position: '會長' } });
  if (reg6.status !== 200) throw new Error('2406 reg failed: ' + JSON.stringify(reg6.data));
  const c6s6 = await counts(2406);
  console.log('  2406 -> ' + JSON.stringify(c6s6));
  check(c6s6.p2_registered === 1, '2406 第二階段報名 → registered（phase=2）');

  // ---------- Stage 7: Fill to 160 -> phase-2 standby, no auto-promote, manual promote only ----------
  stage('7) 名額滿 160 → 第二階段報名為候補；不自動遞補；手動遞補受名額限制');
  const fill = [];
  for (let i = 1; i <= 129; i++) fill.push({ sql: "INSERT INTO registrations (club_id, name, phase, status) VALUES (?, ?, 2, 'registered')", args: [2405, 'P2-F' + i] });
  await db.batch(fill, 'write');
  check(await occupancy() === 160, '名額補滿 160');

  const reg7 = await api('POST', '/api/registrations', { token: t6, body: { name: '二階段B', position: '會長' } });
  if (reg7.status !== 200) throw new Error('2406 2nd reg failed: ' + JSON.stringify(reg7.data));
  check(reg7.data.message === '報名成功（候補）', '2406 第二階段報名 → 候補（名額已滿）');
  let c6s7 = await counts(2406);
  check(c6s7.p2_standby === 1 && c6s7.p2_registered === 1, '2406 現在 1 registered + 1 standby');

  for (let i = 0; i < 3; i++) await trigger();
  c6s7 = await counts(2406);
  check(c6s7.p2_standby === 1, '重複觸發 enforcement → 第二階段候補不被自動遞補');

  const standbyIdRes = await db.execute({
    sql: "SELECT id FROM registrations WHERE club_id = ? AND status = 'standby' ORDER BY id DESC LIMIT 1",
    args: [2406]
  });
  const standbyId = Number(standbyIdRes.rows[0].id);
  const blocked = await adminApi('POST', `/api/admin/promote/${standbyId}`);
  check(blocked.status === 400 && blocked.data.error.includes('名額已滿'), '名額滿時手動遞補被拒絕');

  await setSettings({ phase1_deadline: '2026-08-01', payment_deadline: '2026-08-01', phase2_deadline: '2026-08-01', guaranteed_quota: '10', phase1_total_quota: '160' });
  await trigger();
  const c5s7 = await counts(2405);
  const c6s7b = await counts(2406);
  console.log('  2405 -> ' + JSON.stringify(c5s7));
  console.log('  2406 -> ' + JSON.stringify(c6s7b));
  check(c5s7.p2_forfeited === 129, '第二階段截止後未繳費 registered 棄權');
  check(c6s7b.p2_standby === 1, '第二階段候補未被棄權（standby 不計名額）');
  check(c6s7b.p2_registered === 1, '已繳費 2406 的 registered 不受棄權影響');

  const promote = await adminApi('POST', `/api/admin/promote/${standbyId}`);
  check(promote.status === 200, '名額空出後手動遞補成功');
  const c6final = await counts(2406);
  console.log('  2406 final -> ' + JSON.stringify(c6final));
  check(!c6final.p2_standby && c6final.p2_registered === 2, '2406 全部變為 registered');

  // ---------- Cleanup ----------
  console.log('\n全部階段 PASS');
  const uploadsDir = path.join(__dirname, '..', 'uploads', 'payments');
  if (fs.existsSync(uploadsDir)) {
    for (const f of fs.readdirSync(uploadsDir)) {
      if (f.startsWith('payment_2401_')) fs.unlinkSync(path.join(uploadsDir, f));
    }
  }
  db.close();
  try { fs.unlinkSync(DB_PATH); } catch (e) {}
  setTimeout(() => process.exit(0), 150);
}

main().catch(err => { console.error(err); process.exit(1); });
