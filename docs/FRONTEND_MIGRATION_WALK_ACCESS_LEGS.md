# 前端遷移說明：開車／機車路線的步行銜接段（Walk Access Legs）

**影響端點**：`POST /api/v1/a11y/accessible-route`（`travelMode: "drive" | "motorcycle"`）
**日期**：2026-07-19
**性質**：破壞性擴充（回應結構相容，但 `legs` 內容假設改變）

---

## 變更摘要

過去開車／機車路線的 `routes[].legs` **只會**是 `DRIVE` 或 `MOTORCYCLE` 型別。
現在，當起點、終點或任一中途點**只能步行抵達**（離最近可行車道路 > 30 公尺）時，
後端會在路線的**頭、尾、以及各中途點**插入真實的 `WALK` 段：

```
起點(真實座標) ──WALK── 上車處 ──DRIVE── … ──DRIVE── 下車處 ──WALK── 終點(真實座標)
```

中途點若只能步行抵達，會出現**一進一出兩段** `WALK`（停車處 ↔ 中途點往返）：

```
… DRIVE(抵達中途點停車處) ── WALK(進) ── WALK(出) ── DRIVE(離開) …
```

## 前端必要調整

1. **依 `leg.type` 分派繪製**：不可再假設 drive/motorcycle 的 legs 全為單一車行型別。
   `legs` 是判別聯集，可能混合 `WALK` + `DRIVE`/`MOTORCYCLE`。
   - `WALK` leg 欄位：`from`/`to` 為**字串標籤**（如「起點」「上車處」「中途點 1 停車處」），
     `distanceM`、`minutesEst`、`polyline`（`[lng,lat][]`）、`a11yFacilities`、可選 `steps`。
   - `DRIVE`/`MOTORCYCLE` leg 的 `from`/`to` 為 **`{lat,lng}` 座標**（吸附到車道的上/下車點）。

2. **接受 ≤25 公尺的銜接殘差**：`WALK` 段端點與相鄰車行段端點可能相距至多約 **25 公尺**
   （人行道與車道分屬不同路網層的自然偏移）。後端**不會捏造**跨越此殘差的直線；
   前端如需視覺上完全連續，可自行在該殘差內補繪銜接線（選用）。

3. **`totalWalkDistanceM`**：drive/motorcycle 路線此值過去恆為 `0`，現在會反映銜接步行總距離。

4. **`accessibilityHighlights` 新增文字**：
   - 成功銜接：如「起點需步行約 150 公尺至可上車路段」「中途點 1 需步行約 300 公尺往返停車處」
     「於終點前約 180 公尺處停車，需步行至目的地」。
   - **無法建立可信步行路徑**時（被牆/河/分隔設施隔開等）：**不會**插入 `WALK` 段，改給警示，
     如「起點距可行車路段約 120 公尺，但無法建立可信步行路徑，請留意」。前端應顯示此警示。

## 不變的部分

- 回應外層 `origin`/`destination` 仍為使用者的**真實座標**。
- `transit`、`walk` 模式的 legs 行為不變。
- 回應 envelope（`ok/status/code/message/data`）與 schema 結構不變（`WalkLeg` 型別本就在 legs 聯集中）。
