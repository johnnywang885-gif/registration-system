const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'review_g.db');
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.TURSO_DATABASE_URL = 'file:' + DB_PATH.replace(/\\/g, '/');
process.env.TURSO_AUTH_TOKEN = '';
process.env.JWT_SECRET = 'test-secret';
process.env.PORT = '34899';
// 清除 key 讓三層流程第 1/2 層確定性走到「忙線＋開單」分支（linebot 於 require 時讀取）
process.env.GEMINI_API_KEY = '';

const BASE = 'http://127.0.0.1:34899';

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

  const login = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clubId: 'admin', password: 'admin123' })
  });
  const { token } = await login.json();
  if (!token) throw new Error('admin login failed');
  const auth = { 'Authorization': `Bearer ${token}` };

  // 1. 知識庫 CRUD
  const add1 = await fetch(`${BASE}/api/admin/knowledge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ title: '名冊繳交說明', content: '各社需於 115/8/20 前繳交紙本名冊至區會辦公室，缺名冊紙本者請盡速補交。' })
  });
  const add1Data = await add1.json();
  if (add1.status !== 200) throw new Error('knowledge add1 failed: ' + JSON.stringify(add1Data));
  const kb1 = add1Data.id;

  const add2 = await fetch(`${BASE}/api/admin/knowledge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ title: '113年度社費說明', content: '每社社費新台幣 5,000 元，請於繳費截止日前匯款並上傳繳費證明。' })
  });
  const add2Data = await add2.json();
  if (add2.status !== 200) throw new Error('knowledge add2 failed: ' + JSON.stringify(add2Data));
  const kb2 = add2Data.id;

  let list = await (await fetch(`${BASE}/api/admin/knowledge`, { headers: auth })).json();
  console.log('--- 知識庫 CRUD ---');
  console.log('  新增後列表筆數=' + list.length);
  if (list.length !== 2) throw new Error('knowledge list should have 2 rows, got ' + list.length);

  const upd = await fetch(`${BASE}/api/admin/knowledge/${kb1}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ title: '名冊繳交說明（更新）', content: '各社需於 115/8/20 前繳交紙本名冊至區會辦公室。' })
  });
  if (upd.status !== 200) throw new Error('knowledge update failed');

  const tog = await fetch(`${BASE}/api/admin/knowledge/${kb2}/toggle`, { method: 'POST', headers: auth });
  if (tog.status !== 200) throw new Error('knowledge toggle failed');

  list = await (await fetch(`${BASE}/api/admin/knowledge`, { headers: auth })).json();
  const t2 = list.find(r => r.id === kb2);
  console.log('  更新後標題=' + (list.find(r => r.id === kb1) || {}).title + ' / kb2 active=' + t2.active);
  if (t2.active !== 0) throw new Error('toggle should set active=0');

  const del = await fetch(`${BASE}/api/admin/knowledge/${kb2}`, { method: 'DELETE', headers: auth });
  if (del.status !== 200) throw new Error('knowledge delete failed');
  list = await (await fetch(`${BASE}/api/admin/knowledge`, { headers: auth })).json();
  console.log('  刪除後筆數=' + list.length);
  if (list.length !== 1) throw new Error('knowledge list should have 1 row after delete');

  // 2. 檢索計分（啟用中才撈得到、相關度排序）
  const { retrieveKnowledge, answerQuestion, handleLineEvent } = require('../linebot');
  const hits = await retrieveKnowledge('名冊何時要交到區會辦公室');
  console.log('--- 檢索（名冊）---');
  hits.forEach(h => console.log('  ' + h.split('\n')[0]));
  if (hits.length !== 1 || !hits[0].includes('名冊繳交說明')) throw new Error('retrieveKnowledge should find only the 名冊 entry');

  const hits2 = await retrieveKnowledge('沒有相關內容的亂問 xyzq');
  if (hits2.length !== 0) throw new Error('retrieveKnowledge should return empty for unrelated query');

  // 3. 三層流程：無 key → 忙線＋自動開單
  const { getOne, getAll, runQuery } = require('../database');
  const ans = await answerQuestion('請問 2408 羅娜社的名冊繳交期限');
  console.log('--- 三層流程（無 GEMINI key）---');
  console.log('  tier=' + ans.tier + ' 開單=' + ans.unanswered);
  console.log('  回覆：' + ans.text);
  if (ans.tier !== 'busy' || !ans.unanswered) throw new Error('no-key answerQuestion should be busy+unanswered');
  if (!ans.text.includes('忙線中') || !ans.text.includes('稍後回覆')) throw new Error('busy text missing keywords');

  // bot_name 分身署名
  await runQuery("INSERT INTO settings (key, value) VALUES ('bot_name', '張三') ON CONFLICT(key) DO UPDATE SET value = '張三'");
  const ansName = await answerQuestion('不會回答的測試問題 qqqwww');
  console.log('  分身署名：' + ansName.text.split('\n').pop());
  if (!ansName.text.includes('（張三）')) throw new Error('bot_name signature missing');
  await runQuery("DELETE FROM settings WHERE key = 'bot_name'");

  // handleLineEvent → feedback 表自動開單（無 LINE token，replyMessage 靜默失敗但開單先執行）
  const { insert } = require('../database');
  await handleLineEvent({
    type: 'message',
    replyToken: 'TESTTOKEN',
    source: { type: 'user', userId: 'U_TEST_KB' },
    message: { type: 'text', text: '請問活動中心幾點開門？' }
  });
  const fb = await getOne("SELECT * FROM feedback WHERE message LIKE '%AI 未解答%' ORDER BY id DESC");
  console.log('  自動開單：' + (fb ? fb.message.slice(0, 40) : '(無)'));
  if (!fb) throw new Error('busy question should auto-open feedback ticket');

  // 4. 備份含 knowledge 節
  const backup = await (await fetch(`${BASE}/api/admin/backup`, { headers: auth })).json();
  console.log('--- 備份 ---');
  console.log('  knowledge 筆數=' + (backup.knowledge || []).length);
  if (!Array.isArray(backup.knowledge) || backup.knowledge.length !== 1) throw new Error('backup must include knowledge section');

  console.log('\n全部階段 PASS');
  setTimeout(() => process.exit(0), 150);
}

main().catch(err => { console.error(err); process.exit(1); });