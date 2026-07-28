# 區會報名系統

## 功能

- 各社以社號+密碼登入報名
- 支援兩階段報名（第一階段截止 9/20，第二階段截止 10/20）
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
5. 在 Settings → Variables 添加：
   - `JWT_SECRET`: 任意隨機字串
   - `PORT`: 3000
6. Railway 會自動部署

## 檔案結構

```
├── server.js           # Express 主程式
├── database.js         # 資料庫操作
├── auth.js             # JWT 認證
├── public/             # 前端頁面
├── uploads/            # 繳費證明存放
├── data/               # SQLite 資料庫
└── railway.json        # Railway 部署設定
```

## 報名規則

- 第一階段截止：9/20
- 每社保障名額：10 名
- 繳費截止：9/30（未繳費者視為棄權）
- 第二階段截止：10/20
