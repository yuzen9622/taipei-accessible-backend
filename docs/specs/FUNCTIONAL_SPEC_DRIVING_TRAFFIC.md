# 家屬開車路況查詢系統
## Functional Specification — Driving Traffic & Parking for Family Caregivers

**版本**：v1.0.0  
**狀態**：Proposed — 未實作  
**日期**：2026-06-17  
**作者**：yuzen9622

---

## 目錄

1. [系統概述](#1-系統概述)
2. [系統目標](#2-系統目標)
3. [系統架構](#3-系統架構)
4. [外部資料來源整合](#4-外部資料來源整合)
5. [API 規格](#5-api-規格)
6. [快取策略](#6-快取策略)
7. [資料模型](#7-資料模型)
8. [實作 Roadmap](#8-實作-roadmap)
9. [測試策略](#9-測試策略)
10. [新增環境變數](#10-新增環境變數)
11. [前端職責邊界](#11-前端職責邊界)
12. [風險與緩解](#12-風險與緩解)

---

## 1. 系統概述

### 1.1 功能定位

本功能面向**開車的家屬**，協助其在接送行動不便者（輪椅使用者、長者、視障者）時，預先掌握行車路況、停車位可用性與沿途測速照相位置，降低因塞車或繞行造成的被接送者等待困境。

### 1.2 Scope 邊界（重要）

| 項目 | 本功能 | 無障礙核心路由 |
|------|--------|--------------|
| 服務對象 | **開車的家屬**（駕駛人） | 輪椅 / 長者 / 視障使用者本人 |
| 查詢模式 | 自駕路況、停車場車位、測速照相 | 大眾運輸、步行、無障礙路徑 |
| 資料來源 | TISV 高公局、traffic.transportdata.tw、data.gov.tw | TDX、GTFS、ORS、OSM |
| 無障礙評分 | **不涉及**（無 a11y scoring） | 核心職責（`a11y-scoring.ts`） |
| 路由引擎 | 無（僅資訊查詢，不計算駕車路徑） | ORS + OTP2 + TDX MaaS |

> **本功能為輔助性、資訊查詢性質，與行人無障礙核心路由完全分離，不影響無障礙路徑評分、不共用 a11y 相關資料模型。**

### 1.3 整合外部來源概覽

| 來源 | 用途 | 更新頻率 | 授權 |
|------|------|---------|------|
| **TISV 高公局** (`tisvcloud.freeway.gov.tw`) | 國道 eTag 旅行時間、VD 車流、交通事件、CCTV | 1–5 分鐘 | 公開，無需金鑰 |
| **traffic.transportdata.tw** | 市區即時路況、停車場即時車位 | 1–3 分鐘 | 透過 TDX OAuth（沿用 `tdxFetch()`） |
| **data.gov.tw 測速照相** (`dataset/7320`) | 固定式測速照相位置（靜態） | 不定期（月/季更新） | 公開，無需金鑰 |

---

## 2. 系統目標

### 2.1 核心能力

- 查詢國道指定路段的 eTag 旅行時間與壅塞程度
- 查詢目的地附近停車場的即時剩餘車位（支援地理搜尋）
- 查詢路線沿途或指定區域的固定式測速照相位置
- 提供聚合查詢介面，一次回傳行車所需的多項資訊

### 2.2 非功能目標

| 目標 | 說明 |
|------|------|
| 與無障礙核心分離 | 不引用 `a11y-scoring.ts`、`accessible-route.service.ts` |
| TDX 配額保護 | 停車場即時資料以 Redis 短 TTL 快取，避免連續呼叫觸發 429 |
| 靜態資料預匯入 | 測速照相以匯入腳本寫入 MongoDB，零查詢時外部呼叫 |
| Fail-soft 降級 | 某資料來源失敗仍部分回傳，不因單一來源壞掉導致整體 500 |
| 統一回應格式 | 所有端點沿用 `sendResponse()` 包裝格式 |

---

## 3. 系統架構

### 3.1 請求流程

```
Client Request
      ↓
Express (src/app.ts)
      ↓
Zod Validation Middleware
      ↓
Traffic Route Controller (src/modules/traffic/)
      ↓
┌─────────────────────────────────────────┐
│         Traffic Service                 │
│  src/modules/traffic/traffic.service.ts │
│                                         │
│  ┌────────────────────────────────────┐ │
│  │  TISV Freeway Service              │ │
│  │  (eTag 旅行時間 / 事件)             │ │
│  └────────────────────────────────────┘ │
│  ┌────────────────────────────────────┐ │
│  │  TDX Parking Service               │ │
│  │  (即時停車場車位)                   │ │
│  │  tdxFetch() — 沿用既有 OAuth        │ │
│  └────────────────────────────────────┘ │
│  ┌────────────────────────────────────┐ │
│  │  Speed Camera Service              │ │
│  │  (SpeedCamera model — MongoDB)     │ │
│  └────────────────────────────────────┘ │
└─────────────────────────────────────────┘
      ↓
Redis 快取層
      ↓
ApiResponse<TrafficData>
```

### 3.2 模組目錄結構

```
src/
├── modules/
│   └── traffic/
│       ├── traffic.controller.ts    # 路由 handler
│       ├── traffic.router.ts        # /api/v1/traffic/*
│       ├── traffic.schema.ts        # Zod 驗證 schema
│       ├── traffic.service.ts       # 聚合邏輯
│       ├── freeway.service.ts       # TISV 高公局
│       ├── parking.service.ts       # TDX 停車場
│       └── speed-camera.service.ts  # SpeedCamera model 查詢
├── model/
│   └── speed-camera.model.ts        # 新增靜態資料模型（2dsphere）
└── scripts/
    └── import-speed-cameras.ts      # 靜態資料匯入腳本
```

### 3.3 路由掛載

```typescript
// src/app.ts（新增一行）
import trafficRouter from './modules/traffic/traffic.router'
app.use('/api/v1/traffic', trafficRouter)
```

新路由群組 `/api/v1/traffic` 為**公開端點**，不經過 JWT middleware（與 `/api/transit` 一致）。

---

## 4. 外部資料來源整合

### 4.1 TISV 高公局（tisvcloud.freeway.gov.tw）

#### 基本資訊

| 項目 | 說明 |
|------|------|
| Base URL | `https://tisvcloud.freeway.gov.tw/history/TDCS/` |
| 授權 | 公開，無需金鑰 |
| 格式 | XML（主要）、JSON（部分端點） |
| 更新頻率 | 每 5 分鐘（eTag 旅行時間）；每分鐘（VD 車流） |

#### 使用端點

| 代碼 | 功能 | 說明 |
|------|------|------|
| **M03A** | eTag 對 eTag 路段旅行時間 | 指定路段平均旅行時間（秒） |
| **M04A** | eTag 對 eTag 配對數量 | 有效配對筆數（可判斷資料可信度） |
| **M05A** | eTag 路段即時旅行時間 | 含速率與壅塞等級 |

> ⚠️ **待確認**：TISV XML 端點的精確 URL 格式需以實際 API 文件核對；目前查得路徑為 `https://tisvcloud.freeway.gov.tw/history/TDCS/M05A/{YYYYMMDD}/{HH}/{YYYYMMDDHHMMSS}.xml`，後端需自行計算最近一份有效時間戳。

#### Fetch 封裝

TISV 不使用 TDX OAuth，需獨立封裝：

```typescript
// src/modules/traffic/freeway.service.ts

async function tisvFetch(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'Accept': 'application/xml' },
    signal: AbortSignal.timeout(8000)   // 8s timeout
  })
  if (!res.ok) throw new Error(`TISV ${res.status}`)
  return res.text()
}
```

XML 解析建議使用 `fast-xml-parser`（不新增依賴風險，輕量）。

#### 欄位對應（M05A eTag 旅行時間）

| TISV 欄位 | 後端欄位 | 說明 |
|----------|---------|------|
| `SectionID` | `sectionId` | 路段代碼 |
| `SectionName` | `sectionName` | 路段名稱（如「汐止系統-南港系統」） |
| `TravelTime` | `travelTimeSec` | 旅行時間（秒） |
| `Speed` | `speedKmh` | 平均速率（km/h） |
| `Congestion` | `congestionLevel` | 壅塞等級（1=順暢/2=壅塞/3=嚴重壅塞） |
| `UpdateTime` | `updatedAt` | 資料更新時間（ISO 8601） |

---

### 4.2 TDX 停車場（traffic.transportdata.tw）

#### 基本資訊

| 項目 | 說明 |
|------|------|
| Base URL | `https://tdx.transportdata.tw/api/basic/v1/Parking/` |
| 授權 | TDX OAuth2 — **沿用** `tdxFetch()` + `TdxTokenManger`（無需新憑證） |
| 格式 | JSON |
| 更新頻率 | 即時（1–3 分鐘） |

> ⚠️ **TDX 配額警示**：停車場即時 API 每次查詢計入 TDX 額度。規格要求所有呼叫走 Redis TTL 2 分鐘快取，嚴禁前端高頻輪詢直接穿透後端至 TDX。

#### 使用端點

| 端點 | 功能 |
|------|------|
| `GET /api/basic/v1/Parking/OffStreet/CarPark` | 路外停車場清單（靜態基本資訊） |
| `GET /api/basic/v1/Parking/OffStreet/CarPark/Availability` | 路外停車場即時剩餘車位 |

#### 欄位對應

| TDX 欄位 | 後端欄位 | 說明 |
|---------|---------|------|
| `CarParkID` | `carParkId` | 停車場代碼 |
| `CarParkName.Zh_tw` | `name` | 停車場中文名稱 |
| `CarParkPosition.PositionLat` | `location.coordinates[1]` | 緯度 |
| `CarParkPosition.PositionLon` | `location.coordinates[0]` | 經度 |
| `SpaceFor.CarSpace` | `totalSpaces` | 總車位數 |
| `AvailableSpaces` | `availableSpaces` | 即時剩餘車位 |
| `UpdateTime` | `updatedAt` | 資料更新時間 |

---

### 4.3 data.gov.tw 測速照相（dataset/7320）

#### 基本資訊

| 項目 | 說明 |
|------|------|
| 資料集 URL | `https://data.gov.tw/dataset/7320` |
| 格式 | CSV |
| 授權 | 政府資料開放授權條款 v1.0（公開，無需金鑰） |
| 更新頻率 | **靜態**（不定期，月 / 季更新） |
| 匯入策略 | 預匯入至 `SpeedCamera` collection（2dsphere），查詢時零外部呼叫 |

#### 匯入腳本

```bash
npx ts-node src/scripts/import-speed-cameras.ts
```

腳本流程：
1. 從 data.gov.tw 下載最新 CSV 檔（或手動放置於 `data/speed-cameras/speed_cameras.csv`）
2. 解析 CSV，欄位對應見 §7.1
3. 批次 `bulkWrite`（每批 500 筆），以 `cameraId` upsert
4. 輸出：匯入筆數 / 耗時 / 錯誤數

---

## 5. API 規格

### 5.1 端點總覽

| Method | Path | 功能 | 資料來源 |
|--------|------|------|---------|
| `GET` | `/api/v1/traffic/freeway` | 國道路段旅行時間查詢 | TISV M05A |
| `GET` | `/api/v1/traffic/parking` | 目的地附近停車場剩餘車位 | TDX + `$near` |
| `GET` | `/api/v1/traffic/speed-cameras` | 區域測速照相點查詢 | SpeedCamera（MongoDB） |
| `GET` | `/api/v1/traffic/driving` | **聚合端點**：停車場 + 測速照相合併回傳 | 上述 2–3 項 |

#### 端點設計取捨說明

- **分端點**：各來源獨立，前端可依需求選擇呼叫，較靈活；適合僅需單項資訊的場景。
- **聚合端點 `/api/v1/traffic/driving`**：一次呼叫取得停車場 + 測速照相，減少前端往返次數；適合「到達目的地前的一次性查詢」場景。國道旅行時間因為查詢條件（路段 ID / 起迄）差異較大，**不納入聚合端點**，保持獨立。

---

### 5.2 國道路段旅行時間查詢

**端點**：`GET /api/v1/traffic/freeway`

**Zod Schema**

```typescript
const FreewayQuerySchema = z.object({
  sectionIds: z.string().optional(),    // 逗號分隔路段代碼，如 "01F0010,01F0020"
  highway: z.enum(["1", "2", "3", "5", "6", "10"]).optional(),  // 國道編號
  direction: z.enum(["N", "S", "E", "W"]).optional(),           // 行駛方向
})
```

> ⚠️ **待確認**：TISV M05A 實際支援的篩選方式（路段代碼格式）需以 TISV 文件核對。

**請求範例**

```http
GET /api/v1/traffic/freeway?highway=1&direction=N
```

**回應範例**

```json
{
  "ok": true,
  "status": "success",
  "code": 200,
  "message": "查詢成功",
  "data": {
    "sections": [
      {
        "sectionId": "01F0010",
        "sectionName": "汐止系統-南港系統",
        "highway": "1",
        "direction": "N",
        "travelTimeSec": 420,
        "speedKmh": 85,
        "congestionLevel": 1,
        "congestionLabel": "順暢",
        "updatedAt": "2026-06-17T08:30:00+08:00"
      },
      {
        "sectionId": "01F0020",
        "sectionName": "南港系統-基隆端",
        "highway": "1",
        "direction": "N",
        "travelTimeSec": 1080,
        "speedKmh": 28,
        "congestionLevel": 3,
        "congestionLabel": "嚴重壅塞",
        "updatedAt": "2026-06-17T08:30:00+08:00"
      }
    ],
    "dataSource": "TISV M05A",
    "cachedAt": "2026-06-17T08:31:00+08:00"
  }
}
```

**壅塞等級對應**

| `congestionLevel` | `congestionLabel` | 說明 |
|------------------|------------------|------|
| 1 | 順暢 | 速率 > 60 km/h |
| 2 | 壅塞 | 速率 30–60 km/h |
| 3 | 嚴重壅塞 | 速率 < 30 km/h |

**錯誤回應**

```json
{
  "ok": false,
  "status": "error",
  "code": 503,
  "message": "國道路況資料暫時無法取得",
  "data": {
    "reason": "TISV_UNAVAILABLE",
    "suggestion": "請稍後再試，或直接查詢高公局官網"
  }
}
```

---

### 5.3 目的地附近停車場剩餘車位查詢

**端點**：`GET /api/v1/traffic/parking`

**Zod Schema**

```typescript
const ParkingQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radiusM: z.coerce.number().int().min(100).max(2000).default(500),
  limit: z.coerce.number().int().min(1).max(20).default(10),
  minAvailable: z.coerce.number().int().min(0).default(0),  // 0 = 顯示全部（含滿）
})
```

**請求範例**

```http
GET /api/v1/traffic/parking?lat=25.0478&lng=121.5171&radiusM=500&minAvailable=1
```

**回應範例**

```json
{
  "ok": true,
  "status": "success",
  "code": 200,
  "message": "找到 5 個停車場",
  "data": {
    "parkings": [
      {
        "carParkId": "TPE001234",
        "name": "台北車站停車場",
        "distanceM": 180,
        "location": {
          "lat": 25.0480,
          "lng": 121.5168
        },
        "totalSpaces": 320,
        "availableSpaces": 42,
        "occupancyRate": 0.87,
        "status": "available",
        "updatedAt": "2026-06-17T08:29:00+08:00"
      },
      {
        "carParkId": "TPE001235",
        "name": "忠孝東路地下停車場",
        "distanceM": 430,
        "location": {
          "lat": 25.0465,
          "lng": 121.5200
        },
        "totalSpaces": 180,
        "availableSpaces": 0,
        "occupancyRate": 1.0,
        "status": "full",
        "updatedAt": "2026-06-17T08:28:00+08:00"
      }
    ],
    "queryLocation": { "lat": 25.0478, "lng": 121.5171 },
    "radiusM": 500,
    "dataSource": "TDX Parking",
    "cachedAt": "2026-06-17T08:30:30+08:00"
  }
}
```

**`status` 欄位規則**

| 條件 | `status` |
|------|---------|
| `availableSpaces > 0` | `"available"` |
| `availableSpaces == 0` | `"full"` |
| TDX 未回傳即時車位（僅有靜態資料） | `"unknown"` |

**後端實作說明**

停車場即時車位查詢**不使用 MongoDB 2dsphere**（TDX 回傳的是全市清單），而是：
1. 以 `tdxFetch()` 取得全市停車場即時車位（Redis TTL 2 分鐘快取）
2. 在後端以 Haversine 篩選 `radiusM` 範圍內的停車場
3. 依 `distanceM` 升冪排序，取 `limit` 筆

> ⚠️ **待確認**：TDX 停車場 API 是否支援 `$top` / 地理篩選參數（若有則優先用 API 側篩選以減少傳輸量）。

**錯誤回應**

```json
{
  "ok": false,
  "status": "error",
  "code": 503,
  "message": "停車場即時資料暫時無法取得",
  "data": {
    "reason": "TDX_PARKING_UNAVAILABLE"
  }
}
```

---

### 5.4 區域測速照相點查詢

**端點**：`GET /api/v1/traffic/speed-cameras`

**Zod Schema**

```typescript
const SpeedCameraQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radiusM: z.coerce.number().int().min(100).max(10000).default(3000),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  minSpeedLimit: z.coerce.number().int().optional(),   // 篩選速限門檻，單位 km/h
})
```

**請求範例**

```http
GET /api/v1/traffic/speed-cameras?lat=25.0478&lng=121.5171&radiusM=5000
```

**回應範例**

```json
{
  "ok": true,
  "status": "success",
  "code": 200,
  "message": "找到 8 個測速照相",
  "data": {
    "cameras": [
      {
        "cameraId": "N1-001-N",
        "name": "國道1號 汐止路段（北上）",
        "location": {
          "lat": 25.0612,
          "lng": 121.6234
        },
        "distanceM": 1840,
        "roadName": "國道1號",
        "direction": "北上",
        "speedLimitKmh": 110,
        "cameraType": "fixed"
      },
      {
        "cameraId": "TPE-K002",
        "name": "忠孝東路四段定點測速",
        "location": {
          "lat": 25.0416,
          "lng": 121.5503
        },
        "distanceM": 3200,
        "roadName": "忠孝東路四段",
        "direction": null,
        "speedLimitKmh": 50,
        "cameraType": "fixed"
      }
    ],
    "queryLocation": { "lat": 25.0478, "lng": 121.5171 },
    "radiusM": 5000,
    "dataSource": "SpeedCamera（data.gov.tw dataset/7320）",
    "dataUpdatedAt": "2026-05-01T00:00:00+08:00"
  }
}
```

---

### 5.5 聚合端點（停車場 + 測速照相）

**端點**：`GET /api/v1/traffic/driving`

**Zod Schema**

```typescript
const DrivingQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  parkingRadiusM: z.coerce.number().int().min(100).max(2000).default(500),
  cameraRadiusM: z.coerce.number().int().min(100).max(10000).default(3000),
  parkingLimit: z.coerce.number().int().min(1).max(20).default(5),
  cameraLimit: z.coerce.number().int().min(1).max(30).default(10),
})
```

**請求範例**

```http
GET /api/v1/traffic/driving?lat=25.0478&lng=121.5171&parkingRadiusM=500&cameraRadiusM=5000
```

**回應範例**

```json
{
  "ok": true,
  "status": "success",
  "code": 200,
  "message": "查詢成功",
  "data": {
    "parking": {
      "items": [ /* 同 §5.3 parkings 陣列 */ ],
      "ok": true,
      "error": null
    },
    "speedCameras": {
      "items": [ /* 同 §5.4 cameras 陣列 */ ],
      "ok": true,
      "error": null
    },
    "queryLocation": { "lat": 25.0478, "lng": 121.5171 }
  }
}
```

**降級處理**：某子查詢失敗時，對應的 `ok` 設為 `false`、`error` 填錯誤原因字串，另一子查詢結果仍正常回傳，整體 HTTP 狀態碼仍為 `200`。

```json
{
  "ok": true,
  "status": "success",
  "code": 200,
  "message": "部分資料暫時無法取得",
  "data": {
    "parking": {
      "items": [],
      "ok": false,
      "error": "TDX_PARKING_UNAVAILABLE"
    },
    "speedCameras": {
      "items": [ /* 正常資料 */ ],
      "ok": true,
      "error": null
    },
    "queryLocation": { "lat": 25.0478, "lng": 121.5171 }
  }
}
```

---

### 5.6 共用錯誤碼

| Code | HTTP 狀態 | 說明 |
|------|----------|------|
| `TISV_UNAVAILABLE` | 503 | TISV 高公局 API 無法連線 |
| `TDX_PARKING_UNAVAILABLE` | 503 | TDX 停車場 API 無法連線或 429 |
| `INVALID_COORDINATES` | 400 | 座標超出台灣範圍（參考：緯度 21–26、經度 119–123） |
| `SPEED_CAMERA_DB_ERROR` | 500 | MongoDB SpeedCamera 查詢失敗 |

---

## 6. 快取策略

### 6.1 Redis 快取設計

所有即時資料查詢結果寫入 Redis，Key 格式與 TTL 如下：

| 資料 | Redis Key 格式 | TTL | 說明 |
|------|--------------|-----|------|
| TISV 國道路況 | `traffic:freeway:{highway}:{direction}` | **3 分鐘** | TISV 每 5 分鐘更新，3 分鐘 TTL 確保不過舊 |
| TISV 路段（by ID） | `traffic:freeway:section:{sectionId}` | **3 分鐘** | 同上 |
| TDX 停車場車位（全市） | `traffic:parking:{cityCode}` | **2 分鐘** | 停車場更新頻繁，2 分鐘平衡即時性與配額 |
| TDX API 失敗結果 | `traffic:parking:{cityCode}` | **30 秒** | 失敗短快取，避免 429 造成 2 分鐘盲區（同 Phase 15 慣例） |

> **SpeedCamera**（測速照相）為靜態 MongoDB 查詢，不使用 Redis 快取。

### 6.2 快取更新策略

- **即時資料（TISV / TDX）**：Cache-aside 模式（先查 Redis，miss 再打 API，寫回 Redis）。
- **靜態資料（SpeedCamera）**：透過 `import-speed-cameras.ts` 手動或排程重匯，與 Redis 無關。
- **TDX 停車場**：每次 cache miss 取整個城市的停車場清單（約數百筆），存入 Redis，後端在 Redis 的 JSON 內進行地理篩選，減少後續 TTL 內的 TDX 呼叫次數至 0。

### 6.3 TTL 參數表

| 環境變數（建議） | 預設值 | 說明 |
|---------------|--------|------|
| `TRAFFIC_FREEWAY_TTL_SEC` | `180` | TISV 路況快取秒數 |
| `TRAFFIC_PARKING_TTL_SEC` | `120` | TDX 停車場快取秒數 |
| `TRAFFIC_PARKING_ERR_TTL_SEC` | `30` | TDX 停車場失敗快取秒數 |

---

## 7. 資料模型

### 7.1 SpeedCamera（`src/model/speed-camera.model.ts`）

測速照相為靜態政府資料，預匯入 MongoDB，使用 2dsphere index 支援地理查詢。

```typescript
interface ISpeedCamera {
  cameraId: string          // 唯一識別碼（data.gov.tw 欄位，⚠️ 待確認欄位名稱）
  name: string              // 設備名稱或描述
  roadName: string          // 所在道路名稱
  direction?: string        // 行駛方向（北上/南下/東行/西行，部分資料無此欄）
  speedLimitKmh?: number    // 速限（km/h）
  cameraType: "fixed"       // 目前 dataset/7320 僅含固定式；區間式視資料而定
  county?: string           // 縣市
  location: {
    type: "Point"
    coordinates: [number, number]   // [lng, lat]，GeoJSON
  }
  importedAt: Date          // 匯入時間戳
}

// Index
SpeedCameraSchema.index({ location: "2dsphere" })
SpeedCameraSchema.index({ cameraId: 1 }, { unique: true })
SpeedCameraSchema.index({ county: 1 })
```

> ⚠️ **待確認**：data.gov.tw dataset/7320 的 CSV 欄位名稱（如 `設備編號`、`架設地點`、`速限`）需下載實際資料後核對，匯入腳本欄位對應依此調整。

### 7.2 停車場（無新增 MongoDB 模型）

停車場即時車位資料**不建立 MongoDB 模型**，直接以 Redis 快取 TDX JSON 回應。理由：

- TDX 提供的停車場清單可能每月異動（新增 / 關閉），若存入 MongoDB 需維護同步機制
- 停車場數量（每城市數百筆）遠小於 SpeedCamera 或 GTFS，直接 in-memory 篩選可接受
- 節省模型維護成本

若未來需要「靜態停車場資料補強（如無障礙停車格數量）」，再規劃 `ParkingLot` model。

---

## 8. 實作 Roadmap

### 待實作

| Phase | 功能 | 優先度 | 前置條件 |
|-------|------|--------|---------|
| **Phase DT-1** | SpeedCamera model + 匯入腳本 `import-speed-cameras.ts` | **Critical** | data.gov.tw CSV 欄位確認 |
| **Phase DT-2** | 測速照相查詢端點 `GET /api/v1/traffic/speed-cameras` | **High** | Phase DT-1 |
| **Phase DT-3** | 停車場即時車位端點 `GET /api/v1/traffic/parking` + Redis 快取 | **High** | TDX 停車場 API 端點確認 |
| **Phase DT-4** | 聚合端點 `GET /api/v1/traffic/driving` | **Medium** | Phase DT-2 + DT-3 |
| **Phase DT-5** | TISV 國道路況端點 `GET /api/v1/traffic/freeway` + XML 解析 | **Medium** | TISV M05A URL 格式確認 |
| **Phase DT-6** | 定期重匯測速照相（排程腳本或手動 npm script） | **Low** | Phase DT-1 |

### Phase DT-1 — SpeedCamera 匯入腳本（詳細）

**新增檔案**：

```
src/model/speed-camera.model.ts
src/scripts/import-speed-cameras.ts
data/speed-cameras/           ← 加入 .gitignore（CSV 不入 repo）
```

**匯入腳本流程**（比照 `src/scripts/import-gtfs-stops.ts`）：

```
1. 讀取 data/speed-cameras/speed_cameras.csv
2. readline 串流解析（不一次性讀入）
3. 批次 bulkWrite（每批 500 筆），以 cameraId upsert
4. 輸出：匯入筆數 / 耗時 / 錯誤數
```

**執行指令**：

```bash
npx ts-node src/scripts/import-speed-cameras.ts
```

---

## 9. 測試策略

> 測試框架已於 `build: add vitest test runner and config`（commit `331bfc7`）建立。

### 9.1 手動測試案例

| 測試案例 | 輸入 | 預期結果 |
|---------|------|---------|
| 停車場查詢（有空位） | 台北車站附近 500m | 回傳 `status: "available"` 停車場，distanceM 升冪排序 |
| 停車場查詢（全滿） | 尖峰時段高需求區域 | 回傳 `status: "full"`，`availableSpaces: 0` |
| 測速照相查詢 | 國道 1 號汐止附近 5km | 回傳 `speedLimitKmh: 110` 的高速公路照相點 |
| 聚合端點降級 | 模擬 TDX 429 | `parking.ok: false`，`speedCameras` 仍正常回傳 |
| Redis 快取命中 | 連續兩次相同查詢 | 第二次回應 `cachedAt` 與第一次相同（≤ TTL 內） |
| 座標超出台灣 | `lat: 0, lng: 0` | 400 `INVALID_COORDINATES` |

### 9.2 驗證重點

- Redis 快取 Key 格式正確，TTL 到期後正常重打 TDX
- TDX 429 時失敗短快取（30s）生效，不造成 2 分鐘服務盲區
- SpeedCamera `$near` 查詢回傳正確 `distanceM`（以 GeoJSON `$near` 計算距離）
- 聚合端點兩個子查詢以 `Promise.allSettled` 並行執行，一個失敗不阻塞另一個

### 9.3 Vitest 單元測試建議

| 測試對象 | 測試重點 |
|---------|---------|
| `parking.service.ts` | Haversine 篩選邏輯（模擬 TDX 全市清單，驗證只回傳 radiusM 內） |
| `speed-camera.service.ts` | `$near` 查詢參數傳入正確（mock MongoDB） |
| `traffic.service.ts` | `Promise.allSettled` 降級邏輯：一邊 reject 時另一邊結果正確合入 |

---

## 10. 新增環境變數

| 變數 | 用途 | 必要性 | 預設值 |
|------|------|--------|--------|
| `TRAFFIC_FREEWAY_TTL_SEC` | TISV 國道路況 Redis TTL（秒） | 選配 | `180` |
| `TRAFFIC_PARKING_TTL_SEC` | TDX 停車場即時車位 Redis TTL（秒） | 選配 | `120` |
| `TRAFFIC_PARKING_ERR_TTL_SEC` | TDX 停車場失敗快取 TTL（秒） | 選配 | `30` |

> **無需新增 TDX 憑證**：停車場查詢沿用既有 `TDX_CLIENT_ID` / `TDX_CLIENT_SECRET`，透過 `tdxFetch()` 注入 Bearer token。  
> **無需 TISV 金鑰**：TISV 高公局 API 為公開端點。  
> **無需 data.gov.tw 金鑰**：測速照相資料集為公開授權。

---

## 11. 前端職責邊界

### 11.1 前端負責

| 職責 | 說明 |
|------|------|
| 地圖顯示 | 在地圖上標記停車場位置、測速照相點、國道壅塞路段色彩（紅/橙/綠） |
| 地點輸入 | 使用者輸入目的地地址或在地圖點擊，轉換為 `lat/lng` 後呼叫 API |
| 結果排序 / 篩選 | 依距離、剩餘車位數等條件在前端二次篩選（後端已回傳完整清單） |
| 定時輪詢 | 前端可設定輪詢間隔（建議 ≥ 2 分鐘，配合 Redis TTL） |
| 路線繪製（駕車） | 駕車導航路線以第三方地圖服務（Google Maps / Apple Maps）開啟，非本系統職責 |

### 11.2 前端不負責

| 禁止事項 | 原因 |
|---------|------|
| 直接呼叫 TDX / TISV API | API 金鑰安全性，後端代理統一處理 |
| 駕車路徑計算 | 本系統不提供駕車 routing（由外部地圖服務處理） |
| 測速照相資料下載與解析 | 靜態資料由後端匯入腳本處理 |
| 快取管理 | Redis 由後端管理，前端僅設定合理輪詢間隔 |

---

## 12. 風險與緩解

| 風險 | 嚴重度 | 可能性 | 緩解策略 |
|------|--------|--------|---------|
| **TDX 停車場 API 429** | 高 | 中 | Redis TTL 2 分鐘快取（每城市一份），失敗短快取 30s；禁止前端高頻穿透 |
| **TISV XML 格式異動** | 中 | 低 | `tisvFetch` 回傳字串，解析邏輯集中在 `freeway.service.ts`，異動只需改一處；失敗時回傳 503 + 建議語 |
| **data.gov.tw 測速照相資料過舊** | 低 | 高（政府資料常延遲更新） | 回應包含 `dataUpdatedAt`，前端可提示使用者資料日期；規劃 DT-6 定期重匯 |
| **TDX 停車場 API 端點變更** | 中 | 低 | `parking.service.ts` 抽象化 TDX 呼叫，endpoint URL 以常數定義；fail-soft 降級 |
| **SpeedCamera 資料集欄位名稱待確認** | 中 | 高 | DT-1 Phase 前先手動下載 CSV 驗證欄位，匯入腳本欄位對應標記 `⚠️ 待確認` 直到確認後解除 |
| **Redis 未啟動（開發環境）** | 低 | 中 | 沿用既有 `config/redis.ts` 的降級模式（Redis 不可用時 miss-through，直打 API）；不影響正確性，僅 TDX 額度使用量增加 |
