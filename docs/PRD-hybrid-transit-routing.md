# PRD：混合式無障礙路線規劃引擎（修訂版）

**版本**：2.0  
**日期**：2026-06-04  
**狀態**：草稿  
**作者**：yuzen9622

---

## 重要更正說明

原版 PRD（v1.0）假設 TDX 提供可用的 GTFS 下載端點。實際調查結果如下：

- TDX v2 GTFS 端點（`/api/premium/v2/GTFS/Static/...`）已於 2024 年停用
- TDX v3 GTFS 端點**截至 2026 年 2 月仍未提供**（Transitland 記錄顯示所有台灣 GTFS feed 最後成功抓取時間為 2024 年 2 月，目前均回傳「檔案不存在」）
- 社群亦無人維護可用的台灣全國 GTFS 資料集

因此，OTP「直接吃 TDX GTFS」的方案**不可行**。本文重新設計架構。

---

## 1. 背景與問題陳述

### 1.1 現況問題

`findAccessibleRoutes()` 以硬編碼半徑搜尋站點（公車 400m、捷運 800m）。超出範圍直接回傳空陣列，無換乘支援，無 First/Last Mile 規劃。

### 1.2 資料現況（調查後）

| 資料源                | 狀態              | 說明                           |
| --------------------- | ----------------- | ------------------------------ |
| TDX v3 REST API       | ✅ 正常運作       | 現有程式碼使用的 JSON API      |
| TDX v3 GTFS 下載      | ❌ 不存在         | v3 未推出，v2 已停用           |
| Transitland 台灣 GTFS | ❌ 2024/02 起失效 | 來源是舊 v2，現在 404          |
| 社群維護 GTFS         | ❌ 無             | 查無可用 repo                  |
| Google Routes API     | ✅ 可用但付費     | 有台灣完整資料，但每次查詢計費 |

**結論：TDX REST API 是目前唯一可靠且免費的台灣大眾運輸資料源。**

---

## 2. 可行方案評估

### 方案 A：自建 TDX→GTFS 轉換器 + OTP

從 TDX REST API 抓取資料，自行產生符合規格的 GTFS `.zip`，再餵給 OTP。

**優點**：取得 OTP 完整的換乘 + First/Last Mile 路線規劃能力  
**缺點**：需維護轉換器（TDX schema 改版會壞）；GTFS 產生後需重啟 OTP；台灣公車班次資料分散在數十個城市端點，需全部彙整；即時資料無法進入 GTFS（靜態格式）

**工程量**：4～6 週  
**風險**：高（TDX 資料品質不均，轉換正確性難保證）

---

### 方案 B：在 TDX REST API 上自建簡化版 RAPTOR 圖形路由

直接使用現有 TDX v3 API，在應用層建立轉乘圖，實作簡化的多段旅程搜尋。

**優點**：資料即時（每次查詢都是最新）；不依賴 GTFS；架構簡單，不需額外基礎設施  
**缺點**：路線規劃邏輯需自行實作（非 trivial）；覆蓋率受 TDX API rate limit 限制

**工程量**：3～4 週  
**風險**：中

---

### 方案 C：改用 Google Routes API（付費）

直接呼叫 Google Routes API，取得含換乘的完整路線，再疊加無障礙評分。

**優點**：最省工（2～3 天）；台灣資料完整度最高；即開即用  
**缺點**：按量計費（每 1000 次查詢約 $5 USD）；無法取得底層 OSM 無障礙節點資料；被 Google 綁定

**工程量**：3～5 天  
**風險**：低（技術）/ 高（長期成本）

---

### 決策建議

**推薦方案 B（自建轉乘圖）**，理由：

1. 技術自主，不依賴外部服務可用性
2. 資料即時性優於 GTFS（不需排程更新）
3. 工程量合理，可分階段交付
4. 已有 TDX API 整合基礎，降低新增成本

若未來 TDX 正式推出 v3 GTFS，可平行遷移至方案 A，兩套架構共存。

---

## 3. 目標（基於方案 B）

### 3.1 主要目標

1. **消除零結果問題**：用「找最近 N 個站 + 步行可達性過濾」取代固定半徑
2. **支援一次換乘**：A 線到 C 站，走路到 D 站，搭 B 線到終點
3. **完整 First/Last Mile**：步行段用 ORS 計算，不依賴固定半徑
4. **保留所有即時資訊**：現有 TDX 即時查詢不動

