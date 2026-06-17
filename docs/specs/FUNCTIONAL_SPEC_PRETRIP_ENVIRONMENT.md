# 出發前環境資訊查詢
## Functional Specification — Pre-Trip Environment Aggregation

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

本功能讓使用者在出發前，針對目標地點一次查詢三類即時環境資訊：

| 資訊類型 | 資料來源 | 現有整合狀態 |
|---------|---------|------------|
| **天氣**（氣溫 / 降雨 / 風速 / 風向） | 中央氣象署 CWA 開放資料 API | 未整合 |
| **空氣品質（AQI / PM2.5）** | 台灣感測器平台 STA（`sta.ci.taiwan.gov.tw`） | ✅ 已整合（`getAirQuality` Agent Tool + `air.service.ts`） |
| **監視器（CCTV）路況** | 台灣路況監視器平台 twipcam（`twipcam.com`） | 未整合 |

**系統定位**：純資訊查詢聚合端點，**不**修改路徑規劃邏輯，不影響無障礙評分，回傳結果供使用者自行判斷是否出發。

---

## 2. 系統目標

### 2.1 核心能力

- 依座標一次取得天氣、空品、鄰近監視器三類環境資料
- 各資料來源獨立降級——任一來源失敗時部分回傳，以 `unavailable` 標記失敗區塊
- 以 Redis 分層快取降低外部 API 呼叫頻率，各資料類型採不同 TTL

### 2.2 非功能目標

| 目標 | 說明 |
|------|------|
| 後端聚合 | 前端單一呼叫即取得三類資料，不直接呼叫外部 API |
| 降級不中斷 | 任一外部 API 失敗，其他區塊仍正常回傳 |
| 配額保護 | Redis 快取攔截重複查詢，避免超過外部 API 速率上限 |
| 環境感知路徑不納入本期 | 本功能僅供資訊顯示，不與評分引擎整合（環境感知路徑規劃 S4 為獨立 phase） |

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
GET /api/v1/a11y/environment
      ↓
environment.controller.ts
      ↓
┌─────────────────────────────────────────────────────┐
│               EnvironmentService                    │
│  src/modules/environment/environment.service.ts     │
│                                                     │
│  ┌───────────────┐  ┌──────────────┐  ┌──────────┐ │
│  │ WeatherService │  │  AirService  │  │  CCTV    │ │
│  │ (CWA API)     │  │ (STA / 已有) │  │ Service  │ │
│  └───────────────┘  └──────────────┘  │(twipcam) │ │
│         ↑                  ↑          └──────────┘ │
│    Redis Cache         Redis Cache    Redis Cache   │
└─────────────────────────────────────────────────────┘
      ↓
sendResponse()  ← { weather, airQuality, nearbyCctv }
```

### 3.2 模組配置

```
src/modules/environment/
├── environment.controller.ts    # GET /api/v1/a11y/environment
├── environment.service.ts       # 三類資料聚合、降級邏輯
├── environment.schema.ts        # Zod 請求驗證
├── weather.service.ts           # CWA API 封裝
├── cctv.service.ts              # twipcam API 封裝
└── index.ts
```

> **空品（AQI）**：直接重用現有 `src/modules/air/air.service.ts` 的 `getAirData()` 函式，不另行建立服務層。

---

## 4. 外部資料來源整合

### 4.1 天氣資料 — 中央氣象署 CWA 開放資料 API

#### 4.1.1 API 資訊

| 項目 | 內容 |
|------|------|
| 文件網址 | `https://opendata.cwa.gov.tw/dist/opendata-swagger.html` |
| 授權金鑰 | CWA 開放資料平台申請，免費方案每日呼叫上限 100,000 次 |
| 環境變數 | `CWA_API_KEY` |
| 採用端點 | `GET /v1/rest/datastore/F-D0047-{locationCode}` — 36 小時鄉鎮天氣預報 |

#### 4.1.2 請求範例

