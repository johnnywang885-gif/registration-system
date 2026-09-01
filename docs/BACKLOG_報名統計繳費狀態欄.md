# BACKLOG｜報名統計「繳費狀態」欄位增修

> 建立日：2026-09-02　狀態：**凍結（報名期間不動，10/20 二階截止後再施作）**  
> 來源：`public/summary.html` 顯示討論 — 春陽 5 人全已繳費卻顯示 `5 (保障0/候補0)` 造成誤解  
> 決策：顯示層屬小問題，首重報名流程穩定，暫不改動，僅註記日後增修

## 一、已確認需求（2026-09-02 用戶定案）

1. **保障定義**：`保障 = registered` 維持現狀（`server.js:273`），不改為 `registered+paid`
2. **零繳費顯示**：新欄位若 `phase1_paid == 0` 顯示 `未繳費`（灰字），而非 `已繳費(0)`
3. **表頭日期格式**：`繳費狀態 (截止: 2026-09-30)`，取 `settings.payment_deadline`，`YYYY-MM-DD`，與 `thPhase1/thPhase2` 一致
4. **匯出 Excel**：`server.js:1245-1253` 彙整統計工作表**暫不動**，日後有需要再專修

## 二、現況與問題

* 後端 `server.js:266-297` `/api/summary` 已回 `phase1_registered / phase1_standby / phase1_paid / phase1_total / phase2_count / settings.payment_deadline / today`
* 前端 `public/summary.html:77-106` 依 `afterPayment = today > payment_deadline` 分支：
  * 截止前：`<strong>total</strong> (保障${registered}/候補${standby})` — 隱藏 `paid`
  * 截止後：`<strong>paid</strong> (已完成報名並繳費...)`
* 致全繳費社團 `registered=0, paid=5` 顯示 `5 (保障0/候補0)`，用戶期望看到繳費資訊

## 三、未來增修計畫（報名結束後，預估半日工）

### 改動範圍（僅前端，不動後端/DB/截止邏輯）
* `public/summary.html:44-54` 表頭插入新欄：
  ```html
  <th>社號</th><th>社名</th><th id="thPhase1">第一階段</th><th id="thPayment">繳費狀態</th><th id="thPhase2">第二階段</th><th>最後登錄時間</th>
  ```
  空狀態 `colspan="5"` → `6`

* `public/summary.html:88-106` `loadSummary()`：
  ```js
  const paymentHeader = paymentDeadline ? `繳費狀態 (截止: ${paymentDeadline})` : '繳費狀態';
  document.getElementById('thPayment').textContent = paymentHeader;
  // 列
  `<td><strong>${s.phase1_total}</strong> <span style="font-size:12px;color:#8d7b6b">(保障${s.phase1_registered}/候補${s.phase1_standby})</span></td>
   <td>${s.phase1_paid > 0 ? `已繳費(${s.phase1_paid})` : '<span style="color:#999">未繳費</span>'}</td>
   <td><strong>${s.phase2_count}</strong></td>`
  ```
  保留 `afterPayment` 僅用於頂卡或移除，列渲染不再分支；`保障` 文案不變

* `public/summary.html:125-129` `GUIDE_STEPS` 更新第一階段說明為「中間欄位顯示已繳費人數」

### 不改動
* `server.js`、`/api/summary`、匯出 `XLSX`、`deadlines.js` 截止/遞補/釋放邏輯、`public/admin.html` 序號欄

## 四、風險評估

* 純顯示層，理論零風險，但仍需重新部署 Render（冷啟動、健康檢查），報名期間凍結可避免不必要回歸

## 五、驗證（施作時執行）

* 語法：`node --check server.js deadlines.js database.js auth.js linebot.js knowledge_import.js stats_announce.js`
* 本地 `TURSO_DATABASE_URL=file:...` 灌 `backup_2026-09-01.json`，驗 `2409` 顯示 `保障0/候補0 | 已繳費(5)`、`paid=0` 顯示 `未繳費`、跨 `payment_deadline` 前後表頭日期、空資料 `colspan`
* `test/review_b_export.js` 確認匯出不影響

## 六、報名規則備忘（凍結期間首重）

* 一階報名：即日起至 2026-09-20；繳費截止：2026-09-30；二階報名：至 2026-10-20；`taipeiToday()` 台北時間當日有效
* 每社保障 10 名、總額 160 人；超額自動候補；棄權按 `created_at` 遞補，已繳費社團優先；逾繳費截止自動釋放未繳費名額

---
*此檔為待辦清單，施作前請再次確認 `settings` 三截止日為上述日期*
