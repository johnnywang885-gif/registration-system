# AGENTS.md

## Project
區會報名系統 — Node.js/Express + Turso libSQL + JWT，部署 **Render**（2026-08-29 自 Railway 遷入，Railway 保留滾回）。無 build，無 lint/test 腳本。

## Quick Start
```bash
npm install
npm start          # 需 TURSO_DATABASE_URL，否則 /api 全 500
npm run dev        # node --watch
```
`dotenv` 載 `.env`（gitignored, 本地 TURSO 為空，正式憑證在 Render）。`README.md` 過時，以此檔為準（`JWT_SECRET` 已改自動生成存 `settings.jwt_secret`）。

## Verification
- 語法：`node --check server.js deadlines.js database.js auth.js linebot.js knowledge_import.js stats_announce.js`
- Node **≥20.16**（`pdf-parse` 需 `process.getBuiltinModule`），`package.json` 鎖 `22.x` 勿刪
- 本地離線：`TURSO_DATABASE_URL=file:C:/abs/path.db` + `TURSO_AUTH_TOKEN=` 可跑全栈（`initDatabase()` + `runEnforcement()` 或直接起 `server.js`）
- 擬真：用正式 `admin` 密碼 `GET /api/admin/backup` → 灌進本地 `file:` 庫 → 改 `settings` 截止日測 `deadlines.js`（勿對正式庫執行 `runEnforcement`/restore）
- Windows：`file:` 庫被 `server.js` 佔用時先殺進程再刪檔；中文亂碼先 `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8`
- `test/check_gemini_key.js` 測 `GEMINI_API_KEY` 是否通 + `GEMINI_GROUNDING=on` 是否可用（付費 key 才有 Grounding）

### Regression (`test/`, 逐一跑、不同 port、`*.db` gitignored)
- `review_a_flap.js` — 無 HTTP，驗自動遞補不回跳（`[stats_announce] CLIENT_CLOSED` 屬 15s->60min timer 正常殘影）
- `review_b_export.js` (34891) — `standby → 候補` 映射
- `review_c_backup.js` — 還原真實 backup 到本地 `file:`（不碰正式庫）
- `review_d_rule_timeline.js` (34892) — 7 階段時間線
- `review_e_line_digest.js` (34895) / `review_f_announce.js` (34897, 含 `grounding_YYYY-MM` 4800) / `review_g_knowledge.js` (34899) / `review_h_doc_import.js` (34898) / `review_j_announce_image.js` (34915) / `review_l_payment_blob.js` (34917)
- `review_i_security.js` (34914) — settings 白名單、JWT、魔數 sniff、xlsx、S1-S6、`jwt_secret` 過濾、路徑 containment 等；`review_k_stats_announce.js` (34916) — `dayMultiple5`/`buildStatsMessage`/去重/`stats_announce` 開關/`push_YYYY-MM` 預算/`runEnforcement changed` 標記
- `sim_*` 為情境模擬模板；`sim_frontend_boot.js` (34900) 取代 `npm start` 供 MCP 瀏覽器測試；`phase2_standby.js`/`simulate.js` 已廢棄

### MCP
`opencode.json` 連 `http://127.0.0.1:9222`，每 session 先 `pwsh test/launch-chrome.ps1`；`evaluate_script` 比 click/fill 穩，導覽遮罩先按「關閉導覽」；`test/_*.js` 與 `test/*.db`、`test/.chrome-profile/` 皆 gitignored

## Architecture

### Startup Order（不可調，`server.js:112 startServer()` 同步）
1. `GET /health` 2. 註冊所有路由 3. 全域 error handler 4. `app.listen()` 5. `initDatabase()` 非阻塞 `.then()`
- 若 `initDatabase` 在 `listen` 前或阻塞，Render 健康檢查 30s 內失敗 → 502

### DB (`database.js`)
- `@libsql/client`，`db` 為 `null` 直到 `initDatabase`；`getAll/getOne/runQuery/insert` 皆先判 `!db`
- `batch(write)` 建表與批次寫入；`saveDatabase()` 為 no-op
- 表：`clubs`(`is_admin`/`admin_perms` JSON)、`registrations`、`payment_proofs`(`file_data` BLOB，`file_path` 僅虛擬路徑)、`settings`、`feedback`、`line_messages`/`line_sources`、`knowledge`(`source_file`)
- `payment_proofs.file_data` 為主體（重啟不丟失），`backup` 不含 `file_data`；`GET /api/payment/file/:id` 優先 DB blob，fallback 僅為遷移相容且做 `../` containment

### Phase / Deadlines (`deadlines.js`)
- Phase 由日期推算（非 `current_phase`）：`today<=phase1_deadline → phase1`；`phase1<today<=payment → phase1_closed`；`payment<today<=phase2 → phase2`；`>phase2 → closed`（`taipeiToday()` 台北 `YYYY-MM-DD`，截止日當天仍計入）
- 總額 `phase1_total_quota` 預設 160（占位=`registered`+`paid`）；候補/棄權不占位
- `enforceDeadlines` 掛 `/api` 中介層 + 啟動一次，5s debounce；`runEnforcement()` 回 `{changed}` 才觸發 `scheduleStatsAnnounce()`
- `POST /api/admin/promote` 與 `promote/:id` 受 160 上限；`standby-list` 含兩階段依 `created_at`

