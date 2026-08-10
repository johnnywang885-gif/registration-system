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
- Syntax check: `node --check server.js deadlines.js database.js auth.js linebot.js`
- `@libsql/client` accepts `file:` URLs, so the whole stack (database.js + deadlines.js + server.js) runs against a local SQLite file: set `TURSO_DATABASE_URL=file:C:/abs/path.db`, `TURSO_AUTH_TOKEN=`, then call `initDatabase()` + `runEnforcement()` directly or boot `server.js`.
- Real-data offline test (never touches production): login as admin (use the real production password — see Auth section; the default `admin123` works only on fresh local DBs) → `GET /api/admin/backup` returns full JSON (`clubs`, `registrations`, `payment_proofs`, `settings`, `feedback`, `line_messages`, `line_sources`) → seed it into a local `file:` copy → run `deadlines.js` enforcement against the copy. Do NOT point enforcement at the real Turso DB.
- `deadlines.js` `taipeiToday()` always uses the real Taipei date — to simulate other phases, edit the `settings` rows (deadline dates) in the local copy, not the clock.
- Windows gotcha: a process holding a `file:` DB (e.g. a spawned `server.js`) locks the file; kill the process before deleting/reopening it.
- Windows console mangles Chinese unless UTF-8: in PowerShell run `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8` before `node`.
- `test/check_gemini_key.js` — 驗證任一把 Gemini key 的可用性（$env:GEMINI_API_KEY + 可選 $env:GEMINI_MODEL）：① 一般問答是否通 ② 網路搜尋（Grounding with Google Search）是否可用（可用＝付費 key，可開 `GEMINI_GROUNDING=on`）；key 無效時 exit 1。遇 429 卡額度時也用它逐模型實測。

### Working regression scripts (`test/`)
- `review_a_flap.js` — standalone DB test (no HTTP): seeds paid/unpaid clubs with Phase 1 standby, runs `runEnforcement()` 5×; asserts no promote↔forfeit flapping (paid-club standby promoted, unpaid-club standby stays).
- `review_b_export.js` — boots real server on PORT 34891, seeds the 4 statuses, `GET /api/admin/export`, asserts `standby → 候補` in the 報名資料 sheet (guards the export status mapping).
- `review_c_backup.js` — restores a real backup JSON into a local `file:` copy and runs `runEnforcement()` as a no-op sanity check (p2 already passed); never touches the live Turso DB.
- `review_d_rule_timeline.js` — boots real server on PORT 34892, drives a full 7-stage timeline over HTTP (phase-1 overflow → promote → pay → forfeit → phase-2 standby / manual promote).
- `review_e_line_digest.js` — boots real server on PORT 34895, seeds `line_sources`/`line_messages`, then exercises the LINE 彙整 stack over HTTP: sources list w/ message counts, empty-range 400, digest (200+digest with a real `GEMINI_API_KEY`, else graceful 500), line-send 501 without LINE config, source-name refresh (0 updated without token).
- `review_f_announce.js` — boots real server on PORT 34897, seeds `line_sources` (主群/各社群/個別社), then exercises the AI 公告 stack over HTTP: generate 400 without raw, generate (200+broadcast+perClub with a real `GEMINI_API_KEY`, else graceful 500), match 社號/社名 → line_sources (群組優先排序；無比對回空), send clubs per-item failures don't break the batch (200 + delivered/failed), send group 501 without LINE config. Also covers the grounding usage counter (`GEMINI_GROUNDING=on` + max 4800): used=4800 → 停用, used=4700 → 啟用, `recordGroundingUse()` → 4701.
- `sim_phase2_144_30.js` — boots real server on PORT 34893; scenario simulation (Phase 1: 144 paid + paid-club standby; Phase 2: 30 incl. those standby) printing per-club tables. Reuse as a template for "what if" simulations.
- `sim_185_30.js` — boots real server on PORT 34904; scenario simulation (185 Phase-1 registrations incl. 5 big clubs over the 10-seat guarantee → 50 unpaid forfeits → 30 Phase-2 registrations) and keeps the DB alive for browser verification. Reuse as template too.
- `sim_frontend_boot.js` — boots real server on PORT 34900, seeds clubs 2401/2402, then stays alive (`setInterval`) for manual/browser frontend testing. **Use this instead of `npm start` when you need a running server for MCP browser work.**
- Run **one at a time, sequentially** — each boots its own server on a distinct port against a throwaway `file:` DB in `test/*.db` (gitignored). Pass = output ends with `PASS` / `全部階段 PASS`.
- `phase2_standby.js` / `simulate.js` are stale one-off scripts still driven by the ignored `current_phase` setting — ignore them.

