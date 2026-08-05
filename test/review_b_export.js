const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

const DB_PATH = path.join(__dirname, 'review_b.db');
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.TURSO_DATABASE_URL = 'file:' + DB_PATH.replace(/\\/g, '/');
process.env.TURSO_AUTH_TOKEN = '';
process.env.JWT_SECRET = 'test-secret';
process.env.PORT = '34891';

const BASE = 'http://127.0.0.1:34891';

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
    { sql: "INSERT OR REPLACE INTO clubs (club_id, club_name, password, is_admin) VALUES (?, ?, ?, 0)", args: [2401, '測試社', 'x'] }
  ], 'write');
  const rows = [
    { name: '正取者', status: 'registered' },
    { name: '候補者', status: 'standby' },
    { name: '繳費者', status: 'paid' },
    { name: '棄權者', status: 'forfeited' }
  ];
  await db.batch(rows.map(r => ({
    sql: "INSERT INTO registrations (club_id, name, position, phase, status) VALUES (?, ?, ?, 1, ?)",
    args: [2401, r.name, '理事', r.status]
  })), 'write');
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

  const res = await fetch(`${BASE}/api/admin/export`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) throw new Error('export failed: ' + res.status);

  const buf = Buffer.from(await res.arrayBuffer());
  const wb = XLSX.read(buf, { type: 'buffer' });
  console.log('sheets:', wb.SheetNames);
  const ws = wb.Sheets['報名資料'];
  const json = XLSX.utils.sheet_to_json(ws);
  console.log('--- 報名資料 sheet 的 姓名/狀態 對映 ---');
  for (const row of json) {
    console.log(`  ${row['姓名']} -> ${row['狀態']}`);
  }
  const standbyRow = json.find(r => r['姓名'] === '候補者');
  if (!standbyRow) throw new Error('standby row not found in export');
  console.log('\n候補者狀態顯示為：「' + standbyRow['狀態'] + '」（正確應為「候補」）');
  console.log(standbyRow['狀態'] === '候補' ? 'PASS：候補顯示正確' : 'FAIL：候補被標成棄權（bug #2 成立）');

  setTimeout(() => process.exit(0), 150);
}

main().catch(err => { console.error(err); process.exit(1); });