### Stats Announce (`stats_announce.js` + `linebot.js:pushToDetail`)
- 雙觸發：異動（註冊/刪除/繳費審核/遞補/清空/還原/`runEnforcement`）→ `CHANGE_DEBOUNCE_MS=60min` 合併一封；隔 5 日（5/10/15/20/25/30 `dayMultiple5()`）→ `PERIODIC_INTERVAL 30min` setInterval，即使無流量也會發，當日 `stats_announce_date` 去重
- 內容：`collectStats()` 各階段人數 + 繳費社數 + 剩餘；`stats_announce=off` 全停（`settings` 白名單可寫）
- 去重：`change` 時 `stats_last_snapshot` 相同則跳過不計失敗
- **月預算**：`push_YYYY-MM` 計成功 `push` 數（群組 1 則、各社逐筆各 1），`PUSH_MAX=200`（`PUSH_MONTHLY_LIMIT` 可覆蓋）、`PUSH_WARN=180`（`PUSH_MONTHLY_WARN`），`stats` 自動達 `WARN` **完全跳過**不計失敗；`pushToDetail` 超 `MAX` 硬擋 429，遇 `You have reached your monthly limit` 自動同步本地 `push_YYYY-MM=MAX`；下月 key 自動重置；`test/review_k_stats_announce.js` 守護

### Auth (`auth.js`)
- `authMiddleware` / `anyAdminMiddleware` / `adminMiddleware` / `requirePerm(key)`（`ADMIN_PERMS` 與 `admin.html ADMIN_TAB_OPTIONS` 同步：`registrations`/`payments`/`clubs`/`settings`/`standby`/`feedback`/`linedigest`/`announce`）
- JWT 24h，`is_admin=1` 系統管理員、`admin_perms` 非空為次管理者；舊 token 無 `perms` 視同系統管理員；`clubs.admin_perms` 由 migration 建欄

### LINE / Gemini (`linebot.js`)
- `verifySignature` 需 `express.json({verify})` 存 `rawBody`；`handleLineEvent` 寫 `line_messages`/`line_sources`、任意 `groupId` 事件 upsert `line_group_id`；`「公告：」` 僅主群組回草稿不自動推
- 三層問答：`retrieveKnowledge()` (bigram+4碼) → `googleSearch`（`GEMINI_GROUNDING=on` 且 `grounding_YYYY-MM < 4800`，以 `groundingMetadata.groundingChunks` 判定真搜尋才計數）→ 忙線開 `【AI 未解答】` 單；`GEMINI_MODEL` 預設 `gemini-3.5-flash-lite`
- `generateAnnouncement` 群組版/各社版（`images` inline_data），`parseClubAnnouncements` 同社去重；`pushToGroup(Line群組公告/announce group/stats)` 需 `line_group_id`，個別 `pushToLineUser` 需對方加好友；`syncGroupMembers` 僅認證帳號可用全量，否則 fallback `line_messages.sender_id`

### Frontend
- 純 HTML/CSS/JS，無框架；`admin.html` 8 個 tab 依權限顯隱；`public/css` earthy 主題，`js/guide.js`/`css/guide.css` 導覽，`js/toast.js` 取代 `alert`

## Deployment
- 現役 **Render** `srv-da9a3opf2nfc73erdav0`，`https://registration-system-bxgr.onrender.com`；`POST /api/login` 180KB body 可探版本（新碼 10mb 限，舊碼 100kb 回 HTML 500）
- Free 層：15 分鐘休眠冷啟動 ~1 分、750h/月，靠 **UptimeRobot 5 分 ping `/health`** 保活（`.github/workflows/keepalive.yml` 的 `schedule` 在本 repo 實測不觸發，僅備援）
- `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` 必設；`LINE_CHANNEL_SECRET`/`LINE_CHANNEL_ACCESS_TOKEN`/`GEMINI_API_KEY`/`GEMINI_MODEL`/`GEMINI_GROUNDING`/`GEMINI_GROUNDING_MAX_MONTH` 選設；`JWT_SECRET` 未設時自動生成 64-hex 存 `settings.jwt_secret`

## Gotchas
- 時區：Turso 存 UTC，前端顯示 `new Date(v+'Z').toLocaleString('zh-TW',{timeZone:'Asia/Taipei'})`
- 繳費審核通過：同一 `club_id` 全 `registered → paid`
- 檔案皆記憶體上傳：`multer.memoryStorage`，魔數 sniff（JPG/PNG/GIF/PDF），`my-uploads`/`payment/all`/`backup` 不含 `file_data`
- 管理員下載（`export`/`backup`）須 `fetch` 帶 `Authorization` 轉 `blob` 再 `<a download>`，不可 `window.open`
- `pending`/`forfeited` 不可編輯/刪除報名
- `summary` 依最早註冊排序，無報名者置底；`today>payment_deadline` 時 header 與各列同切 `phase1PaidTotal`/`phase1_paid`
- `export` 彙整統計的 `rowCond/clubCond` 為內聯已校驗字面量（不可用 `?`，否則 libSQL 計數歸 0）；`registered→已報名/standby→候補/paid→已繳費/其餘→棄權`
- 公開 API 過濾：`GET /api/summary` 與 `backup` 過濾 `jwt_secret` + `stats_*`/`push_*`/`grounding_*`/`webhook_*`
- `/api/admin/settings` PUT 僅白名單 `phase1_deadline/payment_deadline/phase2_deadline/guaranteed_quota/phase1_total_quota/line_group_id/bot_name/stats_announce`
- 報名欄位長度上限與 `PUT clubs` 社名非空校驗；`restore` 預先全量校驗含 `jwt_secret`/惡意 `file_path`/非法 `club_id` → 400 不動 DB
