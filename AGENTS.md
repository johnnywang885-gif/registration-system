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
- `admin.html` — admin panel with tabs (registrations, payments, clubs, settings)
- `css/style.css` — shared styles (warm earthy theme: `#f5f0eb` bg, `#c0714a` primary)

## Railway Deployment

### Env Vars (via Railway API or Dashboard)
| Var | Required | Notes |
|-----|----------|-------|
| `TURSO_DATABASE_URL` | Yes | `libsql://...` format |
| `TURSO_AUTH_TOKEN` | Yes | JWT from `turso db tokens create` |
| `JWT_SECRET` | No | Falls back to hardcoded default |
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

## API Routes
- `POST /api/login` — returns JWT token
- `GET /api/summary` — public stats (no auth)
- `POST /api/registrations` — create registration (auth required)
- `GET /api/my-registrations` — list club's registrations (auth required)
- `GET /api/admin/all` — all registrations (admin only)
- `POST /api/admin/import-clubs` — bulk import clubs (admin only)
- `POST /api/admin/import-excel` — import from XLSX (admin only)
- `GET /api/admin/backup` — full backup as JSON (admin only)
- `POST /api/admin/restore` — restore from JSON (admin only)
- `GET /api/admin/export` — export as XLSX (admin only)
- `GET /health` — health check (no auth)

## File Structure
```
server.js        — Express app + all routes (startServer is sync, not async)
database.js      — Turso cloud operations (@libsql/client), db starts as null
auth.js          — JWT auth middleware
public/          — Frontend HTML files
public/css/      — Shared styles (warm earthy theme)
public/js/       — Frontend JS (if any)
uploads/         — Payment proof files (gitignored)
railway.json     — Railway deploy config (Nixpacks builder)
```

## License
MIT License
