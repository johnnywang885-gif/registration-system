# AGENTS.md

## Project
區會報名系統 — Node.js/Express + Turso libSQL + JWT。部署 Render（2026-08-29 自 Railway 遷入，Railway 配置保留但不用）。單套件，無 build/lint/test 腳本。`README.md` 過時，以此檔為準。

## Commands
```bash
npm install
npm start          # 需 TURSO_DATABASE_URL，否則 /api 全 500
npm run dev        # node --watch
```
`dotenv` 載 `.env`（gitignored）。本地無憑證時用 `TURSO_DATABASE_URL=file:C:/abs/path.db` + `TURSO_AUTH_TOKEN=` 可跑全端；`JWT_SECRET` 未設則啟動時自動生成 64-hex 存 `settings.jwt_secret`。

## Verify
- 語法：`node --check server.js deadlines.js database.js auth.js linebot.js knowledge_import.js stats_announce.js`
- Node `22.x`（`package.json:engines`，`pdf-parse` 需 `process.getBuiltinModule` ≥20.16，勿刪）
- 擬真資料：`GET /api/admin/backup`（正式 admin 密碼）→ 灌進本地 `file:` 庫 → 改 `settings` 截止日測 `deadlines.js`（勿對正式庫執行 `runEnforcement`/restore）
- Windows：`file:` 庫被 `server.js` 佔用時先殺進程再刪檔；中文亂碼 `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8`
- Gemini：`node test/check_gemini_key.js` 測 `GEMINI_API_KEY` + `GEMINI_GROUNDING=on`（付費 key 才有 grounding）

### Regression (`test/` 需逐一跑、不同 port、`*.db` gitignored)
- `review_a_flap.js` — 無 HTTP，驗遞補不回跳（`[stats_announce] CLIENT_CLOSED` 為 15s→60min timer 殘影屬正常）
- `review_b_export.js` (34891) — `standby → 候補` 映射；`review_c_backup.js` — 還原真實 backup 到本地 `file:`（不碰正式庫）
- `review_d_rule_timeline.js` (34892) — 7 階段時間線
- `review_e_line_digest.js`(34895) / `review_f_announce.js`(34897, grounding 4800) / `review_g_knowledge.js`(34899) / `review_h_doc_import.js`(34898) / `review_j_announce_image.js`(34915) / `review_l_payment_blob.js`(34917)
- `review_i_security.js`(34914) — settings 白名單、JWT、魔數 sniff、xlsx、S1-S6、`jwt_secret` 過濾、路徑 containment；`review_k_stats_announce.js`(34916) — `dayMultiple5`/`buildStatsMessage`/去重/`stats_announce` 開關/`push_YYYY-MM` 預算
- `sim_*` 為情境模板；`sim_frontend_boot.js`(34900) 取代 `npm start` 供 MCP 瀏覽器；`phase2_standby.js`/`simulate.js` 已廢棄

### MCP
`opencode.json` 連 `http://127.0.0.1:9222`，每 session 先 `pwsh test/launch-chrome.ps1`；`evaluate_script` 比 click/fill 穩，導覽遮罩先按「關閉導覽」；`test/_*.js`、`test/*.db`、`test/.chrome-profile/` 皆 gitignored。

## Architecture

### Startup Order（不可調，`server.js:112`）
1. `GET /health` 2. 註冊路由 3. 全域 error handler 4. `app.listen()` 5. `initDatabase()` 非阻塞 `.then()`
- 若 `initDatabase` 在 `listen` 前或阻塞，Render 健康檢查 30s 內 502

### DB (`database.js`)
- `@libsql/client`，`db=null` 直到 `initDatabase`；`getAll/getOne/runQuery/insert` 皆先判 `!db`；`batch(write)` 建表與批次寫入；`saveDatabase()` 為 no-op
- 表：`clubs`(`is_admin`/`admin_perms` JSON)、`registrations`、`payment_proofs`(`file_data` BLOB，`file_path` 僅虛擬路徑)、`settings`、`feedback`、`line_messages`/`line_sources`、`knowledge`(`source_file`)
- `payment_proofs.file_data` 為主體（重啟不丟），`backup` 不含 `file_data`；`GET /api/payment/file/:id` 優先 DB blob，fallback 僅遷移相容且做 `../` containment

