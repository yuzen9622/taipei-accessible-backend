# Routing Pipeline 異常診斷報告

> 日期：2026-06-11 ｜ Branch：`feat/hybrid-transit-routing`
> 狀態：草稿（待修訂）

## TL;DR

| # | 問題 | 根因 | 嚴重度 | 修正成本 |
|---|------|------|--------|----------|
| 1 | 同一公車線（500延）出現多條 candidates，totalMinutes 50 / 84 / 85 差距巨大 | 雙 planner 無 cross-source normalization ＋ `departureTime` 只傳給 GTFS、沒傳給 TDX | 高 | 低（一行修正＋一層 normalization） |
| 2 | 公車「同站下車、原地等同一條線的下一班」被當成合法轉乘 | transfer 配對沒有排除 leg1 = leg2 同路線的退化解 | 高 | 低（兩個 guard） |
| 3 | Polyline 大量重複頂點、payload 肥大 | shapes.txt 直接 slice，無 simplification | 中 | 低 |
| 4 | a11y enrichment 耦合在 routing layer | 兩個 planner 內部各自呼叫 `attachA11yToLeg` | 中 | 中 |

---

## 問題一：同一條公車線被展開成多條 route candidates

### 現象

台中（高美 → 台中科大）的查詢回傳三條 candidates：

| Candidate | routeId | 路線 | 發車 | totalMinutes |
|---|---|---|---|---|
| A | `gtfs-direct-TXG5002_...` | 500延 | **08:43** | 50 |
| B | `tdx-2-2026-06-11T11:01:47` | 500延 | 11:05 | 84 |
| C | `tdx-0-2026-06-11T11:10:47` | 304 | 11:14 | 85 |

A 和 B 是同一條 bus line，只是上下車站不同；且 A 的發車時間與 B/C 差了 2.5 小時。

### 根因 1：雙 planner 平行跑、merge 後無 normalization

`USE_GTFS_ROUTER=true` 時 orchestrator 平行執行兩套引擎並直接串接
（`accessible-route.service.ts:1625-1644`）：

- `planGtfsRoute()` → 本地 GTFS graph router → `gtfs-direct-*`
- `planTdxRoute()` → TDX MaaS 託管引擎 → `tdx-N-*`

GTFS router **內部**有做 per `(routeId, direction)` 取最早班次的 dedup
（`gtfs-router.service.ts:610-617`），所以單一 planner 不會 N² 爆炸；
重複發生在**跨 planner**層級。`finalizeRoutes` 的 dedup key 是
`BUS|routeName|departureStop|arrivalStop|direction`
（`accessible-route.service.ts:1533-1549`）——兩個 planner 各自 snap 到
不同上車站（中山高美路口 vs 中山董公街口），key 不同，兩條 500延 都存活。

> 註：原始推測的「stop-pair N² expansion」「fallback planner 觸發不一致」
> 均不成立——兩個 planner 是設計上恆常平行跑，不是 fallback 關係。

### 根因 2（主因）：`departureTime` 只傳給 GTFS，沒傳給 TDX

```ts
// accessible-route.service.ts:1627-1640
m.planGtfsRoute(origin, destination, { maxTransfers, mode, departureTime: opts.departureTime })
m.planTdxRoute(origin, destination)   // ← opts 完全沒傳！
```

`planTdxRoute` 其實接受 `opts.departureTime`（`tdx-routing.service.ts:83`），
收不到就 fallback 成 `new Date()`（`:382`）。本次請求帶了約 08:29 的
departureTime：

- GTFS 照指定時間規劃 → 08:43 發車（等 14 分）
- TDX 照牆上時鐘 11:01 規劃 → 11:05 / 11:14 發車

ranking 在比較**兩個不同出發時間**的方案，totalMinutes 完全不可比。
這不是 cache、也不是時區 bug（GTFS 的 `departureSec < afterSec` 過濾邏輯正確）。

### 根因 3：車程時間來源不同（32 min vs 77 min）