```http
GET https://opendata.cwa.gov.tw/api/v1/rest/datastore/F-D0047-091
  ?Authorization={CWA_API_KEY}
  &locationName=大安區
  &elementName=T,PoP6h,WS,WD,Wx
  &timeFrom=2026-06-17T08:00:00
  &timeTo=2026-06-17T18:00:00
```

> **⚠️ 待確認**：CWA API 依縣市分鄉鎮代碼（如 `F-D0047-091` 為台北市），後端需先以座標反查所在縣市，再選用對應資料集代碼。此反查邏輯建議整合 Google Maps Reverse Geocoding（現有 `src/config/map.ts`），或以 GeoJSON 縣市邊界靜態對應。

#### 4.1.3 欄位對應表

| CWA 欄位 | 回應欄位 | 說明 |
|---------|---------|------|
| `T` | `weather.temperature` | 氣溫（°C） |
| `PoP6h` | `weather.precipitationProbability` | 6 小時降雨機率（%） |
| `WS` | `weather.windSpeed` | 風速（m/s） |
| `WD` | `weather.windDirection` | 風向（中文，如「北北東風」） |
| `Wx` | `weather.condition` | 天氣描述（如「晴」「多雲時陰」） |

#### 4.1.4 錯誤處理

| 情境 | 處理方式 |
|------|---------|
| HTTP 4xx / 5xx | `weather` 區塊標記 `status: "unavailable"`，不中斷整體回應 |
| 查無地點資料 | 同上 |
| 逾時（> 5 秒） | 同上，記錄 warning log |

---

### 4.2 空氣品質（AQI） — 台灣感測器平台 STA

#### 4.2.1 現有整合

空品查詢已由 `src/modules/air/air.service.ts` 的 `getAirData(lat, lng)` 完整實作，以台灣感測器平台（STA）`sta.ci.taiwan.gov.tw/STA_AirQuality_EPAIoT/v1.0/Datastreams` 為資料來源，依座標反查縣市後抓取最近測站 PM2.5。

本功能不重複建立邏輯，直接呼叫 `getAirData()` 並以 `classifyPm25()` 轉換成健康建議文字。

#### 4.2.2 整合方式

```typescript
// environment.service.ts 內呼叫方式
import { getAirData, classifyPm25 } from "../air/air.service";

const airData = await getAirData(lat, lng);
if (!airData) {
  return { status: "unavailable" };
}
const pm25 = airData.readings[0].pm25;
const { quality, advice } = classifyPm25(pm25);
```

#### 4.2.3 欄位對應表

| air.service 欄位 | 回應欄位 | 說明 |
|----------------|---------|------|
| `readings[0].pm25` | `airQuality.pm25` | PM2.5 濃度（μg/m³） |
| `readings[0].area` | `airQuality.area` | 測站區域名稱 |
| `readings[0].coordinates` | `airQuality.stationCoordinates` | 測站座標 |
| `quality`（`classifyPm25` 輸出） | `airQuality.quality` | 品質等級（良好 / 普通 / …） |
| `advice`（`classifyPm25` 輸出） | `airQuality.advice` | 健康建議文字 |

---

### 4.3 監視器（CCTV） — twipcam

#### 4.3.1 API 資訊

| 項目 | 內容 |
|------|------|
| 文件網址 | `https://www.twipcam.com/api/document` |
| 授權方式 | ⚠️ 待確認（文件未明確說明是否需要 API Key；請於實作前確認 twipcam 授權條款） |
| 環境變數 | `TWIPCAM_API_KEY`（若需要） |
| 採用端點 | ⚠️ 待確認（依 twipcam 文件，預期為座標範圍查詢，如 `GET /api/cameras?lat=&lng=&radius=`） |

#### 4.3.2 預期請求（⚠️ 待確認實際端點格式）

```http
GET https://www.twipcam.com/api/cameras
  ?lat=25.0478
  &lng=121.5318
  &radius=500
  &limit=5
```

