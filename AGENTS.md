# AGENTS.md

## Project Overview
區會報名系統 (Registration System) — Node.js/Express app with SQLite (sql.js), JWT auth, deployed on Railway.

## Quick Start
```bash
npm install
npm start          # production on port 3000
npm run dev         # development with file watching
```

## Architecture
- **Entry**: `server.js` — Express server, all API routes defined here
- **Database**: `database.js` — sql.js (in-memory SQLite with file sync to `data/registration.db`)
- **Auth**: `auth.js` — JWT middleware, `authMiddleware` for protected routes, `adminMiddleware` for admin-only
- **Frontend**: `public/` — static HTML (index, register, payment, summary, admin)
- **Deploy**: `railway.json` — Railway config, healthcheck at `/health`

## Key Gotchas

### Database
- SQLite file is gitignored (`data/registration.db`). Fresh deploy = empty DB.
- `saveDatabase()` auto-creates `data/` dir. Don't manually create it.
- DB is in-memory synced to disk — data lost on Railway restart unless volume configured.

### Railway Deployment
- App MUST listen on `0.0.0.0` (already configured in `server.js`).
- Healthcheck endpoint: `/health` (NOT `/api/summary`).
- Set `JWT_SECRET` env var in Railway dashboard (defaults to hardcoded fallback).
- Trial → Free plan switch needed by ~8/27 (see `RAILWAY_SWITCH_MEMO.md`).

### Auth
- JWT tokens expire in 24h. Frontend stores in `localStorage`.
- Logout = clear `localStorage` (onclick="localStorage.clear()" on nav links).
- Default admin: `admin` / `admin123`
- Club passwords default to last 4 digits of `club_id`.

### File Uploads
- Payment proofs stored in `uploads/payments/`.
- Directory auto-created on startup.
- Max file size: 10MB. Allowed: JPG, PNG, GIF, PDF.

## Environment Variables
| Var | Default | Notes |
|-----|---------|-------|
| `PORT` | 3000 | Railway sets this automatically |
| `JWT_SECRET` | hardcoded fallback | MUST set in production |

## API Routes (key ones)
- `POST /api/login` — returns JWT token
- `GET /api/summary` — public stats (no auth)
- `POST /api/registrations` — create registration (auth required)
- `GET /api/admin/all` — all registrations (admin only)
- `GET /health` — health check endpoint

## File Structure
```
server.js        — Express app + all routes
database.js      — SQLite operations (sql.js)
auth.js          — JWT auth middleware
public/          — Frontend HTML files
public/css/      — Styles
data/            — SQLite DB (gitignored)
uploads/         — Payment proof files (gitignored)
railway.json     — Railway deploy config
```
