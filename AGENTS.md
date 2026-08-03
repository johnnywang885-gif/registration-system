# AGENTS.md

## Project Overview
區會報名系統 (Registration System) — Node.js/Express app with Turso cloud database (libSQL), JWT auth, deployed on Railway.

## Quick Start
```bash
npm install
npm start          # requires TURSO_DATABASE_URL env var
npm run dev         # development with file watching (node --watch)
```
No lint, typecheck, or test scripts exist. This is a plain JS project with no build step.

`dotenv` auto-loads `.env` (gitignored). The local `.env` has **empty** `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` — real Turso credentials exist only on Railway. `npm start` locally boots fine but every `/api` call returns 500 until a real Turso URL/token is supplied.

## Verification (no test framework)
- Syntax check: `node --check server.js deadlines.js database.js auth.js`
- `@libsql/client` accepts `file:` URLs, so the whole stack (database.js + deadlines.js + server.js) runs against a local SQLite file: set `TURSO_DATABASE_URL=file:C:/abs/path.db`, `TURSO_AUTH_TOKEN=`, then call `initDatabase()` + `runEnforcement()` directly or boot `server.js`.
- Real-data offline test (never touches production): login as admin (`admin`/`admin123`) → `GET /api/admin/backup` returns full JSON (`clubs`, `registrations`, `payment_proofs`, `settings`) → seed it into a local `file:` copy → run `deadlines.js` enforcement against the copy. Do NOT point enforcement at the real Turso DB.
- `deadlines.js` `taipeiToday()` always uses the real Taipei date — to simulate other phases, edit the `settings` rows (deadline dates) in the local copy, not the clock.
- Windows gotcha: a process holding a `file:` DB (e.g. a spawned `server.js`) locks the file; kill the process before deleting/reopening it.
- `test/` only holds stale one-off simulation scripts (`phase2_standby.js`, `simulate.js`) that still reference the ignored `current_phase` setting — not a real test suite.

## Architecture

### Startup Order (critical — do not rearrange)
`server.js` `startServer()` is **synchronous** (not async). The order matters for Railway healthcheck:

1. Register healthcheck route (`/health`)
2. Register ALL other routes (public + API)
3. Add global error handler middleware
4. `app.listen()` — server starts accepting requests
5. `initDatabase()` runs **non-blocking** in background (`.then().catch()`)

If `initDatabase()` blocks or runs before `app.listen()`, Railway healthcheck fails and the deploy dies with a 502.

### Server Structure (`server.js`)
- All routes inside `startServer()` function (not top-level)
- Routes use async handlers; unhandled errors caught by global error handler
- Static files served via `express.static('public')`
- File uploads via multer to `uploads/payments/`

### Database (`database.js`)
- Uses `@libsql/client` connecting to `TURSO_DATABASE_URL` (Turso cloud in production; also accepts `file:` for offline testing — see Verification)
- `db` is `null` until `initDatabase()` succeeds
- All DB functions (`getAll`, `getOne`, `runQuery`, `insert`) check `if (!db)` and throw "Database not connected" if called before init completes
- `db.batch()` for multi-statement operations (table creation, bulk inserts)
- `saveDatabase()` is a no-op (kept for backward compat)
- Tables: `clubs`, `registrations`, `payment_proofs`, `settings`

### Registration Status Flow
- `registered` → default status when a club member registers (occupies a seat)
- `standby` → set when club exceeds `guaranteed_quota` in Phase 1, when occupancy >= 160, or Phase 2 overflow (候補，不占名額)
- `paid` → set when admin approves payment proof
- `forfeited` → set when admin marks as forfeited (棄權) OR auto-forfeited at deadline (未繳費視同未報名)
- Status changes: `registered` ↔ `standby` ↔ `paid` ↔ `forfeited`