### MCP browser testing (chrome-devtools-mcp)
- `opencode.json` connects via `--browserUrl http://127.0.0.1:9222`; **before using MCP tools in a new session, run `pwsh test/launch-chrome.ps1`** (spawns headless Chrome with a custom profile + waits until port 9222 is ready).
- `test/.chrome-profile/` is Chrome's profile dir (gitignored); don't delete it while Chrome is running.
- Driving the UI with `evaluate_script` (set input values + dispatch events + click) is far more reliable than click/fill MCP tools — the guided-tour overlay can also block click targets; close it first via its 「關閉導覽」 button.
- Temporary throwaway scripts follow `test/_*.js` (e.g. `_verify_jwt_pass.js`) and are deleted right after use.

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
- Tables: `clubs`, `registrations`, `payment_proofs`, `settings`, `feedback`, `line_messages`, `line_sources`
- `line_messages` — LINE 對話紀錄（`source_type` group/user、`source_id` groupId|userId、`sender_id`、`message`、`created_at`，UTC datetime）；bot 收到每則文字訊息即 INSERT
- `line_sources` — LINE 來源清單（PK `(source_type, source_id)`），每個 LINE 事件即時 `ON CONFLICT ... DO UPDATE` 更新 `last_message_at`（upsert 不可用 `INSERT OR REPLACE`，會清掉名稱欄位）；`source_name`/`member_count` 由管理員在後台按「重新整理名稱」補抓（群組→`GET /v2/bot/group/{id}/summary`、用戶→`GET /v2/bot/profile/{id}`），失敗保留原值
- 兩表皆納入 backup/restore JSON（`line_messages`/`line_sources` 節）

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
- Default admin `admin`/`admin123` exists **only in fresh local `file:` DBs** (initialized by `database.js`); the production password was changed at go-live — never assume the default against the live Turso DB. Admins change their own password via `PUT /api/admin/change-password` (系統設定 tab).
- Club passwords default to last 4 digits of `club_id`

### Frontend (`public/`)
- Pure HTML/CSS/JS, no framework, no build step
- `index.html` — login page + 報名規則卡片（動態截止日、目前階段徽章）
- `register.html` — registration form + card-based list（生日欄位民國年格式）
- `payment.html` — payment proof upload
- `summary.html` — public stats（表格標題顯示各階段截止日）
- `admin.html` — admin panel with tabs (報名管理, 繳費審核, 社團管理, 系統設定, 遞補順序, 意見回饋, LINE 彙整, AI 公告; LINE 公告按鈕在 系統設定 tab)
- `feedback.html` — 意見回饋表單（分類＋內容，auth 必要）
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
| `JWT_SECRET` | No | 未設時啟動自動生成 64-hex 並存入 Turso `settings` 表（key `jwt_secret`），重啟後從 DB 載回，登入不失效；無需手動設定 |
| `LINE_CHANNEL_SECRET` | No | LINE Messaging API channel secret（webhook 簽章驗證用） |
| `LINE_CHANNEL_ACCESS_TOKEN` | No | LINE Messaging API access token（回覆/推播用） |
| `GEMINI_API_KEY` | No | Gemini API key（bot AI 回覆用；未設時 bot 回覆「AI 助理尚未設定」） |
| `GEMINI_MODEL` | No | Gemini 模型名稱（預設 `gemini-3.5-flash-lite`，可改任何模型名如 `gemini-2.5-flash`；改動後重啟生效） |
| `GEMINI_GROUNDING` | No | 設 `on` 才啟用 Gemini Grounding with Google Search（bot 可上網查資料再回答）；**Free tier key 無法使用搜尋**，呼叫失敗會自動退回首選模式，bot 不中斷（付費 key 後於 Railway 開啟） |
| `GEMINI_GROUNDING_MAX_MONTH` | No | 每月網路搜尋成功次數上限（預設 `4800`，刻意低於付費層每月 5,000 次免費搜尋額度）；用量記在 `settings` 表 key `grounding_YYYY-MM`（依 Taipei 月份自動歸零），達標後自動停用搜尋（bot 改一般回答）下個月自動恢復——防觸動付費 |
| `SYSTEM_URL` | No | 對外網址（bot 知識庫與簡介連結用，預設為目前 production URL） |
| `PORT` | No | Set automatically by Railway |

