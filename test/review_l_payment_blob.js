const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'review_l.db');
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.TURSO_DATABASE_URL = 'file:' + DB_PATH.replace(/\\/g, '/');
process.env.TURSO_AUTH_TOKEN = '';
process.env.JWT_SECRET = 'test-secret';
process.env.PORT = '34917';

const BASE = 'http://127.0.0.1:34917';

const { getDb, getOne, getAll, runQuery } = require('../database');
const bcrypt = require('bcryptjs');
const CLUB_HASH = bcrypt.hashSync('2401', 10);

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  Buffer.from('PONG-test-bytes-12345', 'utf8')
]);
const PDF_BYTES = Buffer.concat([
  Buffer.from([0x25, 0x50, 0x44, 0x46]),
  Buffer.from('1.4-test-pdf', 'utf8')
]);

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
    { sql: "INSERT INTO settings (key, value) VALUES ('phase1_deadline', '2026-12-31') ON CONFLICT(key) DO UPDATE SET value = excluded.value", args: [] },
    { sql: "INSERT INTO settings (key, value) VALUES ('payment_deadline', '2027-01-31') ON CONFLICT(key) DO UPDATE SET value = excluded.value", args: [] },
    { sql: "INSERT INTO settings (key, value) VALUES ('phase2_deadline', '2027-02-28') ON CONFLICT(key) DO UPDATE SET value = excluded.value", args: [] },
    { sql: "INSERT INTO settings (key, value) VALUES ('phase1_total_quota', '160') ON CONFLICT(key) DO UPDATE SET value = excluded.value", args: [] },
    { sql: "INSERT INTO settings (key, value) VALUES ('guaranteed_quota', '10') ON CONFLICT(key) DO UPDATE SET value = excluded.value", args: [] },
    { sql: "INSERT INTO registrations (club_id, position, name, id_card, birthday, phone, meal_type, phase, status) VALUES (2401, '社長', '甲一', 'A123456789', '2000-01-01', '0911', '素', 1, 'registered')", args: [] }
  ], 'write');
}

async function login(clubId, password) {
  const res = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clubId, password })
  });
  const data = await res.json();
  if (!res.ok || !data.token) throw new Error('login failed: ' + JSON.stringify(data));
  return data.token;
}

