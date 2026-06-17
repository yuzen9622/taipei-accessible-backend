# 使用者路況回報系統
## Functional Specification — Hazard Report

**版本**：v1.0.0  
**狀態**：Proposed — 未實作  
**日期**：2026-06-17  
**作者**：yuzen9622

---

## 目錄

1. [系統概述](#1-系統概述)
2. [系統目標](#2-系統目標)
3. [系統架構](#3-系統架構)
4. [資料模型](#4-資料模型)
5. [API 規格](#5-api-規格)
6. [外部服務整合](#6-外部服務整合)
7. [照片儲存策略](#7-照片儲存策略)
8. [濫用防護](#8-濫用防護)
9. [實作 Roadmap](#9-實作-roadmap)
10. [測試策略](#10-測試策略)
11. [新增環境變數](#11-新增環境變數)
12. [新增 npm 依賴](#12-新增-npm-依賴)
13. [前端職責邊界](#13-前端職責邊界)
14. [風險與緩解](#14-風險與緩解)

---

## 1. 系統概述

使用者路況回報系統讓使用者以即時相機拍照，向系統回報在無障礙移動途中所遭遇的實際障礙——包含障礙物、施工圍籬、資料錯誤等類型。後端接收回報後依序執行：地理柵欄驗證、影像 EXIF 時間與 GPS 真實性驗證、Gemini Vision 影像比對，並將通過驗證的回報持久化至 MongoDB，同時開放附近查詢端點供前端地圖疊加顯示。

系統架構沿用專案既有的 Express + TypeScript + MongoDB(Mongoose) + Redis 技術棧，所有端點統一以 `sendResponse()`（`src/config/lib.ts`）包裝回應，Zod 負責請求驗證。

---

## 2. 系統目標

### 2.1 核心能力

- 接受含照片的即時路況回報，並在後端驗證回報可信度
- 20 公尺地理柵欄：拒絕距回報地點超過 20m 的請求
- 影像真實性驗證：EXIF 時間新鮮度、EXIF GPS 與宣稱座標一致性
- AI 影像比對：以 Gemini Vision 比對現場照片與 Google Street View 參考影像
- 附近回報查詢：以 MongoDB `$near` 提供地理範圍查詢
- 社群二次確認：其他使用者可確認或否認既有回報以提升可信度
- 自動過期：回報具備 TTL，時效過後自動從查詢結果中排除

### 2.2 非功能目標

| 目標 | 說明 |
|------|------|
| 後端統一驗證 | 地理柵欄與 EXIF 驗證皆在後端執行，前端無法繞過 |
| AI 僅作第一道過濾 | Gemini Vision 比對為輔助篩選，verdict 記錄但不強制擋，`rejected` 狀態需人工複核流程（本期未納入） |
| Fail-soft AI | Gemini Vision 呼叫失敗時回報降級為 `pending`，不阻擋回報提交 |
| 資料時效性 | 路況回報具時效，TTL 到期自動設 `expired`，不影響歷史查詢 |
| 路徑規劃暫不整合 | 本期回報僅供前端顯示，與路徑評分的整合列為未來選項（見 §9）|

---

## 3. 系統架構

### 3.1 請求流程

```
Client Request
      ↓
Express (src/app.ts)
      ↓
Multer Middleware（multipart/form-data 照片解析）
      ↓
Zod Validation Middleware (src/middleware/validate-request.middleware.ts)
      ↓
HazardReport Controller (src/modules/hazard-report/hazard-report.controller.ts)
      ↓
┌────────────────────────────────────────────────────────┐
│                HazardReport Service                    │
│  src/modules/hazard-report/hazard-report.service.ts    │
│                                                        │
│  ┌─────────────────┐  ┌─────────────────────────────┐  │
│  │ Geo Fence Check │  │ EXIF Validation             │  │
│  │ Haversine 20m   │  │ timestamp freshness         │  │
│  └─────────────────┘  │ GPS ↔ claimed coords        │  │
│                       └─────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────┐  │
│  │ Photo Upload                                     │  │
│  │ GCS Bucket (src/service/storage.service.ts)      │  │
│  └──────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────┐  │
│  │ AI Vision Verification                           │  │
│  │ Google Street View Static → Gemini Vision        │  │
│  │ src/service/hazard-ai-verify.service.ts          │  │
│  └──────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────┘
      ↓
HazardReport Model (src/model/hazard-report.model.ts)
      ↓
sendResponse() → ApiResponse<HazardReportData>
```

### 3.2 模組目錄結構

```
src/
├── modules/
│   └── hazard-report/
│       ├── hazard-report.controller.ts   # 端點邏輯
│       ├── hazard-report.service.ts      # 業務流程協調
│       ├── hazard-report.router.ts       # 路由定義（掛載至 a11y.route.ts）
│       └── hazard-report.schema.ts       # Zod schema
├── model/
│   └── hazard-report.model.ts            # Mongoose model
└── service/
    ├── storage.service.ts                # 照片上傳（GCS）
    └── hazard-ai-verify.service.ts       # Gemini Vision 比對
```

---

## 4. 資料模型

### 4.1 HazardReport（`src/model/hazard-report.model.ts`）

```typescript
import { Schema, model, Document } from 'mongoose'

// 回報類型
export type HazardType = 'obstacle' | 'construction' | 'data_error'

// AI 比對結果
export type AiVerdict = 'verified' | 'suspicious' | 'rejected' | 'skipped'

export interface IHazardReport extends Document {
  // 回報識別
  reporterId?: string          // 選用，使用者 ID（未登入可匿名）

  // 地點資訊
  reportedLocation: {          // 使用者宣稱的回報地點
    type: 'Point'
    coordinates: [number, number]  // [lng, lat]
  }
  reporterLocation: {          // 回報當下使用者的 GPS 座標
    type: 'Point'
    coordinates: [number, number]
  }
  distanceM: number            // Haversine 計算結果（公尺，記錄用）

  // 回報內容
  hazardType: HazardType
  description?: string         // 選用文字說明（最多 500 字）
  photoUrl: string             // 上傳後的公開 URL（GCS Signed URL 或 CDN URL）
  photoStoragePath: string     // bucket 內部路徑（用於刪除或重新取得）

  // EXIF 驗證結果
  exifValidation: {
    timestampFresh: boolean         // 拍攝時間距回報時間 ≤ 10 分鐘
    gpsPresent: boolean             // 照片含 EXIF GPS
    gpsMatchesClaimed: boolean      // EXIF GPS 與宣稱座標距離 ≤ 50m
    rawExifTime?: string            // ISO 8601 字串（記錄用）
    rawExifLat?: number
    rawExifLng?: number
  }

  // AI 影像比對結果
  aiVerification: {
    verdict: AiVerdict
    confidence: number              // 0.0 – 1.0
    reason: string                  // Gemini 回傳的判斷說明（繁中）
    referenceImageUrl?: string      // 使用的 Street View 參考影像 URL
    attemptedAt?: Date
  }

  // 狀態
  status: 'pending' | 'verified' | 'rejected' | 'expired'

  // 社群確認
  confirmCount: number         // 確認票數（其他使用者認同）
  denyCount: number            // 否認票數
  confirmedBy: string[]        // 已確認使用者 ID 清單（防重複投票）
  deniedBy: string[]           // 已否認使用者 ID 清單

  // 時間
  createdAt: Date
  updatedAt: Date
  expiredAt: Date              // TTL 欄位（建立時依 hazardType 計算）
}

const HazardReportSchema = new Schema<IHazardReport>(
  {
    reporterId: { type: String, default: null },

    reportedLocation: {
      type: { type: String, enum: ['Point'], required: true },
      coordinates: { type: [Number], required: true },
    },
    reporterLocation: {
      type: { type: String, enum: ['Point'], required: true },
      coordinates: { type: [Number], required: true },
    },
    distanceM: { type: Number, required: true },

    hazardType: {
      type: String,
      enum: ['obstacle', 'construction', 'data_error'],
      required: true,
    },
    description: { type: String, maxlength: 500, default: null },
    photoUrl: { type: String, required: true },
    photoStoragePath: { type: String, required: true },

    exifValidation: {
      timestampFresh: { type: Boolean, required: true },
      gpsPresent: { type: Boolean, required: true },
      gpsMatchesClaimed: { type: Boolean, required: true },
      rawExifTime: String,
      rawExifLat: Number,
      rawExifLng: Number,
    },

    aiVerification: {
      verdict: {
        type: String,
        enum: ['verified', 'suspicious', 'rejected', 'skipped'],
        required: true,
      },
      confidence: { type: Number, min: 0, max: 1, required: true },
      reason: { type: String, required: true },
      referenceImageUrl: String,
      attemptedAt: Date,
    },

    status: {
      type: String,
      enum: ['pending', 'verified', 'rejected', 'expired'],
      default: 'pending',
    },

    confirmCount: { type: Number, default: 0 },
    denyCount: { type: Number, default: 0 },
    confirmedBy: { type: [String], default: [] },
    deniedBy: { type: [String], default: [] },

    expiredAt: { type: Date, required: true },
  },
  { timestamps: true }
)

// Index 定義
HazardReportSchema.index({ reportedLocation: '2dsphere' })
HazardReportSchema.index({ status: 1, createdAt: -1 })
HazardReportSchema.index({ expiredAt: 1 }, { expireAfterSeconds: 0 }) // MongoDB TTL index
HazardReportSchema.index({ hazardType: 1, status: 1 })

export const HazardReport = model<IHazardReport>('HazardReport', HazardReportSchema)
```

### 4.2 TTL 策略

| hazardType | expiredAt 計算 | 說明 |
|------------|---------------|------|
| `obstacle` | `createdAt + 6 小時` | 障礙物通常短暫，若無確認自動過期 |
| `construction` | `createdAt + 7 天` | 施工工期較長 |
| `data_error` | `createdAt + 30 天` | 資料問題需較長觀察期 |

> MongoDB TTL index（`expireAfterSeconds: 0`）在 `expiredAt` 到期後**自動刪除**文件。  
> ⚠️ **待確認**：若需保留歷史紀錄（如統計或人工複核），建議改為定時任務將 `status` 更新為 `expired` 而非物理刪除，TTL index 則僅作為最終清理機制。

### 4.3 狀態機

```
             ┌─────────────────────┐
             │  POST /reports 提交  │
             └──────────┬──────────┘
                        ↓
                   [ pending ]
                        │
          ┌─────────────┼─────────────┐
          │             │             │
   AI: verified   AI: suspicious  AI: rejected
          │             │             │
      [ verified ]  [ pending ]  [ rejected ]
          │             │
     confirmCount    denyCount
       >= 3 加分     >= 3 加分
```

> `verified`：`aiVerification.verdict === 'verified'` 且 EXIF 驗證通過後，後端直接設定；  
> `rejected`：`aiVerification.verdict === 'rejected'`，或未來人工複核否決。

---

## 5. API 規格

### 5.1 端點總覽

| Method | Path | 功能 | 認證 |
|--------|------|------|------|
| `POST` | `/api/v1/a11y/reports` | 提交路況回報 | 公開（選用 JWT） |
| `GET` | `/api/v1/a11y/reports` | 查詢附近回報 | 公開 |
| `GET` | `/api/v1/a11y/reports/:id` | 取得單一回報 | 公開 |
| `POST` | `/api/v1/a11y/reports/:id/confirm` | 社群二次確認／否認 | 公開（選用 JWT） |

> 所有端點為公開路由（非 `/api/user/*`），不強制 JWT。若請求帶有有效 JWT，`reporterId`  
> 與 `confirmedBy` / `deniedBy` 會記錄使用者 ID。

---

### 5.2 POST /api/v1/a11y/reports — 提交路況回報

**Content-Type**：`multipart/form-data`

**請求欄位**

| 欄位 | 型別 | 必要 | 說明 |
|------|------|------|------|
| `photo` | File（JPEG/PNG） | 必要 | 即時拍攝照片，最大 10MB |
| `hazardType` | `obstacle` \| `construction` \| `data_error` | 必要 | 回報類型 |
| `reportedLat` | number | 必要 | 回報地點緯度 |
| `reportedLng` | number | 必要 | 回報地點經度 |
| `reporterLat` | number | 必要 | 使用者當前緯度（GPS） |
| `reporterLng` | number | 必要 | 使用者當前經度（GPS） |
| `description` | string | 選用 | 文字說明，最多 500 字元 |

**Zod Schema（`hazard-report.schema.ts`）**

```typescript
import { z } from 'zod'

export const CreateHazardReportSchema = z.object({
  // photo 欄位由 Multer 處理，不在 Zod body schema 內
  hazardType: z.enum(['obstacle', 'construction', 'data_error']),
  reportedLat: z.coerce.number().min(-90).max(90),
  reportedLng: z.coerce.number().min(-180).max(180),
  reporterLat: z.coerce.number().min(-90).max(90),
  reporterLng: z.coerce.number().min(-180).max(180),
  description: z.string().max(500).optional(),
})
```

**後端驗證流程**

```
1. Multer 解析 multipart，取得 photo buffer
2. Zod 驗證其餘欄位
3. Haversine 計算 reportedLocation ↔ reporterLocation 距離
   → 距離 > 20m → 400 GEOFENCE_VIOLATION
4. EXIF 解析（exifr 套件）
   a. 拍攝時間 vs 請求時間 > 10 分鐘 → exifValidation.timestampFresh = false
      → 整體 EXIF 驗證失敗 → 400 EXIF_TOO_OLD
   b. 有 GPS EXIF → 比對 EXIF GPS ↔ reporterLocation
      → 距離 > 50m → 400 EXIF_GPS_MISMATCH
5. 上傳照片至 GCS（storage.service.ts）
6. 觸發 AI 影像比對（非同步，不阻擋回應）
   a. 取得 Street View Static 參考影像（reportedLocation）
   b. Gemini Vision 比對，取得 verdict + confidence + reason
   c. 更新 aiVerification + 依 verdict 更新 status
7. 建立並儲存 HazardReport document
8. 回傳 201 + 回報資料
```

> ⚠️ **設計說明**：步驟 6 AI 比對採**非同步觸發**——照片上傳後，後端先回傳 `201 pending`，再以非同步方式執行 Gemini Vision 比對並更新 `aiVerification` 與 `status`。前端可透過 `GET /reports/:id` 輪詢或接受推播（本期未納入）。

**成功回應（201）**

```json
{
  "ok": true,
  "status": "success",
  "code": 201,
  "message": "回報已提交，正在進行影像驗證",
  "data": {
    "report": {
      "_id": "6670abc123def456",
      "hazardType": "obstacle",
      "reportedLocation": {
        "type": "Point",
        "coordinates": [121.5654, 25.0330]
      },
      "description": "人行道上有施工鐵板未固定",
      "photoUrl": "https://storage.googleapis.com/bucket/reports/6670abc123def456.jpg",
      "status": "pending",
      "exifValidation": {
        "timestampFresh": true,
        "gpsPresent": true,
        "gpsMatchesClaimed": true
      },
      "aiVerification": {
        "verdict": "skipped",
        "confidence": 0,
        "reason": "影像比對進行中"
      },
      "confirmCount": 0,
      "denyCount": 0,
      "createdAt": "2026-06-17T08:30:00.000Z",
      "expiredAt": "2026-06-17T14:30:00.000Z"
    }
  }
}
```

**錯誤回應**

| HTTP | code | message | 說明 |
|------|------|---------|------|
| 400 | `GEOFENCE_VIOLATION` | 使用者位置距回報地點超過 20 公尺 | Haversine 距離 > 20m |
| 400 | `EXIF_TOO_OLD` | 照片拍攝時間距回報時間超過 10 分鐘 | 疑似從相簿選取 |
| 400 | `EXIF_GPS_MISMATCH` | 照片 GPS 位置與宣稱位置不符 | EXIF GPS ↔ reporterLocation > 50m |
| 400 | `PHOTO_REQUIRED` | 未上傳照片 | Multer 未收到 photo 欄位 |
| 400 | `PHOTO_TOO_LARGE` | 照片超過 10MB | Multer 檔案大小限制 |
| 400 | `INVALID_PHOTO_TYPE` | 僅接受 JPEG 或 PNG | MIME type 不符 |
| 429 | `RATE_LIMITED` | 回報提交過於頻繁，請稍後再試 | Rate limit 觸發 |
| 500 | `UPLOAD_FAILED` | 照片上傳失敗，請重試 | GCS 上傳錯誤 |

```json
{
  "ok": false,
  "status": "error",
  "code": 400,
  "message": "使用者位置距回報地點超過 20 公尺",
  "data": {
    "reason": "GEOFENCE_VIOLATION",
    "distanceM": 47.3
  }
}
```

---

### 5.3 GET /api/v1/a11y/reports — 查詢附近回報

**Query Parameters**

| 參數 | 型別 | 必要 | 說明 |
|------|------|------|------|
| `lat` | number | 必要 | 查詢中心緯度 |
| `lng` | number | 必要 | 查詢中心經度 |
| `radius` | number | 選用 | 查詢半徑（公尺），預設 500，最大 5000 |
| `hazardType` | string | 選用 | 過濾回報類型（`obstacle` \| `construction` \| `data_error`） |
| `status` | string | 選用 | 過濾狀態，預設 `pending,verified`（逗號分隔） |
| `limit` | number | 選用 | 回傳筆數上限，預設 20，最大 50 |

**查詢邏輯**

```typescript
// 排除 expired / rejected，依距離排序
HazardReport.find({
  reportedLocation: {
    $near: {
      $geometry: { type: 'Point', coordinates: [lng, lat] },
      $maxDistance: radius,
    },
  },
  status: { $in: statusFilter },
  ...(hazardType ? { hazardType } : {}),
})
  .select('-photoStoragePath -confirmedBy -deniedBy')
  .limit(limit)
```

**成功回應（200）**

```json
{
  "ok": true,
  "status": "success",
  "code": 200,
  "message": "找到 2 筆附近路況回報",
  "data": {
    "reports": [
      {
        "_id": "6670abc123def456",
        "hazardType": "obstacle",
        "reportedLocation": {
          "type": "Point",
          "coordinates": [121.5654, 25.0330]
        },
        "description": "人行道上有施工鐵板未固定",
        "photoUrl": "https://storage.googleapis.com/bucket/reports/6670abc123def456.jpg",
        "status": "verified",
        "aiVerification": {
          "verdict": "verified",
          "confidence": 0.87,
          "reason": "照片顯示與街景相符之施工現場，可見鐵板障礙"
        },
        "confirmCount": 3,
        "denyCount": 0,
        "createdAt": "2026-06-17T08:30:00.000Z",
        "expiredAt": "2026-06-17T14:30:00.000Z"
      }
    ],
    "total": 2,
    "queryCenter": { "lat": 25.033, "lng": 121.5654 },
    "radiusM": 500
  }
}
```

---

### 5.4 GET /api/v1/a11y/reports/:id — 取得單一回報

**路徑參數**

| 參數 | 說明 |
|------|------|
| `id` | MongoDB ObjectId 字串 |

**成功回應（200）**：回傳完整 `HazardReport` document（同 §5.3 格式）。

**錯誤回應**

| HTTP | code | message |
|------|------|---------|
| 400 | `INVALID_ID` | 無效的回報 ID 格式 |
| 404 | `REPORT_NOT_FOUND` | 找不到對應的回報 |

---

### 5.5 POST /api/v1/a11y/reports/:id/confirm — 社群二次確認

**Content-Type**：`application/json`

**請求 Body**

```json
{
  "action": "confirm"
}
```

| 欄位 | 型別 | 必要 | 說明 |
|------|------|------|------|
| `action` | `confirm` \| `deny` | 必要 | 確認或否認此回報 |

**後端邏輯**

```
1. 查詢 HazardReport，確認存在且 status != 'expired'
2. 若請求帶有 JWT，取出 userId；否則以 IP hash 作匿名識別碼
3. 檢查 confirmedBy / deniedBy 清單，同一使用者不可重複投票
4. action === 'confirm' → confirmCount += 1，userId 加入 confirmedBy
   action === 'deny'    → denyCount += 1，  userId 加入 deniedBy
5. 回傳更新後的票數
```

**成功回應（200）**

```json
{
  "ok": true,
  "status": "success",
  "code": 200,
  "message": "已確認此回報",
  "data": {
    "reportId": "6670abc123def456",
    "action": "confirm",
    "confirmCount": 4,
    "denyCount": 0
  }
}
```

**錯誤回應**

| HTTP | code | message |
|------|------|---------|
| 400 | `INVALID_ID` | 無效的回報 ID 格式 |
| 400 | `ALREADY_VOTED` | 您已對此回報投過票 |
| 404 | `REPORT_NOT_FOUND` | 找不到對應的回報 |
| 410 | `REPORT_EXPIRED` | 此回報已過期，無法投票 |

---

## 6. 外部服務整合

### 6.1 Google Street View Static API（參考影像來源）

**用途**：取得回報地點的街景或衛星影像，作為 AI 影像比對的基準。

**請求格式**

```
GET https://maps.googleapis.com/maps/api/streetview
  ?size=640x640
  &location={lat},{lng}
  &fov=80
  &heading=0
  &key={GOOGLE_MAPS_API_KEY}
```

**策略**：

1. 以回報地點座標查詢 Street View Static，取 640×640 JPEG。
2. 若 Street View 回傳 ZERO_RESULTS（無街景覆蓋），改以 **Static Maps API** 取衛星影像（`maptype=satellite`）。
3. 參考影像 URL 記錄於 `aiVerification.referenceImageUrl`，供後續稽核。

> ⚠️ **待確認**：Street View Static 每次呼叫計費，建議評估是否以 URL hash 快取（Redis，TTL 7 天）減少重複查詢。使用的 API Key 為現有的 `GOOGLE_MAPS_API_KEY`（`src/config/map.ts`）。

---

### 6.2 Gemini Vision 影像比對（`src/service/hazard-ai-verify.service.ts`）

**模型**：`gemini-2.5-flash`（`GEMINI_MODEL` 環境變數，與現有 AI 功能共用設定）

**呼叫方式**：使用現有的 OpenAI 相容端點（`GEMINI_API_URL`），以 multimodal message 傳入兩張圖（Street View 參考 + 使用者上傳）。

**Prompt 設計（系統指令）**

```
你是一個路況回報真實性驗證助手。你會收到兩張圖片：
第一張是 Google Street View 或衛星圖（參考影像），
第二張是使用者在現場即時拍攝的照片。

請判斷：
1. 兩張照片是否拍攝自相同或鄰近的實際地點？
2. 照片中是否有可見的路況障礙（障礙物、施工、破損等）？

請以 JSON 格式回傳以下欄位：
{
  "verdict": "verified" | "suspicious" | "rejected",
  "confidence": 0.0 ~ 1.0,
  "reason": "繁體中文說明（最多 100 字）"
}

判斷標準：
- verified：場景地點相符，且照片中可見合理障礙
- suspicious：場景疑似相符但障礙不明確，或地點稍有偏差
- rejected：照片與參考場景明顯不符，或無任何障礙可見
```

**回傳解析**

```typescript
interface AiVerifyResult {
  verdict: 'verified' | 'suspicious' | 'rejected'
  confidence: number
  reason: string
}
```

**Fail-soft 策略**

| 情境 | 處理 |
|------|------|
| Gemini API 呼叫失敗 | `verdict: 'skipped'`，`confidence: 0`，`reason: 'AI 服務暫時不可用'`，`status` 維持 `pending` |
| Street View ZERO_RESULTS | 改用 Static Maps 衛星圖；若仍失敗則 `verdict: 'skipped'` |
| JSON 解析失敗 | `verdict: 'skipped'` |
| 超時（10 秒） | `verdict: 'skipped'` |

---

### 6.3 EXIF 解析（`exifr` 套件）

**解析欄位**

| EXIF 欄位 | 用途 |
|----------|------|
| `DateTimeOriginal` | 拍攝時間，比對請求時間是否在 10 分鐘內 |
| `GPSLatitude` / `GPSLongitude` | 比對是否與 `reporterLocation` 在 50m 內 |

**邊界條件**

| 情境 | 處理 |
|------|------|
| 照片無任何 EXIF | `timestampFresh: false`，`gpsPresent: false`，`gpsMatchesClaimed: false` → 400 EXIF_TOO_OLD |
| 照片有時間戳但無 GPS | `gpsPresent: false`，`gpsMatchesClaimed: false`；時間戳仍驗證 |
| 時間戳格式異常無法解析 | 視同無時間戳，`timestampFresh: false` → 400 EXIF_TOO_OLD |

> ⚠️ **待確認**：部分 Android 相機 App 以 UTC 儲存 EXIF 時間（無時區標記），驗證時需以 UTC 比對，或要求前端另外傳入設備時間（`deviceTimestamp`）作為對照。

---

## 7. 照片儲存策略

**建議採用 Google Cloud Storage（GCS）Bucket**，而非 MongoDB GridFS。

### 7.1 選擇依據

| 面向 | GCS Bucket | GridFS |
|------|-----------|--------|
| 擴充性 | 無上限，CDN 整合容易 | MongoDB 受儲存空間限制 |
| 讀取效能 | CDN 快取，靜態 URL | 每次查詢走 MongoDB Streaming |
| 費用 | 依用量計費（GCS 標準儲存） | MongoDB Atlas 儲存費用較高 |
| 管理複雜度 | 需額外設定 bucket + IAM | 零外部依賴 |
| 現有技術棧吻合度 | 已有 `GOOGLE_MAPS_API_KEY`，同一 GCP 專案 | 無額外依賴 |

**結論**：採用 GCS，建立專用 bucket `taipei-a11y-hazard-reports`，照片以 `reports/{reportId}.jpg` 路徑儲存，上傳後取得公開 CDN URL 記錄於 `photoUrl`。

### 7.2 上傳流程

```typescript
// src/service/storage.service.ts
async function uploadHazardPhoto(
  buffer: Buffer,
  reportId: string,
  mimeType: 'image/jpeg' | 'image/png'
): Promise<{ url: string; storagePath: string }>
```

### 7.3 生命週期

- 照片與 `HazardReport` document 同步存活；
- `expiredAt` TTL 到期後，建議由定時任務（Cloud Scheduler 或 Node.js cron）刪除對應 GCS 物件，避免無效存儲累積。

---

## 8. 濫用防護

### 8.1 Rate Limit

以 `express-rate-limit` + Redis 儲存（`ioredis`，與現有 Redis 共用）實作：

| 端點 | 限制 | 時間窗 | 識別鍵 |
|------|------|--------|--------|
| `POST /reports` | 3 次 | 10 分鐘 | IP |
| `POST /reports/:id/confirm` | 10 次 | 1 分鐘 | IP |
| `GET /reports` | 30 次 | 1 分鐘 | IP |

觸發 rate limit 時回傳 429 + `RATE_LIMITED`。

### 8.2 同地點重複回報合併

提交回報前，查詢是否已有 50m 內、同 `hazardType`、`status` 為 `pending` 或 `verified` 的回報：

```typescript
const existing = await HazardReport.findOne({
  reportedLocation: {
    $near: {
      $geometry: { type: 'Point', coordinates: [reportedLng, reportedLat] },
      $maxDistance: 50,
    },
  },
  hazardType,
  status: { $in: ['pending', 'verified'] },
})
```

- **有近似回報**：不建立新 document，改以 `POST /reports/:id/confirm` 邏輯自動對既有回報加 `confirmCount += 1`，回傳 200 + 既有回報資料（`merged: true`）。
- **無近似回報**：正常建立新 document。

---

## 9. 實作 Roadmap

### 待實作

| Phase | 功能 | 優先度 | 依賴 |
|-------|------|--------|------|
| **S1** | 基礎架構：`HazardReport` model、Multer 中介層、Zod schema、路由掛載 | Critical | — |
| **S2** | `POST /reports`：地理柵欄 + EXIF 驗證 + GCS 上傳 + document 建立（AI 比對先以 `skipped` 佔位） | Critical | S1 |
| **S3** | `GET /reports`、`GET /reports/:id`：地理查詢端點 | High | S1 |
| **S3** | `POST /reports/:id/confirm`：社群確認端點 | High | S1 |
| **S4** | `hazard-ai-verify.service.ts`：Street View 取圖 + Gemini Vision 比對 + 非同步 status 更新 | High | S2 |
| **S5** | Rate limit（`express-rate-limit` + Redis）+ 同地點重複回報合併 | Medium | S1 |
| **S6** | GCS 照片生命週期清理任務（TTL 到期後刪除 bucket 物件） | Low | S2 |
| **Future** | 環境感知路徑規劃：將 `verified` 回報餵入路徑評分以動態避開障礙（本期不納入，路徑規劃端另立規格） | — | 路徑規劃重構 |

---

### S1 詳細：基礎架構

**新增檔案**

```
src/
├── model/
│   └── hazard-report.model.ts
├── modules/
│   └── hazard-report/
│       ├── hazard-report.controller.ts
│       ├── hazard-report.service.ts
│       ├── hazard-report.router.ts
│       └── hazard-report.schema.ts
└── service/
    └── storage.service.ts
```

**掛載路由**：在現有 `src/routes/a11y.route.ts` 引入 `hazard-report.router.ts`：

```typescript
import hazardReportRouter from '../modules/hazard-report/hazard-report.router'
router.use('/reports', hazardReportRouter)
```

---

### S4 詳細：AI 影像比對服務

**新增檔案**：`src/service/hazard-ai-verify.service.ts`

**流程**

```
1. 以 reportedLocation 呼叫 Street View Static API → 取得參考影像 buffer
2. 讀取 GCS 已上傳的使用者照片（或從 buffer 直接傳入，避免二次下載）
3. 以 Gemini Vision（@google/genai SDK）multimodal 呼叫
4. 解析 JSON verdict
5. updateOne HazardReport：aiVerification + status
```

---

## 10. 測試策略

> 沿用 `CLAUDE.md` 說明，本專案目前無正式測試框架。以下為建議手動測試案例。

### 10.1 手動測試案例

| 測試案例 | 輸入條件 | 預期結果 |
|---------|---------|---------|
| 正常提交 | 距離 < 20m、EXIF 時間新鮮、GPS 吻合 | 201 pending，文件建立 |
| 地理柵欄拒絕 | reporterLocation 距 reportedLocation 25m | 400 GEOFENCE_VIOLATION |
| EXIF 過舊 | 照片拍攝於 15 分鐘前 | 400 EXIF_TOO_OLD |
| EXIF GPS 不符 | EXIF GPS 距 reporterLocation 100m | 400 EXIF_GPS_MISMATCH |
| 無 EXIF 照片 | 截圖或純白圖 | 400 EXIF_TOO_OLD |
| AI skipped 情境 | Gemini API Key 無效 | 201 pending，verdict: skipped |
| 附近查詢 | lat/lng/radius 正常值 | 200，回傳距離排序清單 |
| 超出範圍查詢 | radius=10000（超過 5000m 上限） | 400 驗證錯誤 |
| 重複同地點回報 | 50m 內已有相同 hazardType pending 回報 | 200 merged:true，confirmCount+1 |
| Rate limit | 同 IP 1 分鐘內送 4 次 POST | 第 4 次 429 RATE_LIMITED |
| 社群確認重複 | 同使用者對同回報 confirm 兩次 | 400 ALREADY_VOTED |

### 10.2 驗證重點

- Haversine 計算正確性（20m 邊界值：19.9m 允許，20.1m 拒絕）
- EXIF 時間解析：UTC 與本地時間差異處理
- GCS 上傳後 `photoUrl` 可公開存取
- MongoDB TTL index 在 `expiredAt` 後確實觸發刪除
- 2dsphere index 的 `$near` 查詢以距離正確排序
- AI 比對非同步更新後，`GET /reports/:id` 反映最新 verdict

---

## 11. 新增環境變數

| 變數 | 用途 | 必要性 | 預設值 |
|------|------|--------|--------|
| `GCS_BUCKET_NAME` | GCS bucket 名稱，照片儲存目標 | **必要** | — |
| `GCS_KEY_FILE` | GCS Service Account JSON 金鑰路徑（或使用 Workload Identity） | **必要**（GCS 認證） | — |
| `HAZARD_REPORT_MAX_DISTANCE_M` | 地理柵欄最大允許距離（公尺） | 選配 | `20` |
| `HAZARD_PHOTO_MAX_SIZE_MB` | 照片檔案大小上限（MB） | 選配 | `10` |
| `STREET_VIEW_CACHE_TTL_SEC` | Street View 參考影像的 Redis 快取 TTL（秒） | 選配 | `604800`（7 天） |
| `USE_HAZARD_AI_VERIFY` | `false` 時跳過 Gemini Vision 比對（省 API 費用 / 開發環境） | 選配 | `true` |

> `GOOGLE_MAPS_API_KEY` 及 `GEMINI_API_KEY` / `GEMINI_API_URL` / `GEMINI_MODEL` 已存在於現有環境，無需重複新增。

---

## 12. 新增 npm 依賴

| 套件 | 用途 | 版本建議 |
|------|------|---------|
| `@google-cloud/storage` | GCS Bucket 操作（上傳、刪除、取得 URL） | `^7.x` |
| `exifr` | EXIF 解析（時間戳、GPS），支援 JPEG/HEIC | `^7.x` |
| `multer` | multipart/form-data 照片解析 | `^1.x` |
| `express-rate-limit` | IP-based rate limiting | `^7.x` |
| `rate-limit-redis` | express-rate-limit 的 Redis store（與現有 ioredis 整合） | `^4.x` |

> ⚠️ `multer` 與 `@types/multer` 請同步安裝。`exifr` 為 ESM-first 套件，TypeScript 設定需確認 `moduleResolution: "bundler"` 或以動態 import 引入。

---

## 13. 前端職責邊界

### 13.1 前端負責

| 職責 | 說明 |
|------|------|
| 即時相機啟動 | 強制開啟裝置相機 API，**禁止從相簿選取**，由前端 UI 層面限制 |
| GPS 擷取 | 以 Geolocation API 取得使用者當前座標，傳入 `reporterLat/Lng` |
| 回報表單 UI | 選擇 hazardType、輸入 description、拍照並預覽 |
| 地圖疊加顯示 | 呼叫 `GET /reports` 取得附近回報，於地圖 render 標記 |
| 狀態輪詢 | 回報提交後，視需求輪詢 `GET /reports/:id` 以顯示 AI 驗證結果 |
| 確認 / 否認互動 | 呼叫 `POST /reports/:id/confirm` |

### 13.2 前端不負責（後端職責）

| 禁止事項 | 原因 |
|---------|------|
| 地理柵欄計算 | 後端以 Haversine 重新計算，前端傳入座標僅作顯示用 |
| EXIF 驗證 | 後端解析 EXIF，前端無法可靠讀取所有 MIME 類型的 EXIF |
| AI 影像比對 | Gemini Vision 呼叫在後端執行，API Key 不外露 |
| 相簿選取限制邏輯 | **後端補強**：EXIF 時間戳與 GPS 驗證是防相簿選取的後端把關機制；前端相機限制屬 UX 層，後端驗證才是實質關卡 |
| 照片上傳至 GCS | storage.service.ts 在後端處理，GCS 憑證不外露 |

---

## 14. 風險與緩解

| 風險 | 影響 | 緩解策略 |
|------|------|---------|
| **EXIF 剝除**：部分裝置或社群媒體 App 自動剝除 EXIF | EXIF 驗證失效，回報被擋 | 無 EXIF GPS 時允許僅以時間戳驗證（降級允許），但記錄 `gpsPresent: false` 作為信心度參考 |
| **EXIF 偽造**：進階使用者手動修改 EXIF 後再拍照 | 繞過時間戳與 GPS 驗證 | Gemini Vision 比對為獨立第二道過濾；可評估加入 perceptual hash 比對（未來選項） |
| **Gemini Vision 誤判**：場景外觀相似但地點不同 | `suspicious/rejected` 誤殺真實回報 | AI verdict 不直接刪除回報，`rejected` 需社群否認達門檻或人工複核才真正排除 |
| **GCS 費用失控**：大量照片上傳 | 雲端費用超出預期 | Multer 檔案大小 10MB 上限 + rate limit 3 次/10 分鐘；TTL 到期後清理過期照片 |
| **Street View API 費用**：每次回報觸發一次 Street View 呼叫 | Maps API 費用 | Redis 快取相同座標的 Street View URL（TTL 7 天）；`USE_HAZARD_AI_VERIFY=false` 可關閉 |
| **環境感知路徑規劃整合**：本期回報未餵入路徑評分，使用者期待路線自動避障 | 功能落差 | Roadmap Future 列入；本期文件及前端應明確說明「回報供顯示，路線規劃不受影響」 |
| **TDX 額度**：Hazard Report 系統本身不呼叫 TDX，但若未來整合路徑規劃，附近回報查詢可能觸發更多 TDX 路線查詢 | 429 rate limit | 整合時參照 [[tdx-quota-and-data-drift]] 的緩解策略 |
