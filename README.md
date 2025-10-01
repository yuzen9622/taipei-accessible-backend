# Taipei Accessible Backend

這是台北無障礙後端 API 服務，使用 TypeScript 和 Express.js 建構。

## 功能特色

- ✅ TypeScript 支援
- ✅ Express.js 框架
- ✅ CORS 跨域支援
- ✅ Helmet 安全性中介軟體
- ✅ Morgan 日誌記錄
- ✅ 環境變數管理
- ✅ 開發熱重載 (nodemon)
- ✅ 健康檢查端點
- ✅ 錯誤處理機制

## 快速開始

### 安裝依賴

```bash
npm install
```

### 環境設定

複製環境變數範例檔案：

```bash
copy .env.example .env
```

修改 `.env` 檔案中的設定：

```env
PORT=3000
NODE_ENV=development
CORS_ORIGIN=http://localhost:3000
```

### 開發模式

```bash
npm run dev
```

### 建構專案

```bash
npm run build
```

### 生產環境執行

```bash
npm start
```

## API 端點

### 基本端點

- `GET /` - 歡迎頁面
- `GET /health` - 健康檢查
- `GET /api/test` - API 測試端點

### 健康檢查

```bash
curl http://localhost:3000/health
```

回應：

```json
{
  "status": "OK",
  "message": "Server is running",
  "timestamp": "2024-01-01T12:00:00.000Z"
}
```

## 專案結構

```
taipei-accessible-backend/
├── src/
│   ├── app.ts          # Express 應用程式設定
│   └── server.ts       # 伺服器啟動檔案
├── dist/               # 編譯後的 JavaScript 檔案
├── .env.example        # 環境變數範例
├── .gitignore         # Git 忽略檔案
├── nodemon.json       # Nodemon 設定
├── package.json       # 專案設定
├── tsconfig.json      # TypeScript 設定
└── README.md          # 專案說明
```

## 開發指令

| 指令            | 說明                          |
| --------------- | ----------------------------- |
| `npm run dev`   | 開發模式啟動 (使用 nodemon)   |
| `npm run build` | 建構 TypeScript 到 JavaScript |
| `npm start`     | 生產模式啟動                  |
| `npm run clean` | 清理 dist 資料夾              |

## 環境變數

| 變數名稱      | 預設值      | 說明            |
| ------------- | ----------- | --------------- |
| `PORT`        | 3000        | 伺服器埠號      |
| `NODE_ENV`    | development | 執行環境        |
| `CORS_ORIGIN` | \*          | CORS 允許的來源 |

## 貢獻

1. Fork 此專案
2. 建立功能分支 (`git checkout -b feature/AmazingFeature`)
3. 提交變更 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 開啟 Pull Request

## 授權

此專案採用 ISC 授權條款。