**Railway API gotcha**: `variableUpsert` mutation MUST include `serviceId` param, otherwise the variable is set at project level but not exposed to the running service. Query `services` to get the service ID first.

**Current live state (2026-08)**: production has `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, `GEMINI_API_KEY` set at service level; `JWT_SECRET` is auto-generated into Turso settings. LINE bot (AI Q&A, feedback, group announce) is fully live and verified; LINE 彙整/轉送（line-sources/digest/send）隨 2026-08-10 部署上線（body-probe 已確認新程式碼生效）。`GEMINI_MODEL`/`GEMINI_GROUNDING` 未在 Railway 設定（用預設模型、不啟用搜尋）。

### Railway GraphQL API (account token — works, `railway` CLI doesn't)
- Endpoint: `https://backboard.railway.com/graphql/v2` (or `backboard.railway.app`), header `Authorization: Bearer <token>`, `Content-Type: application/json`, body `{"query":"..."}`.
- Tokens are created at **https://railway.com/account/tokens** (account-level, UUID4 format). 
- **Verification quirk**: `query { me { id } }` returns `Not Authorized` even with a valid token. Verify with `query { __typename }` (returns `{"data":{"__typename":"Query"}}`) or `query { projects { edges { node { id name } } } }`.
- This project: `projects` → `e981451a-db5f-42db-9a62-23f5f1889922` (industrious-renewal); service `registration-system` → `1dbe8188-dd80-44be-8d02-537e7815f7e9`; environment `production` → `9b0983a9-b37c-4533-b606-c2865f1c17bf`. Discover via `project(id){ services { edges { node { id name } } } environments { edges { node { id name } } } }`.
- `variableUpsert` input fields: **`name`** (the variable key — NOT `key`), `value`, `projectId`, `serviceId`, `environmentId`, `skipDeploys`. Returns `Boolean!` — **no selection** (adding `{ id }` → 400). Env changes auto-trigger a redeploy (unless `skipDeploys`); rapid upserts dedupe into one deploy, extras show `REMOVED`.
- `variables` query: `variables(projectId, environmentId, serviceId)` returns a JSON map, **no selection**. **Must pass `serviceId`** or you only see project-level vars (the linebot/Gemini vars will appear missing).
- `deployments`: `deployments(input: { projectId, serviceId, environmentId }, first: N) { edges { node { id status createdAt } } }`.
- Redeploy latest commit: `serviceInstanceDeployV2(serviceId, environmentId)` — returns `String!` (deployment id, **no selection**). There is also `serviceInstanceDeploy(serviceId, environmentId, commitSha?, latestCommit?)`.
- **Transient build failures happen**: a GitHub-triggered deploy once sat `BUILDING` ~10 min then `FAILED` with no retrievable logs (`buildLogs`/`deploymentLogs` often return empty) and meta showing `builder: RAILPACK`/null startCommand even though `railway.json` requests NIXPACKS. Retrying via `serviceInstanceDeployV2` succeeded immediately. Don't chase the failure — check `/health` after redeploy.
- Real Turso creds are readable via the `variables` query — safe for **read-only SELECT** verification of production state (e.g., `settings.line_group_id`), never run enforcement/backup-restore against the live DB.

