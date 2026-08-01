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
- Uses `@libsql/client` connecting to Turso cloud (NOT local SQLite)
- `db` is `null` until `initDatabase()` succeeds
- All DB functions (`getAll`, `getOne`, `runQuery`, `insert`) check `if (!db)` and throw "Database not connected" if called before init completes
- `db.batch()` for multi-statement operations (table creation, bulk inserts)
- `saveDatabase()` is a no-op (kept for backward compat)
- Tables: `clubs`, `registrations`, `payment_proofs`, `settings`

### Registration Status Flow
- `registered` → default status when a club member registers
- `standby` → set automatically when club exceeds `guaranteed_quota` in Phase 1 (超額報名)
- `paid` → set when admin approves payment proof
- `forfeited` → set when admin marks as forfeited (棄權)
- Status changes: `registered` ↔ `standby` ↔ `paid` ↔ `forfeited`

### Phase System
- Phase 1 registration deadline, Phase 2 after that
- `settings.guaranteed_quota` (default 10) — per-club guaranteed spots
- `settings.phase1_total_quota` (default 160) — total Phase 1 capacity
- `POST /api/admin/promote` — auto-promote standby to registered (跨社遞補)
- `GET /api/admin/standby-list` — list of unpromoted standby registrations
- `POST /api/admin/promote/:id` — manual single-person promotion

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
- `POST /api/registrations` — create registration (auth required, auto-standby in Phase 1)
- `GET /api/my-registrations` — list club's registrations (auth required)
- `GET /api/admin/all` — all registrations with filters: club_id, phase, status (admin only)
- `PUT /api/admin/payment/:id` — mark registration as paid (admin only)
- `PUT /api/admin/forfeit/:id` — mark registration as forfeited (admin only)
- `PUT /api/admin/reset-status/:id` — reset registration to registered (admin only)
- `POST /api/admin/promote` — auto-promote standby registrations, works in any phase (admin only)
- `GET /api/admin/standby-list` — list standby registrations (admin only)
- `POST /api/admin/promote/:id` — manual promote single standby (admin only)
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
auth.js          — JWT auth middleware
public/          — Frontend HTML files
public/css/      — Shared styles (warm earthy theme)
uploads/         — Payment proof files (gitignored)
railway.json     — Railway deploy config (Nixpacks builder)
```

## License
MIT License