- GTFS：feed `stop_times` 實算（`arrivalSec - departureSec`，`gtfs-router.service.ts:601`）
- TDX：MaaS 引擎自己的估時（`tdx-routing.service.ts:156`）

同一走廊差 45 分鐘，其中一邊資料有問題。已知 TDX MaaS 有班表漂移前科，
建議抽查 500延 真實班表確認哪邊接近現實。

### 修正建議（優先序）

1. **一行修正**：把 `departureTime`（與 `mode`）傳進 `planTdxRoute`。
2. **Cross-planner normalization**：`finalizeRoutes` dedup 前，以
   `routeName + direction` 分組，每組僅保留 totalMinutes 最佳者。
3. 驗證 GTFS stop_times vs TDX 估時何者貼近現實，決定信任順序。

---

## 問題二：「同站等同路線下一班」被當成轉乘方案

### 機制（`findOneTransferRoutes`，`gtfs-router.service.ts:1237`）

1. **同一條線同時進入兩個候選池。** 演算法把「起點可上車 trips」與
   「有到終點 trips」各取 per `(routeId|direction)` 代表，再用共同 hub 配對。
   直達線（同時服務起終點）會同時出現在兩邊。
2. **配對無同路線排除。** 配對迴圈（`:1464-1530`）與 `buildTransferRoute`
   （`:1545` 起）都沒有 `leg1.routeId !== leg2.routeId` 檢查。dedup key
   `${origTripId}|${hubName}|${sl.tripId}` 對同路線不同 trip 視為不同，照樣通過。
   於是該線任一中途站都是合法 hub：「搭 500延 到 X 站 → 在 X 站轉乘 500延」。
3. **等到的是下一班而非原車續坐**：leg2 班次搜尋從
   `leg1.arrivalSec + transferWalkSec` 開始（`:1562-1568`），同站距離 0 時
   `transferWalkSec` 仍有 `MIN_TRANSFER_WALK_SEC` 下限，剛搭的那班被過濾，
   `findDirectConnections` 回傳同路線下一班 → 原地等一個班距。
4. **下游救不回**：transfer 路線有 2 段 BUS legs，與直達版的
   `buildRouteKey` 不同，dedup 殺不掉，且污染 ranking。

Two-transfer（Phase 12，`:1680` 起）同樣沒有相鄰段同路線排除，
會產生「A → A → B」組合。

### 修正

```ts
// findOneTransferRoutes 的 secondLegs 迴圈內
const r1 = routeDirByTrip.get(origTripId)?.split("|")[0];
const r2 = routeDirByTrip.get(sl.tripId)?.split("|")[0];
if (r1 && r1 === r2) continue; // 同路線「轉乘」是退化解：同向應走 direct，反向是回頭路

// buildTransferRoute 內（leg2 可能 fallback 到 leg2List[0]，需保險）
if (leg1.routeId === leg2.routeId) return null;
```

Two-transfer 比照辦理（檢查 leg1≠leg2、leg2≠leg3）。

---

## 問題三：Polyline 冗餘

- GTFS 路徑：`getShapePolyline()` 直接 slice `shapes.txt`
  （`gtfs-router.service.ts:358-373`），無 simplification、無連續重複點去除。
- Legacy/TDX 路徑：站點座標串接，相鄰同位置站產生 duplicate vertices。

**修正**：輸出前統一過一層 consecutive-duplicate removal ＋
Douglas-Peucker（tolerance ~5-10 m），預估 payload 可縮 50% 以上。

---

## 問題四：a11y enrichment 耦合在 routing layer

`attachA11yToLeg()` 在兩個 planner 內部各自呼叫
（`gtfs-router.service.ts:826-838`、`tdx-routing.service.ts:333-341`），
routing 與 POI layer 耦合，且 `nearbyA11y` 查詢重複執行。

**修正**：抽到 orchestrator（`finalizeRoutes`）作為 post-processing step，
只對最終 top-N enrichment，省查詢也利於 route ranking / rendering 分離。

---

## 附錄 A：外部 Routing Engine 評估（Valhalla / GraphHopper / OSRM / OTP2 / MOTIS）

