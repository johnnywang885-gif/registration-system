const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'review_f.db');
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.TURSO_DATABASE_URL = 'file:' + DB_PATH.replace(/\\/g, '/');
process.env.TURSO_AUTH_TOKEN = '';
process.env.JWT_SECRET = 'test-secret';
process.env.PORT = '34897';
process.env.GEMINI_GROUNDING = 'on';
process.env.GEMINI_GROUNDING_MAX_MONTH = '4800';

const BASE = 'http://127.0.0.1:34897';

const { getDb } = require('../database');
const { getGroundingUsage, canUseGrounding, recordGroundingUse } = require('../linebot');
const { taipeiToday } = require('../deadlines');

const RAW = [
  '以下為115年貴區會已辦理重大疾病互助基金續約作業，尚未繳納費用之互助社名單：',
  '2408 羅娜 115/7/28；2419 久美（未提供名冊用印紙本）；2426 豐丘 115/7/27；',
  '2427 新鄉 115/7/24；2429 望鄉 115/7/22；2434 雙豐 115/7/23；2436 力行 115/7/22。'
].join('');

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
    { sql: "INSERT INTO line_sources (source_type, source_id, source_name, member_count) VALUES ('group', 'G789', '區會主群組', 30)", args: [] },
    { sql: "INSERT INTO line_sources (source_type, source_id, source_name, member_count) VALUES ('group', 'G800', '2408 羅娜互助社群', 15)", args: [] },
    { sql: "INSERT INTO line_sources (source_type, source_id, source_name) VALUES ('user', 'U411', '2419 久美')", args: [] },
    { sql: "INSERT INTO line_sources (source_type, source_id, source_name) VALUES ('group', 'G842', '2427 新鄉互助社群')", args: [] }
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
  const auth = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };

  // 1. generate：空資料 → 400
  const noRaw = await fetch(`${BASE}/api/admin/announce/generate`, {
    method: 'POST', headers: auth, body: JSON.stringify({ raw: '' })
  });
  console.log('--- generate 空資料 ---');
  console.log('  status=' + noRaw.status + ' error=' + ((await noRaw.json()).error || ''));
  if (noRaw.status !== 400) throw new Error('generate without raw should be 400');

  // 2. generate：docx 同款資料 → 群組版 + 各社個別版
  const gen = await fetch(`${BASE}/api/admin/announce/generate`, {
    method: 'POST', headers: auth, body: JSON.stringify({ raw: RAW, instructions: '請轉知各相關社盡速繳交費用' })
  });
  const genData = await gen.json();
  console.log('\n--- generate（無 key）---');
  if (process.env.GEMINI_API_KEY) {
    console.log('  status=' + gen.status);
    console.log('  broadcast 前 60 字：' + String(genData.broadcast || '').slice(0, 60));
    console.log('  perClub 筆數：' + (genData.perClub || []).length);
    if (gen.status !== 200) throw new Error('generate should succeed with key');
    const broadcast = String(genData.broadcast || '');
    if (!broadcast.includes('2408') && !broadcast.includes('羅娜')) throw new Error('broadcast missing club info');
    const ids = (genData.perClub || []).map(p => p.club_id);
    if (!ids.includes('2408') || !ids.includes('2419')) throw new Error('perClub missing 2408/2419');
    for (const p of genData.perClub || []) {
      if (!String(p.message || '').includes(p.club_name)) throw new Error(`perClub ${p.club_id} message lost club name`);
    }
  } else {
    console.log('  無 GEMINI_API_KEY → status=' + gen.status + ' error=' + (genData.error || ''));
    if (gen.status !== 500 || !String(genData.error || '').includes('AI 公告產生失敗')) {
      throw new Error('generate without key should fail gracefully (500 AI 公告產生失敗)');
    }
  }

  // 3. match：依社號/社名比對 line_sources
  const match = await fetch(`${BASE}/api/admin/announce/match`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ clubs: [{ club_id: '2408', club_name: '羅娜' }, { club_id: '2419', club_name: '久美' }, { club_id: '2436', club_name: '力行' }] })
  });
  const matchData = await match.json();
  console.log('\n--- match ---');
  matchData.forEach(m => console.log(`  ${m.club_id} ${m.club_name} → ${m.candidates.map(c => `${c.source_type}:${c.source_id}(${c.source_name})`).join(', ') || '(無)'}`));
  const m2408 = matchData.find(m => m.club_id === '2408');
  const m2419 = matchData.find(m => m.club_id === '2419');
  const m2436 = matchData.find(m => m.club_id === '2436');
  if (!m2408 || !m2408.candidates.some(c => c.source_type === 'group' && c.source_id === 'G800')) throw new Error('2408 should match group G800');
  if (!m2419 || !m2419.candidates.some(c => c.source_type === 'user' && c.source_id === 'U411')) throw new Error('2419 should match user U411');
  if (!m2436 || m2436.candidates.length !== 0) throw new Error('2436 should have no candidates');
  if (m2408.candidates[0].source_type !== 'group') throw new Error('group candidates should sort first');

  // 4. send：clubs 模式，無 LINE token → 逐筆失敗不中斷
  const sendClubs = await fetch(`${BASE}/api/admin/announce/send`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      mode: 'clubs',
      items: [
        { club_id: '2408', club_name: '羅娜', message: '2408 羅娜 請於 7/28 前繳費', target_type: 'group', target_id: 'G800' },
        { club_id: '2419', club_name: '久美', message: '2419 久美 請補交名冊紙本', target_type: 'user', target_id: 'U411' }
      ]
    })
  });
  const sendClubsData = await sendClubs.json();
  console.log('\n--- send clubs（無 LINE token）---');
  console.log('  status=' + sendClubs.status + ' message=' + (sendClubsData.message || ''));
  if (!sendClubs.ok) throw new Error('send clubs should still return 200 with per-item failures');
  if (sendClubsData.delivered.length !== 0 || sendClubsData.failed.length !== 2) {
    throw new Error('without LINE token all club sends should fail individually: ' + JSON.stringify(sendClubsData));
  }

  // 5. send：group 模式，無 LINE → 501
  const sendGroup = await fetch(`${BASE}/api/admin/announce/send`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ mode: 'group', text: '測試群組公告' })
  });
  const sendGroupData = await sendGroup.json();
  console.log('\n--- send group（無 LINE token）---');
  console.log('  status=' + sendGroup.status + ' error=' + (sendGroupData.error || ''));
  if (sendGroup.status !== 501) throw new Error('send group without LINE config should be 501');

  // 6. 網路搜尋用量計數器：達標停用、月底自動歸零、成功後 +1
  const monthKey = 'grounding_' + taipeiToday().slice(0, 7);
  const usage0 = await getGroundingUsage();
  console.log('\n--- grounding 計數器 ---');
  console.log('  key=' + usage0.key + ' used=' + usage0.used + ' max=' + usage0.max);
  if (usage0.key !== monthKey || usage0.max !== 4800) throw new Error('grounding month key / max wrong');

  await getDb().batch([
    { sql: "INSERT INTO settings (key, value) VALUES (?, '4800')", args: [monthKey] },
  ], 'write');
  const nearMax = await canUseGrounding();
  console.log('  used=4800 時 canUseGrounding=' + nearMax + '（預期 false＝達到上限停用搜尋）');
  if (nearMax !== false) throw new Error('grounding should be disabled at max');

  await getDb().batch([
    { sql: "UPDATE settings SET value = '4700' WHERE key = ?", args: [monthKey] },
  ], 'write');
  if ((await canUseGrounding()) !== true) throw new Error('grounding should be enabled under max');

  await recordGroundingUse();
  const usage1 = await getGroundingUsage();
  console.log('  recordGroundingUse 後 used=' + usage1.used + '（預期 4701）');
  if (usage1.used !== 4701) throw new Error('grounding usage should increment to 4701');

  console.log('\n全部階段 PASS');
  setTimeout(() => process.exit(0), 150);
}

main().catch(err => { console.error(err); process.exit(1); });