#### 4.3.3 欄位對應表（預期，⚠️ 待對照實際回應）

| twipcam 欄位 | 回應欄位 | 說明 |
|------------|---------|------|
| `id` | `cctv.id` | 攝影機識別碼 |
| `name` | `cctv.name` | 攝影機名稱 / 地點描述 |
| `lat`, `lng` | `cctv.location` | 攝影機座標 |
| `snapshot_url` | `cctv.snapshotUrl` | 靜態快照圖片 URL |
| `stream_url` | `cctv.streamUrl` | 影音串流 URL（m3u8 或 RTSP） |
| （計算值） | `cctv.distanceM` | 與查詢座標的距離（公尺），後端計算 |

> **後端職責**：僅回傳 `snapshotUrl` 與 `streamUrl`，**不**代理影像流量。串流渲染由前端處理（見第 11 節）。

#### 4.3.4 錯誤處理

| 情境 | 處理方式 |
|------|---------|
| HTTP 4xx / 5xx | `nearbyCctv` 標記 `status: "unavailable"` |
| 附近無監視器 | 回傳空陣列 `[]`，`status: "ok"` |
| 逾時（> 5 秒） | 標記 `status: "unavailable"`，記錄 warning log |

---

## 5. API 規格

### 5.1 端點總覽

| Method | Path | 功能 | 狀態 |
|--------|------|------|------|
| `GET` | `/api/v1/a11y/environment` | 聚合環境資訊查詢 | 📋 Proposed |

### 5.2 聚合查詢端點

**端點**：`GET /api/v1/a11y/environment`

**認證**：公開端點，不需要 JWT。

**請求 Schema**（`environment.schema.ts`）

```typescript
const EnvironmentQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radius: z.coerce.number().int().min(100).max(2000).default(500),  // 監視器搜尋半徑（公尺）
})
```

**請求範例**

```http
GET /api/v1/a11y/environment?lat=25.0478&lng=121.5318&radius=500
```

**成功回應（HTTP 200）**

```json
{
  "ok": true,
  "status": "success",
  "code": 200,
  "message": "環境資訊查詢成功",
  "data": {
    "location": {
      "lat": 25.0478,
      "lng": 121.5318
    },
    "weather": {
      "status": "ok",
      "temperature": 31,
      "precipitationProbability": 20,
      "windSpeed": 3.2,
      "windDirection": "南風",
      "condition": "多雲時晴",
      "forecastTime": "2026-06-17T10:00:00+08:00"
    },
    "airQuality": {
      "status": "ok",
      "pm25": 18.5,
      "quality": "普通",
      "advice": "空氣品質尚可，敏感族群可考慮減少長時間戶外活動",
      "area": "大安區",
      "stationCoordinates": [121.5417, 25.0260]
    },
    "nearbyCctv": {
      "status": "ok",
      "cameras": [
        {
          "id": "cam_001",
          "name": "忠孝東路四段（與復興南路口）",
          "location": { "lat": 25.0413, "lng": 121.5431 },
          "distanceM": 340,
          "snapshotUrl": "https://www.twipcam.com/snapshot/cam_001.jpg",
          "streamUrl": "https://www.twipcam.com/stream/cam_001.m3u8"
        },
        {
          "id": "cam_002",
          "name": "仁愛路四段（近大安森林公園）",
          "location": { "lat": 25.0338, "lng": 121.5347 },
          "distanceM": 480,
          "snapshotUrl": "https://www.twipcam.com/snapshot/cam_002.jpg",
          "streamUrl": null
        }
      ]
    }
  }
}
```

**部分降級回應（某來源失敗，HTTP 200）**