核心需求：**GTFS 大眾運輸多模規劃**（公車＋捷運＋台鐵＋轉乘）＋
**輪椅可及性**（街道層級＋站體設施）＋自有圖資（TDX GTFS、OSM、自建 a11y 資料）。

| 引擎 | 大眾運輸（GTFS） | 輪椅/步行 | 評估 |
|---|---|---|---|
| **OSRM** | ❌ 無 | Lua profile 可自訂，但無現成 wheelchair profile | 不適合——純街道引擎，無法取代 transit router；只能當步行腿替代品，但現有 ORS 已有 wheelchair profile，換它是倒退 |
| **GraphHopper** | ⚠️ 有 PT 模組（GTFS），但維護消極、功能受限（frequencies、多 feed 支援弱） | custom model 可調 | 不建議押注——PT 模組非其發展重心 |
| **Valhalla** | ⚠️ multimodal 存在但 transit 資料管線（Transitland ingestion）長期半荒廢 | ✅ 原生 `pedestrian` costing 有 wheelchair 選項 | transit 不可靠；但可考慮取代 ORS 做步行腿（自架、動態 costing、免外部 quota） |
| **OTP2** (OpenTripPlanner) | ✅ 一級公民：RAPTOR、多 feed、frequencies、轉乘最佳化 | ✅ `wheelchair=true` 原生吃 GTFS `wheelchair_boarding` ＋ OSM wheelchair tags | **最適配**——這正是它被造出來的用途 |
| **MOTIS** | ✅ RAPTOR 系、效能極佳、記憶體友善 | ✅ 有 wheelchair/elevator 支援（C++，部署輕） | OTP2 的輕量替代，社群較小 |

### 結論與建議架構

OSRM / GraphHopper / Valhalla 都是**街道引擎**，transit 不是它們的強項——
拿它們做公車轉乘規劃等於還是要自己寫 transit graph（就是現在這套會長 bug 的東西）。
真正對口的是 **OTP2**（或 MOTIS）：

```
TDX GTFS feeds ─┐
                ├→ OTP2 / MOTIS（transit 規劃：班表、轉乘、wheelchair flag）
OSM (Taiwan) ───┘            │
                             ▼
              Node orchestrator（現有）
              ├─ a11y scoring / enrichment（自有核心價值，保留）
              ├─ realtime overlay（現有，保留）
              └─ ORS（或 Valhalla）wheelchair 步行腿（現有，保留）
```

**好處**：問題一、二這類演算法 bug 整類消失（RAPTOR 保證 Pareto-optimal、
天然 route normalization、時間語義正確）；擺脫 TDX MaaS quota 與班表漂移；
GTFS 資料管線已存在（目前已 import GTFS 進 Mongo）。

**成本**：多維運一個 Java（OTP2）或 C++（MOTIS）服務、記憶體需求
（台灣全島 feed＋OSM 約需數 GB）、graph rebuild 流程。

**建議路徑**：先用低成本修正（問題一、二的 guard）止血現有 router；
並另開 spike 用台中市 GTFS + OSM 架一台 OTP2 跑同樣 query 對比結果，
再決定是否汰換自製 transit graph。

---

## 附錄 B：Entry-point Flow

```
accessibleRoute()                      accessible-route.controller.ts:9
  └─ findAccessibleRoutes()            accessible-route.service.ts:1608
      ├─ USE_GTFS_ROUTER=true:
      │   ├─ planGtfsRoute()           gtfs-router.service.ts:1058
      │   │   ├─ findDirectConnections()        :437
      │   │   ├─ findOneTransferRoutes()        :1237
      │   │   └─ findTwoTransferRoutes()        :1680（Phase 12）
      │   └─ planTdxRoute()            tdx-routing.service.ts:277（TDX MaaS API）
      └─ finalizeRoutes()              accessible-route.service.ts:1576
          ├─ deduplicateRoutes()       :1541
          ├─ scoreAndRank() → top 3
          ├─ overlayFacilityStatus() / overlayRealtimeTransit()（fail-soft）
          └─ slimRoutes() / compactRoutes()（Phase 14）
```