### Phase System (date-driven, automatic)
- Total capacity is `settings.phase1_total_quota` (default 160) — the hard cap on the **official confirmed list** (occupancy = `COUNT(status IN ('registered','paid'))`). Standby and forfeited do NOT count.
- Phase is **derived from dates** (`deadlines.js` `phaseState`), NOT from the manual `current_phase` setting (now ignored):
  - `today <= phase1_deadline` → `phase1` (Phase 1 open)
  - `phase1_deadline < today <= payment_deadline` → `phase1_closed` (new Phase 1 registrations rejected)
  - `payment_deadline < today <= phase2_deadline` → `phase2` (Phase 2 open)
  - `today > phase2_deadline` → `closed` (registration closed)
- Dates are compared as `YYYY-MM-DD` strings in `Asia/Taipei`; **deadline day is inclusive**, transitions run the day after (`taipeiToday()`).
- Phase 1 registration: standby if club exceeds `guaranteed_quota` (10) OR occupancy >= 160.
- Phase 2 registration: `registered` while occupancy < 160, otherwise `standby` (Phase 2 standby queue for manual admin adjustment).
- `GET /api/admin/standby-list` lists standby from BOTH phases by `created_at ASC`.
- Auto-promotion targets **Phase 1** standby only (by login order, filling to quota). Phase 2 standby must be promoted manually (`POST /api/admin/promote/:id`), both are bound by the 160 cap.

### Deadline Enforcement (`deadlines.js`)
- `enforceDeadlines` middleware runs on **every `/api` request** + once at startup after DB ready. Transitions are idempotent:
  1. `today > payment_deadline` → clubs WITHOUT an `approved` payment proof: Phase 1 `registered` → `forfeited` (未繳費視同未報名)
  2. `phase1_deadline < today <= phase2_deadline` → auto-promote Phase 1 standby by login order until occupancy = 160
  3. `today > phase2_deadline` → clubs without `approved` proof: Phase 2 `registered` → `forfeited` (no further promotion)
- Payment status is judged **per club** (club has at least one `approved` proof = paid). Proofs still `pending`/`rejected` after the deadline count as unpaid.
- `POST /api/admin/promote` (manual button) and `POST /api/admin/promote/:id` remain as backup; both respect the 160 cap.
- `GET /api/admin/settings` returns `derived_phase`, `today`, `occupancy`, `remaining` for the admin UI (which shows the phase read-only).

### Auth (`auth.js`)
- JWT middleware: `authMiddleware` for protected routes, `adminMiddleware` for admin-only
- Tokens expire in 24h. Frontend stores in `localStorage`
- Default admin: `admin` / `admin123`
- Club passwords default to last 4 digits of `club_id`

### Frontend (`public/`)
- Pure HTML/CSS/JS, no framework, no build step
- `index.html` — login page
- `register.html` — registration form + card-based list
- `payment.html` — payment proof upload
- `summary.html` — public stats
- `admin.html` — admin panel with tabs (registrations, payments, clubs, settings, standby queue)
- `css/style.css` — shared styles (warm earthy theme: `#f5f0eb` bg, `#c0714a` primary)

## Railway Deployment

### Env Vars (via Railway API or Dashboard)
| Var | Required | Notes |
|-----|----------|-------|
| `TURSO_DATABASE_URL` | Yes | `libsql://...` format |
| `TURSO_AUTH_TOKEN` | Yes | JWT from `turso db tokens create` |
| `JWT_SECRET` | No (建議設定) | Falls back to random ephemeral key — 重啟後所有登入失效；若不設定會印出警告 |
| `PORT` | No | Set automatically by Railway |

**Railway API gotcha**: `variableUpsert` mutation MUST include `serviceId` param, otherwise the variable is set at project level but not exposed to the running service. Query `services` to get the service ID first.