### 3.2 非目標

- 兩次以上換乘（二期再做）
- 自行車、計程車整合
- 離線模式
- 超出 TDX 涵蓋範圍的偏遠地區

---

## 4. 功能需求

### FR-01：最近站點搜尋（取代固定半徑）

- 起點搜尋：找步行 **20 分鐘以內**可到達的所有公車站/捷運站（不設固定 meter 限制）
- 終點同理
- 用 ORS walking route API 計算實際步行時間，過濾超過門檻的站點
- 不可達（ORS 回傳無路）的站點直接排除

### FR-02：直達路線搜尋（現有邏輯優化）

- 邏輯同現有，但改用 FR-01 的寬鬆站點集合
- 最多取 5 條候選直達路線

### FR-03：換乘路線搜尋（新增）

- 搜尋範圍：起點側站點集合 × 終點側站點集合
- **站點集合涵蓋所有運具**：`findReachableStops()` 查詢對象同時包含 `BusStopModel` 與 `MetroStationModel`，確保公車↔捷運等跨運具換乘不被漏掉
- 換乘點：在兩側站點集合以外，找「中間站」——即起點側路線的下車站，同時是終點側路線的上車站附近（步行 10 分鐘以內）
- 演算法：

```
起點側站點集合 = BusStopModel(origin, 20min) ∪ MetroStationModel(origin, 20min)
終點側站點集合 = BusStopModel(dest,   20min) ∪ MetroStationModel(dest,   20min)

對起點側每條路線（公車或捷運）的每個停靠站 S_mid：
  若 S_mid 附近（步行 10 分鐘）有終點側路線（任意運具）的站 → 構成換乘
  換乘組合限制：最多 20 組（防止爆炸）
```

- 每組換乘組合呼叫 TDX 取得兩段班次資訊與等車時間

### FR-04：步行時間計算快取

- ORS walking route 計算結果快取至 Redis（TTL 24 小時）
- key: `walk:{origin_lng.toFixed(6)},{origin_lat.toFixed(6)}:{dest_lng.toFixed(6)},{dest_lat.toFixed(6)}`（固定 6 位小數，避免浮點字串不一致導致快取失效）
- 避免重複計算相同站點對的步行時間

### FR-05：路線組裝格式相容

- 換乘路線的 `legs` 格式：`[WalkLeg, BusLeg, WalkLeg, BusLeg, WalkLeg]`
- 新增 `transferCount: number` 欄位（0 = 直達，1 = 一次換乘）
- 其餘 schema 不變，前端不需改動

### FR-06：無障礙評分整合

- `scoreRoute()` 邏輯不變，對換乘路線同樣適用
- 換乘步行段的 OSM 無障礙節點查詢維持現有邏輯

### FR-07：A11y 站內無障礙出口導航（新增）

**背景**：`accessibilities` collection 存有台北捷運 118 個站、188 筆出口資料，每筆包含出口名稱（含「電梯」/「坡道」）、出口編號、精確 GPS 座標。現有 WalkLeg 以站點中心座標為終點，未利用此資料。

**功能描述**：

當步行段（WalkLeg）的終點或起點為捷運站時：

1. 以站名查詢 `accessibilities` collection，取得所有有電梯或坡道的出口
2. 從候選出口中選出距使用者最近的無障礙出口
3. ORS 步行路徑終點改為該出口的 GPS 座標（非站點中心）
4. WalkLeg 附加 `exitInfo` 欄位，前端可據此顯示「請走出口電梯1」

**覆蓋範圍**：

- ✅ 台北捷運（MRT）：118 站，188 出口，100% 有座標
- ❌ TRA / THSR：無對應出口資料，維持現有站點中心座標，`exitInfo` 為 `null`

**WalkLeg schema 更新**：

```typescript
interface WalkLeg {
  type: "walk";
  from: { lat: number; lng: number; name?: string };
  to: { lat: number; lng: number; name?: string };
  durationMin: number;
  distanceM: number;
  exitInfo?: {
    // 僅捷運站有值，其餘為 null
    exitName: string; // e.g. "出口電梯1"
    exitNumber: string; // e.g. "出口1"
    type: "elevator" | "ramp";
    coords: [number, number];
  } | null;
}
```

**站名比對邏輯**：