```json
{
  "ok": true,
  "status": "success",
  "code": 200,
  "message": "環境資訊部分查詢成功（1 項來源不可用）",
  "data": {
    "location": { "lat": 25.0478, "lng": 121.5318 },
    "weather": {
      "status": "unavailable",
      "reason": "CWA_API_ERROR"
    },
    "airQuality": {
      "status": "ok",
      "pm25": 18.5,
      "quality": "普通",
      "advice": "空氣品質尚可，敏感族群可考慮減少長時間戶外活動",
      "area": "大安區",
      "stationCoordinates": [121.5417, 25.0260]
    },
    "nearbyCctv": {
      "status": "ok",
      "cameras": []
    }
  }
}
```

**錯誤回應（HTTP 400，參數驗證失敗）**

```json
{
  "ok": false,
  "status": "error",
  "code": 400,
  "message": "請求參數無效",
  "data": {
    "reason": "INVALID_PARAMS",
    "details": "lat 必須介於 -90 至 90 之間"
  }
}
```

### 5.3 狀態碼一覽

| HTTP 狀態碼 | Reason | 說明 |
|-----------|--------|------|
| `200` | — | 成功（含部分降級） |
| `400` | `INVALID_PARAMS` | Zod 驗證失敗（lat/lng/radius 不合法） |
| `500` | `INTERNAL_ERROR` | 非預期錯誤（所有外部呼叫皆無法降級） |

### 5.4 `status` 欄位說明

各資料區塊（`weather` / `airQuality` / `nearbyCctv`）獨立攜帶 `status` 欄位：

| 值 | 含義 |
|----|------|
| `"ok"` | 資料正常取得 |
| `"unavailable"` | 外部 API 失敗或逾時，此區塊無資料 |

---

## 6. 快取策略

### 6.1 設計原則

各資料類型的更新頻率不同，採獨立 TTL 分層快取。快取層使用現有 `src/config/redis.ts`（ioredis）。

### 6.2 快取 TTL 表

| 資料類型 | 快取 TTL | 理由 |
|---------|---------|------|
| **天氣**（CWA） | 20 分鐘 | 預報資料更新頻率低；20 分鐘對出發前決策已夠即時 |
| **空氣品質**（STA） | 60 分鐘 | 測站每小時更新一次 PM2.5，TTL 與資料週期對齊 |
| **監視器清單**（twipcam 清單查詢） | 10 分鐘 | 攝影機列表變動少；列表快取，快照 URL 不儲存 |

### 6.3 快取 Key 設計

```
Key 格式：env:{type}:{lat_rounded}:{lng_rounded}

說明：
  - type       : "weather" | "air" | "cctv"
  - lat_rounded: 四捨五入至小數點後 3 位（約 111 公尺精度，減少快取碎片）
  - lng_rounded: 同上

範例：
  env:weather:25.048:121.532
  env:air:25.048:121.532
  env:cctv:25.048:121.532
```

### 6.4 快取讀寫流程

```
controller 接收請求
       ↓
environment.service 對三類資料各自執行：
  1. 嘗試讀取 Redis（GET env:{type}:{lat}:{lng}）
  2. 命中 → 直接回傳快取值
  3. 未命中 → 呼叫外部 API
  4. 成功 → 寫入 Redis（SETEX，各自 TTL）
  5. 失敗 → 不寫 Redis，回傳 { status: "unavailable" }
       ↓
三類資料並行（Promise.allSettled，互不阻塞）
       ↓
聚合結果後 sendResponse()
```

> **快取不寫入降級結果**：外部 API 失敗時不快取 `unavailable` 狀態，確保下次請求仍會重試外部 API。

### 6.5 Redis 不可用時的降級

若 Redis 連線失敗，`environment.service.ts` 捕捉錯誤後直接呼叫外部 API（無快取模式），不因 Redis 不可用而中斷服務。

---

## 7. 資料模型

本功能為純查詢端點，**不新增 MongoDB Collection**。

環境資料不持久化——每次請求由 Redis 快取或外部 API 即時取得，無需 MongoDB 儲存。

