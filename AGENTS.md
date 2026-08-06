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
- Windows console mangles Chinese unless UTF-8: in PowerShell run `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8` before `node`.

### Working regression scripts (`test/`)
- `review_a_flap.js` — standalone DB test (no HTTP): seeds paid/unpaid clubs with Phase 1 standby, runs `runEnforcement()` 5×; asserts no promote↔forfeit flapping (paid-club standby promoted, unpaid-club standby stays).
- `review_b_export.js` — boots real server on PORT 34891, seeds the 4 statuses, `GET /api/admin/export`, asserts `standby → 候補` in the 報名資料 sheet (guards the export status mapping).
- `review_c_backup.js` — restores a real backup JSON into a local `file:` copy and runs `runEnforcement()` as a no-op sanity check (p2 already passed); never touches the live Turso DB.
- `review_d_rule_timeline.js` — boots real server on PORT 34892, drives a full 7-stage timeline over HTTP (phase-1 overflow → promote → pay → forfeit → phase-2 standby / manual promote).
- `sim_phase2_144_30.js` — boots real server on PORT 34893; scenario simulation (Phase 1: 144 paid + paid-club standby; Phase 2: 30 incl. those standby) printing per-club tables. Reuse as a template for "what if" simulations.
- Run **one at a time, sequentially** — each boots its own server on a distinct port against a throwaway `file:` DB in `test/*.db` (gitignored). Pass = output ends with `PASS` / `全部階段 PASS`.
- `phase2_standby.js` / `simulate.js` are stale one-off scripts still driven by the ignored `current_phase` setting — ignore them.

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
- `enforceDeadlines` middleware runs on **every `/api` request** (non-blocking, background) + once at startup after DB ready. 5-second debounce prevents redundant runs on rapid requests.
- Transitions are idempotent (4 windows):
  1. `today > payment_deadline` → clubs WITHOUT an `approved` payment proof: Phase 1 `registered` → `forfeited` (未繳費視同未報名)
  2. `phase1_deadline < today <= payment_deadline` → auto-promote **ALL** Phase 1 standby (any club) by login order until occupancy = quota
  3. `payment_deadline < today <= phase2_deadline` → auto-promote ONLY Phase 1 standby of clubs WITH an `approved` proof (`requirePaidClub`), by login order until occupancy = quota
  4. `today > phase2_deadline` → clubs without `approved` proof: Phase 2 `registered` → `forfeited` (no further promotion)
- Unpaid clubs' Phase 1 standby (未繳費社團候補) are NEVER auto-promoted after the payment deadline — they stay `standby` until admin manually promotes them; they are not forfeited either.
- Payment status is judged **per club** (club has at least one `approved` proof = paid). Proofs still `pending`/`rejected` after the deadline count as unpaid.
- `POST /api/admin/promote` (manual button) and `POST /api/admin/promote/:id` remain as backup; both respect the 160 cap. `POST /api/admin/promote` promotes Phase 1 standby of ANY club.
- `GET /api/admin/settings` returns `derived_phase`, `today`, `occupancy`, `remaining` for the admin UI (which shows the phase read-only).

### Auth (`auth.js`)
- JWT middleware: `authMiddleware` for protected routes, `adminMiddleware` for admin-only
- Tokens expire in 24h. Frontend stores in `localStorage`
- Default admin: `admin` / `admin123`
- Club passwords default to last 4 digits of `club_id`

### Frontend (`public/`)
- Pure HTML/CSS/JS, no framework, no build step
- `index.html` — login page + 報名規則卡片（動態截止日、目前階段徽章）
- `register.html` — registration form + card-based list（生日欄位民國年格式）
- `payment.html` — payment proof upload
- `summary.html` — public stats（表格標題顯示各階段截止日）
- `admin.html` — admin panel with tabs (registrations, payments, clubs, settings, standby queue)
- `css/style.css` — shared styles (warm earthy theme: `#f5f0eb` bg, `#c0714a` primary)
- `css/guide.css` — guided tour overlay styles (spotlight, tooltip, pulse/bounce animations)
- `js/guide.js` — guided tour engine (no dependencies, vanilla JS; first-visit auto-play + replay button)
- `images/culroc-logo.jpg` — CULROC logo（CSS `mix-blend-mode: darken` 模擬去背）

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
- `GET /api/summary` — public stats (no auth): per-club `phase1_registered/standby/paid/phase1_total/phase2_count` + totals `phase1Total`, `phase1PaidTotal`, `phase2Total` + `settings` (deadlines, quotas)
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
- `POST /api/admin/clear-data` — clear all registrations & payment proofs (keeps clubs & settings) (admin only)
- `GET /api/admin/export` — export as XLSX (admin only); accepts `club_id`/`phase`/`status` filters, applied to BOTH sheets (報名資料 + 彙整統計)
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