```
stationName = "中山國中"
A11y query: { "出入口電梯/無障礙坡道名稱": { $regex: "中山國中站" } }
→ 回傳所有符合出口（可能有多個電梯/坡道出口）
→ 以 Haversine 距離選出距 userCoords 最近的出口
```

---

## 5. 技術架構

### 5.1 新的搜尋流程

```
findAccessibleRoutes(origin, dest, city)
│
├─ 1. findReachableStops(origin, maxWalkMin=20)        ← 新增
│     ├─ DB: 起點 2km 內所有站 (geospatial)
│     └─ ORS Matrix: 過濾步行時間 > 20 分鐘的站
│
├─ 2. findReachableStops(dest, maxWalkMin=20)          ← 新增
│
├─ 3. 直達路線搜尋（現有邏輯，改用新站點集）         ← 修改
│
├─ 4. 換乘路線搜尋                                    ← 新增
│     ├─ 找換乘點 (S_mid)
│     └─ 組裝 [WalkLeg + TransitLeg + WalkLeg + TransitLeg + WalkLeg]
│
├─ 5. buildWalkLegs（為每個 WalkLeg 附加 exitInfo）   ← 新增 (FR-07)
│     ├─ IF 終點/起點是捷運站:
│     │   ├─ A11y DB: 查詢站名對應的無障礙出口
│     │   ├─ 選最近出口（Haversine）
│     │   └─ ORS: 路徑終點改為出口座標，附加 exitInfo
│     └─ ELSE (TRA/THSR): 維持站點中心，exitInfo = null
│
├─ 6. 合併、去重 (deduplicateRoutes)                  ← 不變
│
└─ 7. 評分排序 (scoreAndRank) → 取前 3                ← 不變
```

### 5.2 新增元件

```
src/
├── config/
│   └── redis.ts                    # Redis 客戶端（步行快取）
├── service/
│   ├── reachable-stops.service.ts  # findReachableStops()
│   └── a11y-exit.service.ts        # 捷運站無障礙出口查詢（FR-07）
└── modules/
    └── accessible-route/
        └── transfer-finder.ts      # 換乘候選組合搜尋
```

**`a11y-exit.service.ts` 介面設計**：

```typescript
// 查詢指定捷運站的所有無障礙出口
findAccessibleExits(stationName: string): Promise<A11yExit[]>

// 從候選出口選出距 userCoords 最近的出口（Haversine，無需 ORS）
selectNearestExit(
  userCoords: [number, number],
  exits: A11yExit[]
): A11yExit

// 組裝完整 WalkLeg（含 exitInfo）；若非捷運站則 exitInfo = null
buildExitWalkLeg(
  userCoords: [number, number],
  station: { name: string; coords: [number, number]; railSystem: string }
): Promise<WalkLeg>

interface A11yExit {
  exitName:   string;               // "出口電梯1"
  exitNumber: string;               // "出口1"
  type:       "elevator" | "ramp";
  coords:     [number, number];     // [lng, lat]
}
```

### 5.3 修改元件

```
src/modules/accessible-route/accessible-route.service.ts
  - findAccessibleRoutes()：接入 findReachableStops()、加入換乘搜尋、串接 buildExitWalkLeg()
  - buildCandidate()：步行段改用快取結果；終點為捷運站時呼叫 buildExitWalkLeg()
```

### 5.5 A11y 出口查詢流程細節

```
buildExitWalkLeg(userCoords, station)
│
├─ IF station.railSystem === "TRTC" (台北捷運):
│   ├─ findAccessibleExits(station.name)
│   │   └─ A11y.find({ "出入口電梯/無障礙坡道名稱": /stationName站/ })
│   │
│   ├─ IF exits.length === 0:          # 查無出口（資料缺口）
│   │   └─ 降級：使用站點中心，exitInfo = null
│   │
│   └─ ELSE:
│       ├─ selectNearestExit(userCoords, exits)  # Haversine 排序，取最近
│       ├─ ORS: userCoords → bestExit.coords     # 實際步行路徑
│       └─ WalkLeg.exitInfo = { exitName, exitNumber, type, coords }
│
└─ ELSE (TRA / THSR / 公車站):
    ├─ ORS: userCoords → station.coords
    └─ WalkLeg.exitInfo = null
```

### 5.4 Redis 快取架構