### 7.1 回應型別定義

```typescript
// src/modules/environment/environment.types.ts

type DataStatus = "ok" | "unavailable"

interface WeatherBlock {
  status: DataStatus
  temperature?: number              // 氣溫（°C）
  precipitationProbability?: number // 降雨機率（%，0–100）
  windSpeed?: number                // 風速（m/s）
  windDirection?: string            // 風向（中文）
  condition?: string                // 天氣描述
  forecastTime?: string             // ISO 8601，預報時段起始時間
  reason?: string                   // 僅 status="unavailable" 時出現
}

interface AirQualityBlock {
  status: DataStatus
  pm25?: number                     // PM2.5 濃度（μg/m³）
  quality?: string                  // 等級（良好 / 普通 / 對敏感族群不健康 / 不健康 / 非常不健康）
  advice?: string                   // 健康建議文字
  area?: string | null              // 測站所在行政區
  stationCoordinates?: [number, number] | null   // [lng, lat]
  reason?: string
}

interface CctvCamera {
  id: string
  name: string
  location: { lat: number; lng: number }
  distanceM: number
  snapshotUrl: string | null
  streamUrl: string | null
}

interface CctvBlock {
  status: DataStatus
  cameras?: CctvCamera[]
  reason?: string
}

interface EnvironmentData {
  location: { lat: number; lng: number }
  weather: WeatherBlock
  airQuality: AirQualityBlock
  nearbyCctv: CctvBlock
}
```

---

## 8. 實作 Roadmap

### 8.1 Phase 總覽

| Phase | 功能 | 優先度 | 依賴 |
|-------|------|--------|------|
| **Phase E-1** | 聚合骨架 + 空品整合 | Critical | 現有 `air.service.ts` |
| **Phase E-2** | CWA 天氣整合 + Redis 快取 | High | `CWA_API_KEY`、Redis |
| **Phase E-3** | twipcam CCTV 整合 | Medium | twipcam API 確認 |
| **Phase E-4（選配）** | `getEnvironmentInfo` AI Agent Tool | Low | Phase E-1 完成 |

---

### Phase E-1 — 聚合骨架 + 空品整合

**目標**：建立 `environment` 模組骨架，串接現有空品資料，完成端點與 Zod 驗證。

**新增檔案**：

```
src/modules/environment/
├── environment.controller.ts
├── environment.service.ts    # 骨架：Promise.allSettled + 降級邏輯
├── environment.schema.ts     # Zod: lat / lng / radius
└── index.ts
```

**路由掛載**：在 `src/routes/a11y.route.ts` 加入：

```typescript
import { getEnvironmentInfo } from "../modules/environment/environment.controller";
router.get("/environment", validate(EnvironmentQuerySchema), getEnvironmentInfo);
```

**驗收條件**：
- `GET /api/v1/a11y/environment?lat=25.0478&lng=121.5318` 回傳 `airQuality` 含 PM2.5 資料
- `weather` 與 `nearbyCctv` 回傳 `status: "unavailable"`（來源尚未整合）

---

### Phase E-2 — CWA 天氣整合 + Redis 快取

**目標**：串接 CWA 開放資料，加上三類資料的 Redis 快取層。

**新增檔案**：

```
src/modules/environment/
└── weather.service.ts    # CWA API 呼叫、縣市代碼對應
```

**關鍵實作事項**：

1. 座標 → 縣市名稱：重用現有 Google Maps Reverse Geocoding（`getCityZh(lat, lng)`，已在 `src/adapters/google.adapter.ts`）。
2. 縣市名稱 → CWA 資料集代碼：維護靜態對照表（台北市 → `F-D0047-091`，新北市 → `F-D0047-069`，…）。
3. 實作 Redis 快取層，套用 §6.3 key 格式與 §6.2 TTL。

**驗收條件**：
- 天氣區塊回傳 `temperature`、`condition`、`precipitationProbability`
- 第一次查詢命中 CWA API；第二次相同座標命中 Redis（`forecastTime` 相同）