### Phase (`deadlines.js`)
- 由日期推算非 `current_phase`：`today<=phase1_deadline → phase1`；`phase1<today<=payment → phase1_closed`；`payment<today<=phase2 → phase2`；`>phase2 → closed`（`taipeiToday()` 台北 `YYYY-MM-DD`，當天計入）
- `phase1_total_quota` 預設 160（占位=`registered`+`paid`，含督導/幹事 2 席；候補/棄權不占位）；`enforceDeadlines` 掛 `/api` 中介層 + 啟動一次，5s debounce；`runEnforcement()` 回 `{changed}` 才 `scheduleStatsAnnounce()`
- `POST /api/admin/promote` 與 `promote/:id` 受 160 上限；`standby-list` 含兩階段依 `created_at`
- 幹部保障：`is_admin=1` 或 `admin_perms` 非空者以本帳號 `POST /api/registrations`（`position=督導/幹事`）視為保障佔位——跳過 `guaranteed_quota`/`occupancy` 判定，`forfeitUnpaidByPhase` 亦排除，免繳費不棄權

### Stats Announce (`stats_announce.js` + `linebot.js:pushToDetail`)
- 雙觸發：異動（註冊/刪除/繳費/遞補/清空/還原/`runEnforcement`）→ `CHANGE_DEBOUNCE_MS=60min` 合併；隔 5 日（5/10/15/20/25/30 `dayMultiple5()`）→ `PERIODIC_INTERVAL 30min` setInterval，當日 `stats_announce_date` 去重
- 內容 `collectStats()` 各階段人數 + 繳費社數 + 剩餘；`stats_announce=off` 全停（`settings` 白名單）；`change` 時 `stats_last_snapshot` 相同跳過
- 月預算 `push_YYYY-MM` 計成功 `push`。**群組推播依收件者人數計費**（LINE 官方：訊息數 = 收到訊息的人數），故群組成本 = 群組成員數、個人 = 1；`targetCost()` 為唯一入口。41 人群組推 1 則 = 記 41
- `PUSH_MAX=200`（`PUSH_MONTHLY_LIMIT`）是**自訂安全天花板非 LINE 實際配額**；權威數字為 `GET /message/quota`（`getLineQuota()`，60s 快取）+ `/message/quota/consumption`。`canPush()` 與 `stats_announce` 的 WARN 護欄**一律優先採信官方剩餘**，僅在查不到官方配額時才退回本地估算——否則本地髒值會鎖死推播
- **勿**在遇 `You have reached your monthly limit` 時把本地計數寫死成 `MAX`：官方 FAQ 明載即使仍有額度，也可能因其他訊息正在投遞、額度被暫時預 reserve 而誤報 429。舊版因此一次誤報鎖死整月（2026-09/10 皆發生）。現行為僅清 `quotaCache` 讓下次重查
- 群組成員數來源順序：`line_group_members` 快取（24h TTL，`syncGroupMembers` 預熱）→ 後台設定 `line_group_size` → 1
- **`members/ids` 常回 403**：機器人未取得該群組「允許讀取成員資料」同意時一律 403（正式環境 2026-10-03 實測），快取永遠為 0。**勿**因為拿不到人數就假設成本=1，必須靠後台設定的 `line_group_size`（設定頁「主群組成員人數」）
- `recordPushUse` 為 SQL 原子累加（`CAST(CAST(value AS INTEGER) + ? AS TEXT)`），勿改回 read-then-write
- 診斷：`GET /api/admin/line-quota`（`linedigest` 權限，`?refresh=1` 強制重查，含 `group.member_source`）；`POST /api/admin/push-budget/reset`（`settings` 權限）歸零當月本地計數
- 下月 key 重置（`review_k` 守護）
- 實測（2026-10-03）：官方 `limit=200 used=200 remaining=0`，5 則群組統計 × 41 人 ≈ 205 則即耗盡月免費額度。**重置本地計數不會恢復官方額度**（兩者是不同東西）；11/1 前無法推播，期間用免額度替代方案
- 免額度：主群組 `統計/報名進度/目前報名/查統計` → `replyMessage` 回 `buildStatsMessage()`；後台 `GET /api/admin/stats-message` 回同款文字供複製手貼

