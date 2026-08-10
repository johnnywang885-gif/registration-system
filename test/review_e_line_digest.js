const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'review_e.db');
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.TURSO_DATABASE_URL = 'file:' + DB_PATH.replace(/\\/g, '/');
process.env.TURSO_AUTH_TOKEN = '';
process.env.JWT_SECRET = 'test-secret';
process.env.PORT = '34895';

const BASE = 'http://127.0.0.1:34895';

const { getDb } = require('../database');

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
    { sql: "INSERT INTO line_sources (source_type, source_id, source_name, member_count) VALUES ('group', 'G123', '測試群組', 12)", args: [] },
    { sql: "INSERT INTO line_sources (source_type, source_id, source_name) VALUES ('user', 'U456', '測試社長')", args: [] },
    { sql: "INSERT INTO line_messages (source_type, source_id, sender_id, message, created_at) VALUES ('group', 'G123', 'U1', '第一階段截止日是哪一天？', datetime('now', '-2 days'))", args: [] },
    { sql: "INSERT INTO line_messages (source_type, source_id, sender_id, message, created_at) VALUES ('group', 'G123', 'U2', '繳費證明要上傳到哪個頁面？', datetime('now', '-1 days'))", args: [] },
    { sql: "INSERT INTO line_messages (source_type, source_id, sender_id, message, created_at) VALUES ('group', 'G123', 'U1', '候補什麼時候會遞補？', datetime('now'))", args: [] }
  ], 'write');
}

async function main() {
  require('../server');
  await waitDbReady();
  await seed();

  const login = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clubId: 'admin', password: 'admin123' })
  });
  const { token } = await login.json();
  if (!token) throw new Error('admin login failed');
  const auth = { 'Authorization': `Bearer ${token}` };

  // 1. line-sources 回傳含名稱與訊息數
  const sources = await (await fetch(`${BASE}/api/admin/line-sources`, { headers: auth })).json();
  console.log('--- line-sources ---');
  sources.forEach(s => console.log(`  ${s.source_type} ${s.source_id} 名稱=${s.source_name || '(無)'} 訊息=${s.message_count}`));
  const group = sources.find(s => s.source_type === 'group' && s.source_id === 'G123');
  if (!group) throw new Error('group source missing');
  if (group.message_count !== 3) throw new Error('group message_count wrong: ' + group.message_count);

  // 2. 空範圍 → 400
  const empty = await fetch(`${BASE}/api/admin/line-digest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ source_type: 'group', source_id: 'G123', since: '2099-01-01 00:00:00', kind: 'summary' })
  });
  const emptyData = await empty.json();
  console.log('\n--- 空範圍彙整 ---');
  console.log('  status=' + empty.status + ' error=' + (emptyData.error || ''));
  if (empty.status !== 400) throw new Error('empty-range digest should be 400');

  // 3. 彙整：有 key 時應 200 且有內容；無 key 時應優雅失敗（500 + AI 彙整失敗）
  const digest = await fetch(`${BASE}/api/admin/line-digest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ source_type: 'group', source_id: 'G123', since: '2026-01-01 00:00:00', kind: 'questions' })
  });
  const digestData = await digest.json();
  console.log('\n--- 彙整（questions）---');
  if (process.env.GEMINI_API_KEY) {
    console.log('  status=' + digest.status);
    console.log('  摘要前 80 字：' + String(digestData.digest || '').slice(0, 80));
    if (digest.status !== 200 || !digestData.digest) throw new Error('digest should succeed with key');
  } else {
    console.log('  無 GEMINI_API_KEY → status=' + digest.status + ' error=' + (digestData.error || ''));
    if (digest.status !== 500 || !String(digestData.error || '').includes('AI 彙整失敗')) {
      throw new Error('digest without key should fail gracefully (500 AI 彙整失敗)');
    }
  }

  // 4. 未設定 LINE 時傳送 → 501
  const send = await fetch(`${BASE}/api/admin/line-send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ target_type: 'group', target_id: 'G123', text: '測試彙整內容' })
  });
  const sendData = await send.json();
  console.log('\n--- line-send（無 LINE 設定）---');
  console.log('  status=' + send.status + ' error=' + (sendData.error || ''));
  if (send.status !== 501) throw new Error('line-send without LINE config should be 501');

  // 5. refresh 名稱（無 LINE token → 更新 0 個）
  const refresh = await fetch(`${BASE}/api/admin/line-sources/refresh`, {
    method: 'POST',
    headers: auth
  });
  const refreshData = await refresh.json();
  console.log('\n--- line-sources/refresh（無 LINE token）---');
  console.log('  status=' + refresh.status + ' message=' + (refreshData.message || ''));
  if (refresh.status !== 200 || refreshData.updated !== 0) throw new Error('refresh without token should return 0 updated');

  console.log('\n全部階段 PASS');
  setTimeout(() => process.exit(0), 150);
}

main().catch(err => { console.error(err); process.exit(1); });
