# 區會報名系統

## 功能

- 各社以社號+密碼登入報名
- 支援兩階段報名（日期驅動：第一階段截止、繳費截止、第二階段截止，自動遞補與棄權）
- 繳費證明上傳與管理員審核
- 公開統計頁面（僅顯示各社報名人數）
- 管理者後台（報名管理、繳費審核、社團管理、系統設定）
- 匯出 Excel 彙整表

## 本地執行

```bash
npm install
npm start
```

開啟瀏覽器訪問 http://localhost:3000

## 預設帳號

| 帳號 | 密碼 | 說明 |
|------|------|------|
| admin | admin123 | 管理員 |
| 2401 | 2401 | 眉溪社（各社預設密碼為社號後四碼） |

## Railway 部署

1. 建立 GitHub repo 並上傳程式碼
2. 前往 [Railway](https://railway.app) 註冊帳號
3. 點擊 "New Project" → "Deploy from GitHub repo"
4. 選擇此 repo
5. 在 Railway Dashboard → Variables 添加以下環境變數：
   - `TURSO_DATABASE_URL`: Turso 資料庫 URL（`libsql://...` 格式）
   - `TURSO_AUTH_TOKEN`: Turso 資料庫 token（`turso db tokens create` 產生）
   - `JWT_SECRET`: 任意隨機字串（建議設定；未設定時使用隨機密鑰，重啟後所有登入將失效）
6. Railway 會自動部署

## 檔案結構

```
├── server.js           # Express 主程式
├── database.js         # 資料庫操作
├── deadlines.js        # 日期驅動階段狀態機 + 自動遞補/棄權
├── auth.js             # JWT 認證
├── public/             # 前端頁面
├── uploads/            # 繳費證明存放

└── railway.json        # Railway 部署設定
```

## 報名規則（日期驅動、自動執行）

- **總名額 160 人**（`phase1_total_quota`）＝正式名單上限，第一、二階段合計
- **占位數**＝`registered + paid` 人數；候補、棄權不計入 160
- **第一階段**（`今天 <= phase1_deadline`）：報名中；單社超過保障名額（10）或占位數已滿 160 → 轉候補
- **第一階段截止後**（`phase1_deadline < 今天 <= payment_deadline`）：停止受理第一階段報名，候補依登錄順序自動遞補至 160
- **繳費截止日隔天**（`今天 > payment_deadline`）：無已確認繳費證明的社團，其第一階段報名自動轉棄權（視同未報名），空缺再依序遞補
- **第二階段**（`payment_deadline < 今天 <= phase2_deadline`）：有剩餘名額才開放；占位數滿 160 時新增報名轉候補（供人工調節）
- **第二階段截止日隔天**（`今天 > phase2_deadline`）：第二階段未繳費者轉棄權，不再遞補，全面停止報名
- **日期以台灣時區比對，截止日當天仍屬期限內，於隔一天執行**；管理員在「系統設定」調整日期，目前階段由日期自動推算（唯讀顯示）
- 候補清單（含第一、二階段）可在管理後台檢視，人工遞補按鈕同樣受 160 上限約束