---

### Phase E-3 — twipcam CCTV 整合

**目標**：串接 twipcam，回傳查詢座標附近的監視器清單（含快照 URL）。

**新增檔案**：

```
src/modules/environment/
└── cctv.service.ts    # twipcam API 呼叫、距離計算
```

**關鍵實作事項**：

1. 呼叫 twipcam API 取得附近攝影機列表。
2. 以 Haversine 計算各攝影機與查詢座標的距離（公尺），依距離升冪排序。
3. 僅回傳 `snapshotUrl` / `streamUrl`，不代理影像內容。
4. 若 twipcam 需授權，以 `TWIPCAM_API_KEY` 環境變數注入。

**⚠️ 待確認**：twipcam 實際端點格式與授權方式須對照官方文件後方可實作。

**驗收條件**：
- `nearbyCctv.cameras` 回傳至少一筆，含 `snapshotUrl`
- `distanceM` 為正確計算值

---

### Phase E-4（選配） — `getEnvironmentInfo` AI Agent Tool

**目標**：將聚合查詢包裝成第 8 個 AI Agent Tool，供 `/api/v1/ai/chat` 使用。

**在 `src/config/ai/tool.ts` 新增 Tool 宣告**：

```typescript
{
  type: "function",
  function: {
    name: "getEnvironmentInfo",
    description: "根據經緯度查詢目標地點的出發前環境資訊，包含即時天氣（氣溫、降雨、風速）、空氣品質（PM2.5）與附近監視器路況快照 URL。",
    parameters: {
      type: "object",
      properties: {
        latitude:  { type: "number", description: "目標地點緯度" },
        longitude: { type: "number", description: "目標地點經度" },
        radius:    { type: "number", description: "監視器搜尋半徑（公尺），預設 500" },
      },
      required: ["latitude", "longitude"],
    },
  },
},
```

**在 `src/modules/ai/agent-tools.ts` 新增執行函式**：

```typescript
export async function getEnvironmentInfo(args: {
  latitude: number;
  longitude: number;
  radius?: number;
}): Promise<string> {
  // 直接呼叫 environment.service.ts 的聚合函式
}
```

**`executeLocalTool` switch 新增 case**：

```typescript
case "getEnvironmentInfo":
  return getEnvironmentInfo({
    latitude: args.latitude,
    longitude: args.longitude,
    radius: args.radius,
  });
```

> **備注**：本 Phase 為選配，須等 Phase E-1 至 E-3 穩定後再評估。

---

## 9. 測試策略

### 9.1 手動測試案例

| 測試案例 | 輸入 | 預期 |
|---------|------|------|
| 正常查詢 | `lat=25.0478&lng=121.5318&radius=500` | 三區塊均有資料（status: "ok"） |
| 空品資料 | 同上 | `airQuality.pm25` 為數值，`quality` 為中文等級 |
| 無 CCTV 覆蓋區域 | 偏遠地點座標 | `nearbyCctv.cameras` 為空陣列，status: "ok" |
| CWA API 停用（移除 key） | 正常座標 | `weather.status: "unavailable"`，其餘區塊正常 |
| 無效座標 | `lat=999&lng=0` | HTTP 400，reason: "INVALID_PARAMS" |
| Redis 快取命中 | 相同座標連續查詢兩次 | 第二次回應與第一次 `forecastTime` / `pm25` 相同 |

### 9.2 驗證重點

- `Promise.allSettled` 並行查詢：任一外部 API 拋例外不影響其他區塊
- Redis 快取寫入確認：TTL 與 §6.2 一致（`TTL env:weather:*` ≈ 1200 秒）
- 降級標記正確：失敗區塊有 `status: "unavailable"`，`reason` 非空
- 距離計算正確性：`distanceM` 誤差 < 50 公尺（Haversine vs 實際距離）
- 回應 envelope 符合 `sendResponse()` 格式（含 `ok`、`status`、`code`、`message`、`data`）