```
┌─────────────────────────────────┐
│  findReachableStops(origin)     │
│    ↓                            │
│  DB: 站點 (2km geo query)       │
│    ↓                            │
│  對每個站點:                    │
│    key = walk:{o}:{s}           │
│    Redis HIT → 直接用           │
│    Redis MISS → ORS 計算 → 存入 │
└─────────────────────────────────┘
```

---

## 6. 效能考量

### 6.1 最壞情況分析

無快取時：

- 起點 2km 內最多 50 個站
- 終點 2km 內最多 50 個站
- ORS 呼叫上限：50 + 50 = 100 次（每次 ~100ms）
- 總計：~10 秒（不可接受）

### 6.2 緩解策略

1. **ORS Batch API**：ORS 支援 matrix 模式，單次呼叫計算 N:1 步行時間矩陣，100 個站一次呼叫解決
2. **站點預篩**：先用 DB geo query 取 2km 內站點，再以 1.4km 直線距離（步行 ~18 分鐘）粗篩，只對剩餘站點呼叫 ORS
3. **Redis 快取**：熱門站點步行時間 TTL 24h，重複請求秒回

預期 P95 回應時間：< 4 秒（首次）、< 1 秒（快取命中）

---

## 7. 實作計畫

### Phase 1：Redis 基礎設施 + 步行快取（3 天）

- [ ] 加入 Redis 依賴（`ioredis`）
- [ ] 撰寫 `src/config/redis.ts`
- [ ] 實作 `walkTimeCache.get/set()` wrapper
- [ ] 接入現有 `orsWalkingRoute()` 呼叫點

### Phase 2：findReachableStops（4 天）

- [ ] 撰寫 `reachable-stops.service.ts`
- [ ] 整合 ORS Matrix API（`/v2/matrix/foot-walking`）
- [ ] 設計站點預篩邏輯（直線距離粗篩）
- [ ] 測試：台北市各區起點，驗證 20 分鐘步行圈涵蓋站點合理性

### Phase 3：換乘路線搜尋（2 週）

- [ ] 撰寫 `transfer-finder.ts`
- [ ] `findReachableStops()` 站點集合同時查 `BusStopModel` + `MetroStationModel`（跨運具換乘支援）
- [ ] 實作換乘候選組合搜尋演算法（公車↔公車、公車↔捷運、捷運↔公車）
- [ ] 限制換乘組合上限（防止 combinatorial explosion）
- [ ] 整合 TDX 兩段班次查詢
- [ ] 組裝 `AccessibleRoute` 格式（legs: 5 段）

### Phase 4：整合與測試（4 天）

- [ ] 更新 `findAccessibleRoutes()` 串接新元件
- [ ] 更新 `deduplicateRoutes()`：現有邏輯只針對單一 transit leg 去重，換乘路線有 2 段 transit leg，需改用所有 transit leg 組合的複合 key（例如 `{leg1.type}|{leg1.departure}|{leg1.arrival}|{leg2.type}|{leg2.departure}|{leg2.arrival}`）
- [ ] 更新 `accessible-route.schema.ts` Zod schema：在 `AccessibleRouteSchema` 加入 `transferCount: z.number()` 欄位
- [ ] 測試案例：偏遠地點（現在零結果）
- [ ] 測試案例：需換乘路線（板橋→信義區，注意跨城市 city 參數處理）
- [ ] 效能測試：P95 < 4 秒

### Phase 5：A11y 站內無障礙出口導航（3 天）

- [ ] 撰寫 `src/service/a11y-exit.service.ts`
  - [ ] `findAccessibleExits(stationName)`：A11y DB 查詢，正則比對「{站名}站」
  - [ ] `selectNearestExit(userCoords, exits)`：Haversine 距離排序
  - [ ] `buildExitWalkLeg(userCoords, station)`：整合查詢 + ORS + exitInfo 組裝
- [ ] 更新 `buildCandidate()`：捷運站 WalkLeg 改呼叫 `buildExitWalkLeg()`
- [ ] 更新 `WalkLeg` TypeScript interface，加入 `exitInfo` 欄位
- [ ] 測試案例：台北捷運站（有出口資料）→ exitInfo 正確填入
- [ ] 測試案例：TRA/THSR 站 → exitInfo 為 null，不影響路線組裝
- [ ] 測試案例：A11y 查無出口的捷運站（資料缺口）→ 降級至站點中心

---

## 8. 成功指標

