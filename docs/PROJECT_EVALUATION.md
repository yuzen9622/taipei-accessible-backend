# Taipei Accessible Backend — 專題評估文檔

本文件針對 [taipei-accessible-backend](file:///Users/yuen/project/taipei-accessible-backend) 專案進行專題的可行性 (Feasibility) 與方向評估。

---

## 總體結論
> [!NOTE]
> **結論：非常適合做專題。**
> 該專案成功整合了三個關鍵面向：**TDX 公共運輸資料**、**OSM (OpenStreetMap) 可及性設施數據**、以及 **ORS (OpenRouteService) 步行路徑導航**。專案擁有清晰的 Express + TypeScript 架構與基於學術文獻的可解釋性打分模型，能同時在「系統工程」、「資料科學/融合」與「使用者體驗/演算法優化」三個層面展現出極具深度的研究與實作成果。

---

## 專案優勢 (Why Suitable)

1. **已有健全骨幹架構 (Solid Foundation)**
   - 採用現代 **Express + TypeScript** 架構，模組化程度高，層次清晰：
     - [routes](file:///Users/yuen/project/taipei-accessible-backend/src/routes) 與 [modules](file:///Users/yuen/project/taipei-accessible-backend/src/modules)（例如 [accessible-route](file:///Users/yuen/project/taipei-accessible-backend/src/modules/accessible-route)）分工明確。
     - 使用 Zod 做 schema 驗證與 [OpenAPI (Swagger)](file:///Users/yuen/project/taipei-accessible-backend/src/modules/accessible-route/accessible-route.schema.ts) 規範定義，方便與前端團隊進行合約驅動開發 (Contract-First Development)。
2. **多資料來源整合 (Data Fusion)**
   - 異質資料融合是專題中非常吸引評審的亮點：
     - **TDX API**：[TdxTokenManager.ts](file:///Users/yuen/project/taipei-accessible-backend/src/service/TdxTokenManger.ts) 實現了自動 OAuth2 token 快取與獲取。
     - **OSM 設施**：[import-osm-a11y.ts](file:///Users/yuen/project/taipei-accessible-backend/src/scripts/import-osm-a11y.ts) 提供地標可及性（電梯、坡道等）數據。
     - **ORS 導航**：[ors.ts](file:///Users/yuen/project/taipei-accessible-backend/src/config/ors.ts) 處理無障礙步行路徑規劃。
   - 適合進行「異質資料融合策略」、「資料稀疏性下之信心評估」等研究。
3. **可解釋的科學評分模型 (Explainable Scoring Model)**
   - [a11y-scoring.ts](file:///Users/yuen/project/taipei-accessible-backend/src/config/a11y-scoring.ts) 中實現了基於學術文獻（例如 `[CHI25]`, `[Huang25]`, `[TW-MOI]` 台灣內政部設計規範）的無障礙打分機制。
   - 區分 `facilityScore`、`timeScore` 與 `criticalFeatureScore`，便於進行參數敏感度分析與 A/B 評估。
4. **豐富的資料工程腳本 (Data Engineering Tools)**
   - [scripts](file:///Users/yuen/project/taipei-accessible-backend/src/scripts) 提供多種 GTFS、OSM 及 TDX 匯入腳本，便於建立離線測試資料庫並確保研究的「可重現性 (Reproducibility)」。
5. **高擴展性的後端平台**
   - 可產出穩定的 API 服務、效能測試報告，亦可作為移動端 (Mobile App) 或 Web 端無障礙地圖的強大引擎。

---

## 挑戰與風險 (Things to Watch Out For)

> [!WARNING]
> 1. **第三方服務依賴性強**：高度依賴 Google Maps Geocoding、ORS 與 TDX API。需管理多組 API keys、配額與 rate limit，應建立健全的 Retry 與 Circuit Breaker。
> 2. **資料稀疏性 (Data Sparsity)**：OSM 在部分偏遠地區的無障礙設施標註可能缺漏。若直接判定為「不可及」，會導致 404 或過度繞路。需設計搜尋半徑降級 (radius fallback) 與覆蓋率信心指標。
> 3. **時間估算過於簡化**：目前部分轉乘步行或等待時間採固定估算（如每站 2 分鐘），這會影響導航路徑排序的實用性。
> 4. **系統可觀察性 (Observability) 不足**：缺少全面的 Metrics 收集與 logging，使得在專題中難以提出「端到端延遲」與「打分準確性」的統計實驗圖表。
> 5. **展示濫用風險**：公開展示時，可能遭遇惡意請求耗盡 API 配額，需提早實作 rate-limit。

---

## 建議的專題方向 (依難度)

### 🔴 小型（實作 + Demo 導向）
- **核心目標**：完善系統功能，呈現精美的展示網頁。
- **工作內容**：
  1. 實作一個簡單的前端 Web 地圖（可展示無障礙路線與 score 分解）。
  2. 改善 `time-estimate` 機制（引入 TDX 到站資料）。
  3. 加入 radius fallback (150m $\rightarrow$ 300m $\rightarrow$ 500m) 避免資料缺漏。
  4. 準備 3 個真實案例（如捷運台北車站、西門站、信義商圈）並在報告中進行深入對照分析。

### 🟡 中型（實驗與工程導向 — 💡 推薦）
- **核心目標**：引入軟體工程最佳實踐與系統化評估。
- **工作內容**：
  1. **Scoring Model 實驗**：收集少量真實地標的可及性標籤（ ground truth ），對比不同權重組合（AHP 權重、文獻推薦權重）對路徑排序的一致率。
  2. **自動化測試與 CI**：在 [package.json](file:///Users/yuen/project/taipei-accessible-backend/package.json) 中配置 Jest 測試框架，為 [a11y-scoring.ts](file:///Users/yuen/project/taipei-accessible-backend/src/config/a11y-scoring.ts) 寫足單元測試，並配置 GitHub Actions 自底向上保障代碼品質。
  3. **資料品質報告**：統計大台北地區 OSM 設施的密度，產出資料 coverage 評估報告。

### 🟢 大型（研究與完整產品導向）
- **核心目標**：結合機器學習/先進決策模型與用戶研究。
- **工作內容**：
  1. **個性化打分**：加入使用者偏好模型（如「手動輪椅者優先避開坡度 > 8%」、「電動輪椅者優先避開無電梯轉乘」）。
  2. **機器學習結合**：利用貝式網路或分類模型，結合資料可信度與即時回饋，動態預測設施的可及狀態（例如推估電梯是否故障）。
  3. **身障者 Usability 測試**：邀請實際輪椅或視力障礙使用者進行路徑實測，收集定性與定量回饋，並撰寫完整論文級報告。
  4. **雲端部署與監控**：使用 Docker 容器化，部署至 GCP Cloud Run / Render，並串接 Prometheus/Grafana 進行效能與錯誤監控。

---

## 具體可交付物 (Deliverables)

- **系統與文件**：OpenAPI Spec (Swagger)、視覺化地圖 Demo 頁面。
- **科學評估與報告**：評分模型參數敏感度分析、大台北地區 OSM 資料覆蓋率 Heatmap。
- **測試與部署**：Scoring & Routing 測試套件 (Jest)、Docker 部署配置。

---

## 短期優先任務 (Milestones)

1. ⚡ **API 容錯與健壯性**：為外部 API加上 timeout (如 3000ms)、retry 與詳細錯誤分類，防止第三方服務故障。
2. 🕒 **時間估算精細化**：優先從 TDX 獲取即時/歷史大眾運輸時間，無資料時 fallback 到步行速度估算。
3. 🗺️ **搜尋半徑 Fallback**：當起訖點附近無 OSM 設施時，自動從 150m 擴展至 300m、500m，並在 Response 中標注。
4. 🧪 **單元測試建立**：為 [a11y-scoring.ts](file:///Users/yuen/project/taipei-accessible-backend/src/config/a11y-scoring.ts) 建立 100% 覆蓋率的單元測試，確保評分邏輯無 Bug。
5. 💻 **簡易前端**：建立一組完整的 API 測試集或簡單的 HTML/CSS 地圖視覺化介面。

---

## 專題評估指標 (Metrics)

- **Route Coverage**：成功回傳有效路徑的請求佔比。
- **平均回應延遲 (End-to-End Latency)**：API 處理異質資料融合的端到端時間（目標 $< 1.5\text{s}$）。
- **打分一致率 (Accuracy)**：系統打分與實際無障礙體驗的一致性。
- **資料密度比率 (OSM Density)**：每平方公里的 OSM 無障礙 Tag 完整度。
