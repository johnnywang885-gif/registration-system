# AGENTS.md

## Project Overview
區會報名系統 (Registration System) — Node.js/Express app with Turso cloud database (libSQL), JWT auth, deployed on Railway.

## Quick Start
```bash
npm install
npm start          # requires TURSO_DATABASE_URL env var
npm run dev         # development with file watching
```

## Architecture
- **Entry**: `server.js` — Express server, all API routes (async/await throughout)
- **Database**: `database.js` — @libsql/client connecting to Turso cloud (NOT local SQLite)
- **Auth**: `auth.js` — JWT middleware, `authMiddleware` for protected routes, `adminMiddleware` for admin-only
- **Frontend**: `public/` — static HTML (index, register, payment, summary, admin)
- **Deploy**: `railway.json` — Railway config, healthcheck at `/health`

## Key Gotchas

### Database (Turso Cloud)
- All DB functions (`getAll`, `getOne`, `runQuery`, `insert`, `importClubs`) are **async** — must `await` them.
- `db.batch()` used for multi-statement operations (table creation, bulk inserts).
- Data persists in Turso cloud — Railway restarts do NOT lose data.
- `saveDatabase()` is a no-op (kept for backward compat).

### Railway Deployment
- App MUST listen on `0.0.0.0` (already configured in `server.js`).
- Healthcheck endpoint: `/health` (NOT `/api/summary`).
- Required env vars in Railway dashboard:
  - `TURSO_DATABASE_URL` — Turso database URL
  - `TURSO_AUTH_TOKEN` — Turso auth token
  - `JWT_SECRET` — JWT signing secret (defaults to hardcoded fallback)

### Auth
- JWT tokens expire in 24h. Frontend stores in `localStorage`.
- Logout = clear `localStorage` (onclick="localStorage.clear()" on nav links).
- Default admin: `admin` / `admin123`
- Club passwords default to last 4 digits of `club_id`.

### File Uploads
- Payment proofs stored in `uploads/payments/`.
- Directory auto-created on startup.
- Max file size: 10MB. Allowed: JPG, PNG, GIF, PDF.

### Backup/Restore
- Admin panel has full backup (JSON) and restore functionality.
- Backup exports all tables: clubs, registrations, payment_proofs, settings.
- Restore clears existing data then writes from backup using `db.batch()`.

## Environment Variables
| Var | Default | Notes |
|-----|---------|-------|
| `PORT` | 3000 | Railway sets this automatically |
| `JWT_SECRET` | hardcoded fallback | Set in production |
| `TURSO_DATABASE_URL` | — | **Required.** Turso database URL |
| `TURSO_AUTH_TOKEN` | — | **Required.** Turso auth token |

## API Routes (key ones)
- `POST /api/login` — returns JWT token
- `GET /api/summary` — public stats (no auth)
- `POST /api/registrations` — create registration (auth required)
- `GET /api/admin/all` — all registrations (admin only)
- `GET /api/admin/backup` — full backup as JSON (admin only)
- `POST /api/admin/restore` — restore from JSON (admin only)
- `GET /health` — health check endpoint

## File Structure
```
server.js        — Express app + all routes (async/await)
database.js      — Turso cloud operations (@libsql/client)
auth.js          — JWT auth middleware
public/          — Frontend HTML files
public/css/      — Styles
uploads/         — Payment proof files (gitignored)
railway.json     — Railway deploy config
```

## License

MIT License

Copyright (c) 2026

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