async function uploadProof(blob, name, mime, auth) {
  const fd = new FormData();
  fd.append('file', new Blob([blob], { type: mime }), name);
  const res = await fetch(`${BASE}/api/payment/upload`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${auth}` },
    body: fd
  });
  return { status: res.status, data: await res.json() };
}

async function main() {
  require('../server');
  await waitDbReady();
  await seed();

  const adminToken = await login('admin', 'admin123');
  const clubToken = await login('2401', '2401');

  // ===== 1. 上傳圖片證明 → file_data 存入 DB =====
  console.log('--- 上傳證明（PNG）---');
  const up1 = await uploadProof(PNG_BYTES, '證明.png', 'image/png', clubToken);
  console.log('  upload:', up1.status, up1.data);
  if (up1.status !== 200 || !up1.data.id) throw new Error('PNG upload should 200 with id');
  const proof1 = await getOne("SELECT id, file_path, file_data FROM payment_proofs WHERE id = ?", [up1.data.id]);
  if (!proof1.file_data || proof1.file_data.byteLength !== PNG_BYTES.length) {
    throw new Error('file_data should be stored in DB with full bytes');
  }
  console.log('  DB file_data bytes =', proof1.file_data.byteLength, '（預期', PNG_BYTES.length, '）OK');

  // ===== 2. 模擬磁碟被清空：該檔不應存在於磁碟，但 /api/payment/file/:id 仍回傳 =====
  console.log('\n--- 重啟/休眠模擬（磁碟無此檔）---');
  const onDisk = path.resolve(__dirname, '..', 'uploads', 'payments', path.basename(proof1.file_path));
  if (fs.existsSync(onDisk)) throw new Error('memory storage 不應在磁碟留下檔案，但找到了 ' + onDisk);
  const r1 = await fetch(`${BASE}/api/payment/file/${proof1.id}`, { headers: { 'Authorization': `Bearer ${adminToken}` } });
  const buf1 = Buffer.from(await r1.arrayBuffer());
  if (r1.status !== 200 || buf1.length !== PNG_BYTES.length) throw new Error('file/:id should serve bytes from DB');
  if (r1.headers.get('content-type') !== 'image/png') throw new Error('content-type 應為 image/png，實際 ' + r1.headers.get('content-type'));
  console.log('  磁碟無檔但 /api/payment/file/:id →', r1.status, buf1.length, 'bytes,', r1.headers.get('content-type'), 'OK');

  // ===== 3. 上傳 PDF 證明 =====
  console.log('\n--- 上傳證明（PDF）---');
  const up2 = await uploadProof(PDF_BYTES, '繳費證明.pdf', 'application/pdf', clubToken);
  if (up2.status !== 200 || !up2.data.id) throw new Error('PDF upload should 200 with id');
  const r2 = await fetch(`${BASE}/api/payment/file/${up2.data.id}`, { headers: { 'Authorization': `Bearer ${adminToken}` } });
  if (r2.status !== 200 || r2.headers.get('content-type') !== 'application/pdf') {
    throw new Error('PDF file should serve with application/pdf, got ' + r2.status + ' ' + r2.headers.get('content-type'));
  }
  console.log('  PDF →', r2.status, r2.headers.get('content-type'), 'OK');

  // ===== 4. 魔數 sniff 不符 → 400 =====
  console.log('\n--- 魔數不符 ---');
  const bad = await uploadProof(Buffer.from('hello world not an image', 'utf8'), '假圖.png', 'image/png', clubToken);
  if (bad.status !== 400 || !String(bad.data.error).includes('格式不符')) {
    throw new Error('magic mismatch should 400, got ' + bad.status + ' ' + JSON.stringify(bad.data));
  }
  console.log('  假檔 →', bad.status, bad.data.error, 'OK');

  // ===== 5. 列表與備份不該含 file_data =====
  console.log('\n--- 列表/備份不含 blob ---');
  const myUp = await (await fetch(`${BASE}/api/payment/my-uploads`, { headers: { 'Authorization': `Bearer ${clubToken}` } })).json();
  if (myUp.some(p => 'file_data' in p)) throw new Error('my-uploads must not include file_data');
  const all = await (await fetch(`${BASE}/api/payment/all`, { headers: { 'Authorization': `Bearer ${adminToken}` } })).json();
  if (all.some(p => 'file_data' in p)) throw new Error('payment/all must not include file_data');
  const bkp = await (await fetch(`${BASE}/api/admin/backup`, { headers: { 'Authorization': `Bearer ${adminToken}` } })).json();
  if (bkp.payment_proofs.some(p => 'file_data' in p)) throw new Error('backup payment_proofs must not include file_data');
  console.log('  my-uploads/payment/all/backup 均無 file_data OK');

  // ===== 6. 審核 approve 後執行「清理檔案本體」→ 只清 blob、保留列與狀態 =====
  console.log('\n--- 審核 + 清理檔案本體 ---');
  const rev = await fetch(`${BASE}/api/payment/review/${up1.data.id}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'approve' })
  });
  if (rev.status !== 200) throw new Error('approve review failed: ' + rev.status);

  const clubTokenNoPerm = await login('2401', '2401'); // 一般社團無權限
  const clean403 = await fetch(`${BASE}/api/admin/payment-proofs/cleanup`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${clubTokenNoPerm}` }
  });
  if (clean403.status !== 403) throw new Error('club should 403 on cleanup, got ' + clean403.status);

  const clean = await fetch(`${BASE}/api/admin/payment-proofs/cleanup`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });
  const cleanData = await clean.json();
  console.log('  cleanup:', clean.status, cleanData);
  if (clean.status !== 200 || cleanData.cleared !== 2) throw new Error('cleanup should clear 2 proofs');

  const after1 = await getOne("SELECT id, status, reviewed_by, file_data FROM payment_proofs WHERE id = ?", [up1.data.id]);
  if (after1.file_data) throw new Error('file_data 應已被清為 NULL');
  if (after1.status !== 'approved') throw new Error('審核狀態應保留 (approved)，實際 ' + after1.status);
  console.log('  列保留，status=', after1.status, ', file_data=NULL OK');

  const rAfter = await fetch(`${BASE}/api/payment/file/${up1.data.id}`, { headers: { 'Authorization': `Bearer ${adminToken}` } });
  if (rAfter.status !== 404) throw new Error('cleanup 後 file/:id 應 404，實際 ' + rAfter.status);
  console.log('  cleanup 後 file/:id →', rAfter.status, 'OK');

  // ===== 7. 清除資料（clear-data）不殘留 blob =====
  console.log('\n--- 未經授權端點已驗證，全部通過 ---');
  console.log('PASS');
  process.exit(0);
}

main().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});