---

## 10. 新增環境變數

| 變數 | 用途 | 必要性 | 使用位置 |
|------|------|--------|---------|
| `CWA_API_KEY` | 中央氣象署開放資料 API 授權金鑰 | **必要**（Phase E-2） | `weather.service.ts` |
| `TWIPCAM_API_KEY` | twipcam 監視器 API 授權金鑰 | ⚠️ 待確認（twipcam 文件未明確說明） | `cctv.service.ts` |

> **說明**：空品資料使用現有 STA API（`sta.ci.taiwan.gov.tw`），為公開端點，不需新增金鑰。

---

## 11. 前端職責邊界

### 11.1 前端負責

| 職責 | 說明 |
|------|------|
| 天氣圖示與 UI 呈現 | 依 `condition` 文字顯示天氣 icon（晴 / 雨 / 陰…） |
| 空品等級顏色標示 | 依 `quality` 欄位對應顏色（良好=綠、不健康=紅…） |
| CCTV 快照圖片顯示 | 以 `snapshotUrl` 顯示靜態快照（`<img>` 標籤） |
| CCTV 影像串流播放 | 以 `streamUrl` 播放即時串流（m3u8 / HLS 播放器） |
| 提醒通知推播 | 依天氣 / 空品資料決定是否顯示提醒（前端邏輯） |
| 降級 UI 處理 | `status: "unavailable"` 時顯示「資料暫時無法取得」 |

### 11.2 前端不負責（後端處理）

| 禁止事項 | 原因 |
|---------|------|
| 直接呼叫 CWA API | API Key 安全性，由後端代理 |
| 直接呼叫 twipcam API | API Key 安全性，由後端代理 |
| 直接呼叫 STA 空品 API | 後端統一封裝，前端不持有外部端點 |
| 代理 / 轉發 CCTV 影像串流 | 後端只提供 URL，串流由前端播放器直連 twipcam |
| 快取管理 | Redis 由後端管理 |
| 距離計算 | 後端計算 `distanceM` 後回傳 |

---

## 12. 風險與緩解

| 風險 | 影響 | 緩解策略 |
|------|------|---------|
| **twipcam API 格式未確認** | Phase E-3 可能需大幅調整介面設計 | Phase E-3 實作前先以獨立腳本驗證 twipcam 回應格式；本 spec §4.3 標記「⚠️ 待確認」 |
| **CWA 縣市代碼靜態對應維護成本** | 行政區劃調整時需手動更新 | 對應表集中於單一常數檔（`cwa-location-codes.ts`）；長期可改用 GeoJSON polygon 查詢 |
| **外部 API 速率上限** | CWA 免費方案 10 萬次/日，twipcam 不明 | Redis 快取攔截重複查詢（§6）；監控每日 API 呼叫量 |
| **STA 感測器離查詢點遠（>5km）** | 空品資料代表性不足 | 現有 `getAirData()` 依縣市查詢（非最近點），若誤差過大可改用 `$near` 查最近測站座標（⚠️ 待確認 STA 是否提供全台測站座標清單） |
| **Redis 無快取時三個外部 API 並行** | 首次查詢回應時間可能 > 3 秒 | `Promise.allSettled` 並行執行（非串行）；各 API 設 5 秒 timeout；前端顯示 loading 狀態 |
| **CCTV 快照/串流 URL 過期** | 快取 10 分鐘內 URL 可能失效 | twipcam 快照 URL 通常有效期較短，前端圖片載入失敗時顯示 placeholder；串流 URL 失效後前端 reload |

---

*文件版本 v1.0.0 — 初版規劃（2026-06-17）。本規格為 Proposed 狀態，實作前須確認 twipcam API 文件（§4.3）與 CWA 縣市代碼對應策略（§8 Phase E-2）。*
