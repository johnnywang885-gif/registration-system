const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'sim_frontend.db');
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.TURSO_DATABASE_URL = 'file:' + DB_PATH.replace(/\\/g, '/');
process.env.TURSO_AUTH_TOKEN = '';
process.env.JWT_SECRET = 'sim-frontend-secret';
process.env.PORT = '34900';

const BASE = 'http://127.0.0.1:34900';

async function waitDbReady() {
  for (let i = 0; i < 100; i++) {
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

  const { importClubs } = require('../database');
  await importClubs([
    { club_id: 2401, club_name: '眉溪' },
    { club_id: 2402, club_name: '鹿谷' }
  ]);
  console.log('seeded clubs: 2401 眉溪, 2402 鹿谷');

  console.log('SIM_FRONTEND_READY on ' + BASE);
  setInterval(() => {}, 1 << 30);
}

main().catch(err => { console.error(err); process.exit(1); });