| 指標                              | 現在      | 目標                     |
| --------------------------------- | --------- | ------------------------ |
| 有大眾運輸的地區零結果率          | 估計 >40% | < 10%                    |
| 支援換乘                          | ❌        | ✅（一次）               |
| 即時等車資訊                      | ✅        | ✅（維持）               |
| P95 回應時間                      | 未測量    | < 4 秒                   |
| 新增基礎設施                      | 無        | 僅 Redis                 |
| 捷運站 WalkLeg 附帶無障礙出口資訊 | ❌        | ✅（118 站覆蓋）         |
| 非捷運站無障礙出口資訊            | ❌        | ❌（資料不足，維持降級） |

---

## 9. 風險與緩解

| 風險                                | 可能性     | 緩解                                                       |
| ----------------------------------- | ---------- | ---------------------------------------------------------- |
| ORS Matrix API rate limit           | 中         | 自架 ORS 實例（Docker，免費）                              |
| 換乘組合爆炸（N×M 太大）            | 高         | 硬上限 20 組；加直線距離預篩                               |
| TDX API 呼叫增加（換乘需查兩段）    | 中         | 換乘組合限制 + 結果快取                                    |
| Redis 服務不可用                    | 低         | Graceful degradation：不快取直接算                         |
| A11y 站名比對失敗（站名格式不一致） | 中         | 正則比對「{名}站」+ 前綴模糊比對；查無出口時降級至站點中心 |
| A11y 資料不涵蓋 TRA/THSR 站         | 高（已知） | 明確降級：exitInfo = null，不影響路線主流程                |

---

## 10. 開放問題

1. **Redis 部署**：用 Railway/Render 免費方案，還是 Docker 本地？
2. **換乘最大步行時間**：換乘點之間步行上限設 10 分鐘是否合理？（對輪椅使用者可能太長）
3. **直達 vs 換乘排序**：換乘路線無障礙分數高時是否應優先於直達？
4. **城際換乘**：高鐵→捷運屬於換乘，是否納入第一階段？
5. **A11y 出口優先序**：當同一站有多個電梯出口時，選「距使用者最近」還是「距下一段交通工具最近」？目前設計選前者，若使用者需走較遠才能搭車，可能不是最佳解。
6. **A11y 資料維護**：188 筆出口資料為一次性匯入，若捷運局新增電梯需手動更新，是否建立定期同步機制？

---

## 附錄 A：ORS Matrix API 規格

```bash
POST https://api.openrouteservice.org/v2/matrix/foot-walking
Content-Type: application/json

{
  "locations": [
    [origin_lng, origin_lat],
    [stop1_lng, stop1_lat],
    [stop2_lng, stop2_lat],
    ...
  ],
  "sources": [0],       # origin 是 source
  "destinations": [1, 2, 3, ...],  # stops 是 destinations
  "metrics": ["duration"]
}

# Response: duration matrix in seconds
# 單次最多 3500 個位置（對 50 個站完全夠用）
```

---

## 附錄 C：A11y 資料庫現況（2026-06-05 查詢）

Collection: `accessibilities`

| 欄位                        | 說明                            | 完整率 |
| --------------------------- | ------------------------------- | ------ |
| `出入口電梯/無障礙坡道名稱` | 如「中山國中站出口電梯1」       | 100%   |
| `出入口編號`                | 如「出口1」、「單一出口」       | 100%   |
| `經度` / `緯度`             | WGS84 座標                      | 100%   |
| `location`                  | GeoJSON Point（2dsphere index） | 100%   |

| 統計項目   | 數值   |
| ---------- | ------ |
| 總筆數     | 188    |
| 涵蓋捷運站 | 118 個 |
| 電梯出口   | 144 筆 |
| 坡道出口   | 43 筆  |
| 其他       | 1 筆   |

**站名比對 Pattern**：`/^{stationName}站/`

- 正例：`"中山國中站出口電梯1"` ← `stationName = "中山國中"`
- 邊界：`MetroStation.stationName.Zh_tw` 的值需與 A11y 名稱前綴一致，若不一致需做 normalization

---

## 附錄 B：TDX GTFS 現況（供日後追蹤）

TDX v3 GTFS 端點預計推出但無明確時程。可定期查閱：

- TDX 公告頁：https://tdx.transportdata.tw/news/list
- Transitland 台灣 feeds 狀態：https://www.transit.land/feeds?location_name=Taiwan

一旦 GTFS 可用，方案 A（OTP）可作為未來升級路徑，與方案 B 的換乘圖共存。