### Deploy Flow
- Push to `master` → Railway auto-deploys via GitHub webhook
- Healthcheck: `GET /health` must return 200 within 30s
- Current production URL: `https://registration-system-production-4e05.up.railway.app` (`/health` and `/api/summary` are public for quick checks)
- The `railway` CLI is installed but **not linked/logged in** in this environment (`railway whoami` / `railway variables` print nothing). Get real env vars/creds from the Railway dashboard — do not assume `railway` commands work.
- If deploy fails with "Healthcheck failure" or "Application failed to respond":
  - Check that routes are registered before `initDatabase()`
  - Check that `initDatabase()` is non-blocking
  - Check that Railway env vars are set at service level (not just project level)

### Common Failure Modes
1. **502 on all API routes**: Routes not registered (blocked by `await initDatabase()`)
2. **500 on API routes + pages work**: DB not connected (env vars missing or init failed)
3. **Healthcheck failure**: `app.listen()` not called before DB init
4. **"Cannot read properties of undefined"**: Missing DB data (new Turso DB needs club import)
5. **Health works but API 404**: Wrong service URL — the production URL includes a service suffix

## API Routes
- `POST /api/login` — returns JWT token
- `GET /api/summary` — public stats (no auth): phase breakdown, guaranteed/standby counts
- `POST /api/registrations` — create registration (auth required; phase & status derived from dates, auto-standby logic)
- `GET /api/my-registrations` — list club's registrations (auth required)
- `GET /api/admin/all` — all registrations with filters: club_id, phase, status (admin only)
- `PUT /api/admin/payment/:id` — mark registration as paid (admin only)
- `PUT /api/admin/forfeit/:id` — mark registration as forfeited (admin only)
- `PUT /api/admin/reset-status/:id` — reset registration to registered (admin only)
- `POST /api/admin/promote` — auto-promote Phase 1 standby to fill quota (admin only)
- `GET /api/admin/standby-list` — list standby from BOTH phases (admin only)
- `POST /api/admin/promote/:id` — manual promote single standby, respects 160 cap (admin only)
- `PUT /api/payment/review/:id` — approve/reject payment proof (admin only)
- `PUT /api/payment/reset/:id` — reset payment proof to pending (admin only)
- `GET /api/payment/file/:id` — view payment proof file (auth required: admin or owning club)
- `POST /api/admin/import-clubs` — bulk import clubs (admin only)
- `POST /api/admin/import-excel` — import from XLSX (admin only)
- `GET /api/admin/backup` — full backup as JSON (admin only)
- `POST /api/admin/restore` — restore from JSON (admin only)
- `GET /api/admin/export` — export as XLSX (admin only)
- `GET /health` — health check (no auth)

## Key Gotchas

### Timezone
- Turso `CURRENT_TIMESTAMP` stores UTC
- Frontend must use `new Date(value + 'Z').toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })` to display correct Taiwan time

### Payment Approval Bulk Effect
- When admin approves a payment proof, ALL `status='registered'` registrations for that club are updated to `paid` (not just one)
- Club payments cover all members at once

### Payment Files Are Auth-Protected
- `/uploads` is NOT served statically. Files are accessed via `GET /api/payment/file/:id` with a JWT (admin or owning club)
- Frontend loads images/PDFs via `fetch` + blob URL (a plain `<img src>` / `<a href>` cannot send the Authorization header)
- Rejecting a proof keeps the file on disk so it can still be reviewed; the club can upload a new proof which creates a new row

### Registrations Locked After Paid/Forfeited
- Clubs cannot edit or delete registrations whose status is `paid` or `forfeited` (server rejects with 400, UI hides the buttons)

### Registration Sorting
- Summary page sorts clubs by earliest registration time first (ASC), no-registration clubs last

## File Structure
```
server.js        — Express app + all routes (startServer is sync, not async)
database.js      — Turso cloud operations (@libsql/client), db starts as null
deadlines.js     — date-driven phase state machine + auto promote/forfeit (enforceDeadlines middleware)
auth.js          — JWT auth middleware
public/          — Frontend HTML files
public/css/      — Shared styles (warm earthy theme)
uploads/         — Payment proof files (gitignored)
railway.json     — Railway deploy config (Nixpacks builder)
```

## License
MIT License
