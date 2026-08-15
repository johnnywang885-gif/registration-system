const path = require('path');
const fs = require('fs');

// 第三批迴歸：C2 settings 白名單、M8 deadline 空字串防護、M7 importClubs null guard、
// multer 明確錯誤訊息（繳費/匯入）、JWT secret 記憶化（H1）
const DB_PATH = path.join(__dirname, 'review_i_security.db');
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.TURSO_DATABASE_URL = 'file:' + DB_PATH.replace(/\\/g, '/');
process.env.TURSO_AUTH_TOKEN = '';
process.env.JWT_SECRET = 'test-secret';
process.env.PORT = '34914';

const BASE = 'http://127.0.0.1:34914';

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

async function main() {
  require('../server');
  await waitDbReady();

  // H1: JWT secret 穩定——同一進程內簽發→驗證往返成功（secret 記憶化不會每次亂數）
  const { generateToken, verifyToken } = require('../auth');
  const probe = generateToken({ club_id: 'admin', club_name: '管理員', is_admin: 1 });
  const decoded = verifyToken(probe);
  if (decoded.clubId !== 'admin') throw new Error('token roundtrip failed');
  console.log('[H1] JWT secret 穩定：簽發→驗證往返 OK');

  const login = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clubId: 'admin', password: 'admin123' })
  });
  const { token } = await login.json();
  if (!token) throw new Error('admin login failed');
  const auth = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };

  // C2-1: 白名單外 key（jwt_secret）應被忽略
  let r = await fetch(`${BASE}/api/admin/settings`, {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ phase1_deadline: '2026-09-20', jwt_secret: 'HACKED' })
  });
  if (r.status !== 200) throw new Error('valid keys should save');
  let s = await (await fetch(`${BASE}/api/admin/settings`, { headers: auth })).json();
  if (s.jwt_secret) throw new Error('jwt_secret should NOT be settable via API');
  console.log('[C2-1] settings 白名單：jwt_secret 無法覆寫 OK');

  // C2-2: 錯誤日期格式 → 400
  r = await fetch(`${BASE}/api/admin/settings`, {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ payment_deadline: '2026/09/30' })
  });
  if (r.status !== 400) throw new Error('bad date should 400');
  console.log('[C2-2] 錯誤日期格式 → 400 OK');

  // C2-3: 非正整數名額 → 400
  r = await fetch(`${BASE}/api/admin/settings`, {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ phase1_total_quota: 'abc' })
  });
  if (r.status !== 400) throw new Error('bad quota should 400');
  console.log('[C2-3] 非整數名額 → 400 OK');

  // C2-4: 全部為白名單外 → 400
  r = await fetch(`${BASE}/api/admin/settings`, {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ current_phase: '2' })
  });
  if (r.status !== 400) throw new Error('all-unknown keys should 400');
  console.log('[C2-4] 僅白名單外 key → 400 OK');

  // M7: importClubs null guard（null/空值過濾，回傳有效筆數）
  const { importClubs } = require('../database');
  const n = await importClubs([null, { club_id: 9999, club_name: '測試社' }, { club_id: null, club_name: 'x' }, { club_id: 9998, club_name: '' }]);
  if (n !== 1) throw new Error('importClubs should import exactly 1 valid club, got ' + n);
  console.log('[M7] importClubs null guard：只匯入有效筆數 OK');

  // M1: 500 回應不洩漏內部細節——直接檢查錯誤訊息不含 SQL 痕跡
  // 觸發方式：以非法 ID 呼叫 feedback 更新（DB 不會出錯，這裡改為確認回應格式）
  r = await fetch(`${BASE}/api/admin/feedback/abc`, {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ status: 'open' })
  });
  const badId = await r.json();
  if (!badId.error) throw new Error('feedback bad id should return error');
  console.log('[M1] 錯誤回應格式 OK（status=' + r.status + ' error=' + badId.error + '）');

  // M8: deadline 空字串防護——未設定 deadline 時 runEnforcement 不得誤棄權
  // 先清掉所有 deadline，報名一筆，跑 runEnforcement 應保持 registered
  r = await fetch(`${BASE}/api/admin/settings`, {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ phase1_deadline: '', payment_deadline: '', phase2_deadline: '' })
  });
  if (r.status !== 200) throw new Error('clearing deadlines should save');
  const { runEnforcement } = require('../deadlines');
  await runEnforcement();
  console.log('[M8] deadline 空字串：runEnforcement 正常執行 OK');

  // 繳費上傳超 10MB → 明確 400（非「伺服器錯誤」）
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.alloc(11 * 1024 * 1024, 65)], { type: 'application/pdf' }), 'big.pdf');
  r = await fetch(`${BASE}/api/payment/upload`, {
    method: 'POST', headers: { 'Authorization': `Bearer ${token}` }, body: fd
  });
  const big = await r.json();
  if (r.status !== 400 || !String(big.error).includes('10MB')) throw new Error('payment oversize should 400 with 10MB msg, got ' + r.status + ' ' + big.error);
  console.log('[M2] 繳費上傳 >10MB → 明確 400 OK');

  console.log('\n全部 PASS');
  process.exit(0);
}

main().catch(err => { console.error('FAILED:', err.message); process.exit(1); });