const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const DB_PATH = path.join(__dirname, 'review_j.db');
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.TURSO_DATABASE_URL = 'file:' + DB_PATH.replace(/\\/g, '/');
process.env.TURSO_AUTH_TOKEN = '';
process.env.JWT_SECRET = 'test-secret';
process.env.PORT = '34915';

const BASE = 'http://127.0.0.1:34915';

const { getDb } = require('../database');

function renderTextPng() {
  const ps1 = path.join(os.tmpdir(), 'announce_fixture.png.ps1');
  const script = [
    "Add-Type -AssemblyName System.Drawing",
    "$bmp = New-Object System.Drawing.Bitmap(900, 420)",
    "$g = [System.Drawing.Graphics]::FromImage($bmp)",
    "$g.Clear([System.Drawing.Color]::White)",
    "$font = New-Object System.Drawing.Font('Microsoft JhengHei', 28)",
    "$brush = [System.Drawing.Brushes]::Black",
    "$g.DrawString('2408 羅娜 115/7/28 請繳費', $font, $brush, 40, 40)",
    "$g.DrawString('2419 久美 缺名冊紙本', $font, $brush, 40, 120)",
    "$g.DrawString('2426 豐丘 115/7/27 請繳費', $font, $brush, 40, 200)",
    "$ms = New-Object System.IO.MemoryStream",
    "$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)",
    "[Convert]::ToBase64String($ms.ToArray())"
  ].join('\n');
  fs.writeFileSync(ps1, script, 'utf8');
  try {
    const out = execFileSync('pwsh', ['-NoProfile', '-Command', ps1], { encoding: 'utf8' });
    return out.trim().split(/\r?\n/).pop();
  } finally {
    fs.unlinkSync(ps1);
  }
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

async function main() {
  require('../server');
  await waitDbReady();
  const db = getDb();
  await db.batch([
    { sql: "INSERT INTO line_sources (source_type, source_id, source_name, member_count) VALUES ('group', 'G800', '2408 羅娜互助社群', 15)", args: [] },
    { sql: "INSERT INTO line_sources (source_type, source_id, source_name) VALUES ('user', 'U411', '2419 久美')", args: [] }
  ], 'write');

  const login = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clubId: 'admin', password: 'admin123' })
  });
  const { token } = await login.json();
  if (!token) throw new Error('admin login failed');
  const auth = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };

  // 1. 純圖片來源：raw 空＋images 空 → 400（訊息更新）
  const empty = await fetch(`${BASE}/api/admin/announce/generate`, {
    method: 'POST', headers: auth, body: JSON.stringify({ raw: '', images: [] })
  });
  const emptyData = await empty.json();
  console.log('--- 純圖片來源：空資料 ---');
  console.log('  status=' + empty.status + ' error=' + (emptyData.error || ''));
  if (empty.status !== 400) throw new Error('generate with no raw and no images should be 400');

  // 2. 圖片驗證：6 張 → 400、格式不支援 → 400、超 2MB → 400
  const six = await fetch(`${BASE}/api/admin/announce/generate`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ images: Array(6).fill({ mime: 'image/png', data: 'aGk=' }) })
  });
  const sixData = await six.json();
  console.log('\n--- 圖片驗證 ---');
  console.log('  6 張 status=' + six.status + ' error=' + (sixData.error || ''));
  if (six.status !== 400 || !String(sixData.error || '').includes('圖片最多 5 張')) throw new Error('6 images should be 400 圖片最多 5 張');

  const badMime = await fetch(`${BASE}/api/admin/announce/generate`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ images: [{ mime: 'image/bmp', data: 'aGk=' }] })
  });
  const badMimeData = await badMime.json();
  console.log('  bmp 格式 status=' + badMime.status + ' error=' + (badMimeData.error || ''));
  if (badMime.status !== 400 || !String(badMimeData.error || '').includes('圖片格式不支援')) throw new Error('bmp should be 400 圖片格式不支援');

  const tooBig = await fetch(`${BASE}/api/admin/announce/generate`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ images: [{ mime: 'image/png', data: 'a'.repeat(3 * 1024 * 1024) }] })
  });
  const tooBigData = await tooBig.json();
  console.log('  超 2MB status=' + tooBig.status + ' error=' + (tooBigData.error || ''));
  if (tooBig.status !== 400 || !String(tooBigData.error || '').includes('單張圖片不可超過 2MB')) throw new Error('>2MB image should be 400 單張圖片不可超過 2MB');

  // 3. 產生 PNG fixture（含中文社號）→ 純圖片產生公告
  const imgB64 = renderTextPng();
  if (!imgB64) throw new Error('fixture PNG generation failed');
  console.log('\n--- generate（純圖片，raw 留空）---');
  const gen = await fetch(`${BASE}/api/admin/announce/generate`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ raw: '', images: [{ mime: 'image/png', data: imgB64 }] })
  });
  const genData = await gen.json();
  if (process.env.GEMINI_API_KEY) {
    console.log('  status=' + gen.status);
    console.log('  broadcast 前 60 字：' + String(genData.broadcast || '').slice(0, 60));
    console.log('  perClub 筆數：' + (genData.perClub || []).length);
    if (gen.status !== 200) throw new Error('image generate should succeed with key: ' + JSON.stringify(genData));
    const broadcast = String(genData.broadcast || '');
    if (!broadcast) throw new Error('broadcast empty');
    const known = new Set(['2408', '2419', '2426']);
    if (!/2408|2419|2426/.test(broadcast)) throw new Error('broadcast missing club ids from image');
    const ids = (genData.perClub || []).map(p => p.club_id);
    if (ids.length === 0) throw new Error('perClub empty — Gemini failed to read clubs from image');
    for (const id of ids) {
      if (!known.has(String(id))) throw new Error('perClub hallucinated club_id: ' + id);
    }
    console.log('  perClub 社號：' + ids.join(', '));
  } else {
    console.log('  無 GEMINI_API_KEY → status=' + gen.status + ' error=' + (genData.error || ''));
    if (gen.status !== 500 || !String(genData.error || '').includes('AI 公告產生失敗')) {
      throw new Error('image generate without key should fail gracefully (500 AI 公告產生失敗)');
    }
  }

  // 4. 文字＋圖片並存 → 仍可產生（無 key 時同為 graceful 500，有 key 時 200）
  const both = await fetch(`${BASE}/api/admin/announce/generate`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ raw: '2408 羅娜 115/7/28；2419 久美（缺名冊紙本）。', images: [{ mime: 'image/png', data: imgB64 }] })
  });
  const bothData = await both.json();
  console.log('\n--- generate（文字＋圖片並存）---');
  if (process.env.GEMINI_API_KEY) {
    console.log('  status=' + both.status + ' broadcast 前 40 字：' + String(bothData.broadcast || '').slice(0, 40));
    if (both.status !== 200 || !bothData.broadcast) throw new Error('text+image generate should succeed with key');
  } else {
    console.log('  無 GEMINI_API_KEY → status=' + both.status + ' error=' + (bothData.error || ''));
    if (both.status !== 500) throw new Error('text+image generate without key should fail gracefully');
  }

  console.log('\n全部階段 PASS');
  setTimeout(() => process.exit(0), 150);
}

main().catch(err => { console.error(err); process.exit(1); });