### Auth (`auth.js`)
- `authMiddleware` / `anyAdminMiddleware` / `adminMiddleware` / `requirePerm(key)`（`ADMIN_PERMS` 與 `admin.html:ADMIN_TAB_OPTIONS` 同步：`registrations`/`payments`/`clubs`/`settings`/`standby`/`feedback`/`linedigest`/`announce`）
- JWT 24h；`is_admin=1` 系統管理員、`admin_perms` 非空為次管理者；舊 token 無 `perms` 視同系統管理員

### LINE / Gemini (`linebot.js`)
- `verifySignature` 需 `express.json({verify})` 存 `rawBody`；`handleLineEvent` 寫 `line_messages`/`line_sources`、任意 `groupId` 事件 upsert `line_group_id`；`「公告：」` 僅主群組回草稿
- 三層問答：`retrieveKnowledge()` (bigram+4碼) → `googleSearch`（`GEMINI_GROUNDING=on` 且 `grounding_YYYY-MM < 4800`，以 `groundingChunks` 判定才計數）→ 忙線開 `【AI 未解答】` 單；`GEMINI_MODEL` 預設 `gemini-3.5-flash-lite`
- `generateAnnouncement` 群組版/各社版（`images` inline_data），`parseClubAnnouncements` 同社去重；`pushToGroup` 需 `line_group_id`，`pushToLineUser` 需對方加好友；`syncGroupMembers` 認證帳號可用全量，否則 fallback `line_messages.sender_id`

### Frontend
- 純 HTML/CSS/JS 無框架；`admin.html` 8 tab 依權限顯隱（保障入口 `admin.html:18` 常顯），報名管理表格含 `序號` 欄（`admin.html:552`，匯出同步）；`public/css` earthy 主題，`js/guide.js`/`css/guide.css` 導覽，`js/toast.js` 取代 `alert`

## Deploy
- 現役 Render `srv-da9a3opf2nfc73erdav0`，`https://registration-system-bxgr.onrender.com`；`POST /api/login` 180KB body 可探版本（新 10mb，舊 100kb 回 HTML 500）
- Free 層 15分休眠冷啟動 ~1分、750h/月，靠 **UptimeRobot 5分 ping `/health`** 保活（`.github/workflows/keepalive.yml` 的 `schedule` 在本 repo 實測不觸發僅備援）
- 需：`TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`；選：`LINE_CHANNEL_SECRET`/`LINE_CHANNEL_ACCESS_TOKEN`/`GEMINI_API_KEY`/`GEMINI_MODEL`/`GEMINI_GROUNDING`/`GEMINI_GROUNDING_MAX_MONTH`；`JWT_SECRET` 未設自動生成

## Gotchas
- 時區：Turso 存 UTC，前端 `new Date(v+'Z').toLocaleString('zh-TW',{timeZone:'Asia/Taipei'})`
- 繳費審核：同一 `club_id` 全 `registered → paid`
- 檔案皆 `multer.memoryStorage`，魔數 sniff（JPG/PNG/GIF/PDF），`my-uploads`/`payment/all`/`backup` 不含 `file_data`
- 管理員下載（`export`/`backup`）須 `fetch` 帶 `Authorization` 轉 `blob` 再 `<a download>`，不可 `window.open`
- `pending`/`forfeited` 不可編輯/刪除報名
- `summary` 依最早註冊排序，無報名者置底；`today>payment_deadline` 時 header 與各列同切 `phase1PaidTotal`/`phase1_paid`
- `export` 的 `rowCond/clubCond` 為內聯已校驗字面量（不可用 `?`，否則 libSQL 歸 0）；`registered→已報名/standby→候補/paid→已繳費/其餘→棄權`
- 公開 API 過濾：`GET /api/summary` 與 `backup` 過濾 `jwt_secret` + `stats_*`/`push_*`/`grounding_*`/`webhook_*`/**`line_*`**（`line_group_id` 與成員數快取屬內部識別資訊）
- `/api/admin/settings` PUT 僅白名單 `phase1_deadline/payment_deadline/phase2_deadline/guaranteed_quota/phase1_total_quota/line_group_id/line_group_size/bot_name/stats_announce`
- 欄位長度上限與 `PUT clubs` 社名非空校驗；`restore` 預先全量校驗 `jwt_secret`/惡意 `file_path`/非法 `club_id` → 400 不動 DB