### Deploy Flow
- Push to `master` → Railway auto-deploys via GitHub webhook
- Healthcheck: `GET /health` must return 200 within 30s
- Current production URL: `https://registration-system-production-4e05.up.railway.app` (`/health` and `/api/summary` are public for quick checks)
- **uploads/ is NOT persistent on Railway**: every deploy/restart wipes uploaded payment-proof files (DB rows keep the `file_path`, but `GET /api/payment/file/:id` then 404s). Backup JSON does NOT include file contents. Accepted as-is — tell admins clubs can re-upload.
- **Detect whether a deploy actually switched versions**: `POST /api/login` with a ~200KB body → new code (10mb `express.json`) returns 401, old code (100kb limit) returns 500. Useful because rolling deploys may never drop `/health`.
- The `railway` CLI is installed but **not linked/logged in** in this environment (`railway whoami` / `railway variables` print nothing). Use the GraphQL API with an account token instead (see below) — do not assume `railway` commands work.
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
- `POST /api/login` — returns JWT token (rate-limited: 10 attempts / 15 min)
- `GET /api/me` — current club/admin info (auth required)
- `GET /api/summary` — public stats (no auth): per-club `phase1_registered/standby/paid/phase1_total/phase2_count` + totals `phase1Total`, `phase1PaidTotal`, `phase2Total` + `settings` (deadlines, quotas)
- `POST /api/registrations` — create registration (auth required; phase & status derived from dates, auto-standby logic)
- `GET /api/my-registrations` — list club's registrations (auth required)
- `PUT /api/registrations/:id` / `DELETE /api/registrations/:id` — club edits/deletes own registration; rejected when status is `paid`/`forfeited`
- `GET /api/admin/all` — all registrations with filters: club_id, phase, status (admin only)
- `PUT /api/admin/payment/:id` — mark registration as paid (admin only)
- `PUT /api/admin/forfeit/:id` — mark registration as forfeited (admin only)
- `PUT /api/admin/reset-status/:id` — reset registration to registered (admin only)
- `PUT /api/admin/change-password` — admin changes own password (body: `currentPassword` + `newPassword` ≥ 8 chars; UI in 系統設定 tab)
- `POST /api/admin/promote` — auto-promote Phase 1 standby to fill quota (admin only)
- `GET /api/admin/standby-list` — list standby from BOTH phases (admin only)
- `POST /api/admin/promote/:id` — manual promote single standby, respects 160 cap (admin only)
- `GET /api/admin/clubs` + `POST/PUT/DELETE /api/admin/clubs` / `PUT /api/admin/clubs/:id/reset-password` — club management CRUD (admin only)
- `PUT /api/payment/review/:id` — approve/reject payment proof (admin only)
- `PUT /api/payment/reset/:id` — reset payment proof to pending (admin only)
- `POST /api/feedback` — submit feedback (auth required; categories 操作問題/錯誤回報/功能建議/其他, max 2000 chars)
- `GET /api/admin/feedback` / `PUT /api/admin/feedback/:id` — list (open first, newest first) / toggle open↔done (admin only)
- `POST /api/admin/line-announce` — push a message to the LINE group the bot joined (admin only; 501 if LINE not configured)
- `GET /api/admin/line-sources` — list LINE 彙整 sources (`line_sources` + per-source message counts; admin only)
- `POST /api/admin/line-sources/refresh` — re-fetch source names from LINE (group summary / profile APIs; admin only; failures keep old values)
- `POST /api/admin/line-digest` — digest messages from one source (body: `source_type`/`source_id`/`since`/`until`/`kind` summary|questions; max 500 rows; 400 when no messages in range; 500 graceful when Gemini unavailable)
- `POST /api/admin/line-send` — push arbitrary text to a target (`target_type` group|user + `target_id`; user push needs the user to have added the official account as friend, else 501)
- `POST /api/admin/announce/generate` — AI 公告產生（admin；body `raw` ≤8000 字 + 選用 `instructions`）：Gemini 並行產出「群組總公告版」`broadcast`（LINE 簡訊版，仿 LINE 彙整 graceful 模式）與「各社個別版」`perClub`（JSON 陣列 `[{club_id, club_name, message}]`，每社只含自己的事項；club_id 白名單＝原始資料內出現的 4 碼數字，防 Gemini 幻覺；JSON parse 失敗自動重試一次；無 key → 500「AI 公告產生失敗」）
- `POST /api/admin/announce/match` — 依社號/社名比對 `line_sources.source_name`（群組類型排序在前），回每社 `candidates`（含 source_type/source_id/source_name）；比對不到回空陣列
- `POST /api/admin/announce/send` — 發送 AI 公告（admin）：`mode:'group'`＋`text` → 推播 `line_group_id`（未設定 501）；`mode:'clubs'`＋`items:[{club_id, club_name, message, target_id}]` → 逐筆 `pushToLineUser`，**逐筆回報** `delivered`/`failed`（有失敗不中斷其餘，整批仍回 200）
- `POST /line/webhook` — LINE Messaging API webhook (no auth; validates `X-Line-Signature` HMAC-SHA256 with `LINE_CHANNEL_SECRET`; empty-event requests pass WITHOUT signature so LINE console URL verification works; acks 200 then processes events async)
- `GET /api/payment/file/:id` — view payment proof file (auth required: admin or owning club)
- `GET /api/payment/my-uploads` (club) / `GET /api/payment/all` (admin) — list payment proofs
- `POST /api/admin/import-clubs` — bulk import clubs (admin only)
- `POST /api/admin/import-excel` — import from XLSX (admin only)
- `GET /api/admin/backup` — full backup as JSON (admin only)
- `POST /api/admin/restore` — restore from JSON (admin only)
- `POST /api/admin/clear-data` — clear all registrations & payment proofs (keeps clubs & settings) (admin only)
- `GET /api/admin/settings` / `PUT /api/admin/settings` — read (incl. `derived_phase`, `today`, `occupancy`, `remaining`) / update deadline+quota settings (admin only)
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
- `js/guide.js` + `css/guide.css` provide a reusable guided tour engine
- Steps defined per page via `window.GUIDE_STEPS` and `window.GUIDE_PAGE`
- First-visit auto-play (localStorage `guideSeen_<page>`) + persistent replay button; auto-play starts 1800ms after load (delayed so browser UI prompts like the password-save bubble don't overlap)
- Uses `mix-blend-mode: darken` on spotlight for visual highlight; tooltip auto-flips to avoid covering targets

### Toast & Password Toggle
- `js/toast.js` exposes `window.toast(msg, 'success' | 'error')` — used by `admin.html` (replaces native `alert()`; `confirm()` for destructive ops stays native). Styled via `.toast-container` / `.toast-*` in `style.css`.
- `.password-wrap` + `.password-toggle` (eye SVG) toggles password visibility on the login page (`index.html`) and admin change-password fields (`cpCurrent`/`cpNew`); each page defines its own `togglePassword(inputId, btn)`.

### Feedback & LINE Bot
- `public/feedback.html` (auth required) submits to `feedback` table via `POST /api/feedback`; admin views/marks via 意見回饋 tab (`/api/admin/feedback`).
- `linebot.js` — LINE Messaging API integration: `verifySignature()` (HMAC-SHA256, needs rawBody captured via `express.json({ verify })`), `handleLineEvent()` (records every text message into `line_messages` + upserts `line_sources`; ANY event with a `groupId` — join or group message — upserts `line_group_id` into settings; join also sends a welcome message; text messages containing 意見/建議/回報/改進/壞掉/希望/bug → saved to `feedback` with a guessed category, else Gemini Q&A (model = `GEMINI_MODEL`, 預設 `gemini-3.5-flash-lite`) — general assistant, registration-system questions answered precisely, optional `googleSearch` grounding behind `GEMINI_GROUNDING` with automatic fallback to ungrounded, gated by a **monthly search counter** (`settings.grounding_YYYY-MM`, cap = `GEMINI_GROUNDING_MAX_MONTH` 預設 4800 — 防觸動付費；`getGroundingUsage()`/`canUseGrounding()`/`recordGroundingUse()`)). `generateAnnouncement()`（AI 公告：群組版＋各社版 JSON 白名單驗證）, `pushToGroup()` (announcements via 系統設定 tab button → `POST /api/admin/line-announce`; 501 when unconfigured), `pushToLineUser()` (arbitrary target push for the LINE 彙整 send flow), `refreshSourceNames()` (enrich `line_sources` names via group summary / profile APIs), `summarizeMessages()` (digest a message list via Gemini — 重點摘要 or 待確認疑問清單).
- LINE 群組訊息：現行平台會把群組內**所有**訊息事件送到 bot（無需 @提及；被 @ 時額外帶 `mention.mentionees[].isSelf=true` metadata）。webhook 先 ack 200 再異步處理事件。`feedback` 表含在 backup/restore 中。
- LINE 彙整與轉送（管理後台「LINE 彙整」tab）：來源＝`line_messages` 去重（群組/個別社 1:1 都收）；管理員選來源＋時間範圍＋彙整類型 →「彙整並直接傳送」一鍵呼叫 `POST /api/admin/line-digest` 產出後 `POST /api/admin/line-send` 推送到指定對象（個別社 push 需要對方已加官方帳號好友，非好友 501）；「僅預覽」只產出不送出。
- AI 公告（管理後台「AI 公告」tab）：貼入原始資料（社號/社名/日期/事項，如催繳名單）＋選擇性指示 → `generateAnnouncement()`（Gemini）並行產出群組總公告版與各社個別版 → 各社自動比對 `line_sources.source_name`（含社號或社名；群組優先），可編輯內容、逐社或全部傳送、逐筆回報結果。群組總公告在 LINE 主群組發「公告：<原始資料>」給 bot 即可讓 bot 產生草稿回覆（**僅限區會主群組觸發，只回覆草稿不自動推播**，正式推播一律走管理後台）。
- LINE Developers 主控台（非程式碼）gotchas：① Channel → Messaging API 頁籤需將「使用 Webhook」設為 ON，Webhook URL 指向 `https://.../line/webhook`；② 官方帳號「自動回應訊息」若未停用，用戶會同時收到 LINE 預設回覆與 bot 回覆（設定位置：manager.line.biz → 設定 → 回應訊息）；③ 「自動退出群組」開關若開啟，bot 被邀請進群會立刻自動退出（曾踩坑：bot 反覆進群即退，直到主控台關閉該設定）。
- Gemini 模型注意：模型名稱由 `GEMINI_MODEL` 控制（預設 `gemini-3.5-flash-lite`），改動後重啟生效。曾因 API key 對 `gemini-2.0-flash` 免費額度為 0（429 limit:0）導致 bot 回退「AI 助理尚未設定」，改用 `gemini-2.5-flash` 後正常；若未來再遇 429，可先用 `generateContent` 實測各模型額度，再調整 `GEMINI_MODEL`。
- 免費 key 可用範圍：**一般問答與彙整（無搜尋）免費 key 即可**（`gemini-3.5-flash-lite` 輸入/輸出免費）；**網路搜尋（Grounding with Google Search）官方明載 Free tier 不支援，必須付費 key**。付費後 Gemini 3 系每月 5,000 次搜尋免費、超過 $14/1000 次；付費另享較高 rate limit（免費 tier 有 RPM/RPD 上限，群組訊息量大時可能卡額度）。
- E2E 驗證撇步（不需真實用戶）：用 `LINE_CHANNEL_SECRET` 對測試 body 算 HMAC-SHA256 簽章 POST 到 `/line/webhook`（PowerShell `HMACSHA256` + Base64）→ 200 代表部署實例的 secret 正確；帶 `source.groupId` 的訊息事件會寫入 `line_group_id`，可再用 Railway variables 拿到的 Turso creds 對正式庫 SELECT 確認。

## File Structure
```
server.js        — Express app + all routes (startServer is sync, not async)
database.js      — Turso cloud operations (@libsql/client), db starts as null
deadlines.js     — date-driven phase state machine + auto promote/forfeit (enforceDeadlines middleware, non-blocking with debounce)
linebot.js       — LINE Messaging API integration (signature verify, AI reply, feedback logging, group push)
auth.js          — JWT auth middleware
public/          — Frontend HTML files
public/css/      — Shared styles (style.css + guide.css)
public/js/       — Guide tour engine (guide.js) + toast utility (toast.js)
public/images/   — Logo assets (culroc-logo.jpg)
uploads/         — Payment proof files (gitignored)
data/            — gitignored local SQLite scratch DB (`data/registration.db`, from manual `file:` runs)
test/            — regression + simulation scripts (see Verification; *.db gitignored)
test/launch-chrome.ps1 — one-command Chrome + remote-debugging launcher for MCP browser testing
docs/影片生成素材.md — Gemini Notebook 影片素材（分鏡＋字幕逐字稿＋準確資料附錄）
docs/報名系統簡介.html — 漫畫風動畫簡報（原始檔，先於 public 版本存在）；**public/intro.html 是它的部署副本，兩個檔案必須保持一致**：改動任一檔後務必 `Copy-Item` 覆寫另一檔（比對 hash 確認），不然網站分享的是舊版
RAILWAY_SWITCH_MEMO.md — Railway Trial→Free 方案切換備忘（2025/8 舊文件；其中 admin/admin123 已是舊密碼，勿對正式庫使用）
railway.json     — Railway deploy config (Nixpacks builder)
```

Repo root also holds **untracked local clutter** (manual `backup_*.json` exports, logo/screenshot files, xlsx) that `.gitignore` does NOT cover — never `git add .`; commit only intended files. One of these root `backup_*.json` files is what `test/review_c_backup.js` expects as its seed source.

## License
MIT License