### Admin Downloads Are Auth-Protected Too
- `GET /api/admin/export` and `GET /api/admin/backup` require the JWT header — a `window.open(url)` / plain `<a href>` navigation cannot send it and returns `{"error":"未登入"}` (401)
- Download pattern: `fetch` with `Authorization` header → `res.blob()` → object URL → `<a download>` click → revoke (see `exportExcel()` / `backupData()` in `public/admin.html`). Do NOT "simplify" back to `window.open`.

### Registrations Locked After Paid/Forfeited
- Clubs cannot edit or delete registrations whose status is `paid` or `forfeited` (server rejects with 400, UI hides the buttons)

### Registration Sorting
- Summary page sorts clubs by earliest registration time first (ASC), no-registration clubs last

### Summary Metrics Switch After Payment Deadline
- In `summary.html`, once `today > payment_deadline`, the 第一階段 header card switches to `phase1PaidTotal` AND each club's 第一階段 column shows `phase1_paid` (已完成報名並繳費). Before the deadline both show the total (`phase1Total` / `phase1_total`).
- Both numbers must stay on the SAME metric — a past bug shipped an inconsistent page (header = total 60, rows = paid 51). `/api/summary` returns both `phase1Total` and `phase1PaidTotal` for this reason.

### Export 彙整統計 Sheet Inlines Validated Literals
- The export `彙整統計` sheet builds `rowCond`/`clubCond` as inline SQL with **validated literals** (`phase` → `parseInt`, `status` → whitelist array, `club_id` → `parseInt`), NOT `?` placeholders. The condition is repeated across every `COUNT(CASE ...)` column, so `?` placeholders would be duplicated while params are bound once — libSQL binds the rest as NULL and every count silently returns 0.
- The 報名資料 sheet uses normal parameterized `?` queries (each condition appears once) — leave those as-is.

### Export 報名資料 Sheet Status Mapping
- `server.js` maps `r.status` for the 報名資料 sheet: `registered → 已報名`, `standby → 候補`, `paid → 已繳費`, everything else → `棄權`. Never collapse `standby` into the `棄權` fallback (past bug #2); `test/review_b_export.js` guards this mapping.

### Birthday Field (民國年)
- Backend stores dates in Western format (`YYYY-MM-DD`)
- Frontend (`register.html`, `admin.html`) converts to ROC format for display (`westernToROC()`) and back for storage (`rocToWestern()`)
- Input format on register page: `民國年/月/日` (e.g., `113/08/15`)

### Summary Table Deadline Headers
- `summary.html` fetches `/api/summary` and dynamically updates table headers to show deadline dates (e.g., `第一階段 (截止: 2026-09-20)`)

### Guided Tour (操作導覽)
- `js/guide.js` + `css/guide.js` provide a reusable guided tour engine
- Steps defined per page via `window.GUIDE_STEPS` and `window.GUIDE_PAGE`
- First-visit auto-play (localStorage `guideSeen_<page>`) + persistent replay button
- Uses `mix-blend-mode: darken` on spotlight for visual highlight; tooltip auto-flips to avoid covering targets

## File Structure
```
server.js        — Express app + all routes (startServer is sync, not async)
database.js      — Turso cloud operations (@libsql/client), db starts as null
deadlines.js     — date-driven phase state machine + auto promote/forfeit (enforceDeadlines middleware, non-blocking with debounce)
auth.js          — JWT auth middleware
public/          — Frontend HTML files
public/css/      — Shared styles (style.css + guide.css)
public/js/       — Guide tour engine (guide.js)
public/images/   — Logo assets (culroc-logo.jpg)
uploads/         — Payment proof files (gitignored)
test/            — regression + simulation scripts (see Verification; *.db gitignored)
railway.json     — Railway deploy config (Nixpacks builder)
```

## License
MIT License
