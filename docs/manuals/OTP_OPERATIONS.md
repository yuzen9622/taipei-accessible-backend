# OTP2 維運手冊 — 資料更新、建圖、Docker 部署

> 適用版本：OpenTripPlanner **2.9.0**（pin 於 `docker-compose.yml` 與 `build-otp-graph.sh`，2026-06-12 起）
> 相關規格：`docs/specs/FUNCTIONAL_SPEC_OTP2_INTEGRATION.md`（Phase 16）

本文件涵蓋 OTP sidecar 的完整生命週期：GTFS 資料取得 → 清理 → 台鐵班表注入 → graph 建置 → Docker 配置與啟動 → 驗證 → 故障排查。

---

## 0. 指令大全（複製貼上即用）

### 0.1 一鍵更新（沿用現有主 feed：更新 TRA 班表 → 重建 → 部署 → 驗證）

在專案根目錄整段貼上（subshell 包裹，中途失敗不會動到正在服務的資料；全程約 10–12 分鐘）：

```bash
( set -e
  BUILD_DIR=/tmp/otp-build
  rm -rf $BUILD_DIR && mkdir -p $BUILD_DIR

  # 1) 複製現有資料到建圖目錄（不動 otp-data 正本）
  cp otp-data/{otp-config.json,build-config.json,router-config.json,taiwan-gtfs.zip,taiwan-otp.osm.pbf} $BUILD_DIR/

  # 2) 抓最新 TRA 班表並注入（2 個 TDX 呼叫）
  TOKEN=$(npx dotenvx run -q -- sh -c 'curl -fsS -X POST "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token" -H "Content-Type: application/x-www-form-urlencoded" -d "grant_type=client_credentials&client_id=$TDX_CLIENT_ID&client_secret=$TDX_CLIENT_SECRET"' | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")
  curl -fsSL --compressed -H "Authorization: Bearer $TOKEN" -o /tmp/tra-timetable.json "https://tdx.transportdata.tw/api/basic/v3/Rail/TRA/GeneralTrainTimetable?%24format=JSON"
  python3 src/scripts/inject-tra-gtfs.py $BUILD_DIR/taiwan-gtfs.zip /tmp/tra-timetable.json

  # 3) 停服務容器釋放記憶體（必要！否則建圖 OOM）→ 離線建圖（~9 分鐘）
  docker stop otp
  docker run --rm -e JAVA_TOOL_OPTIONS="-Xmx12g" -v $BUILD_DIR:/var/opentripplanner opentripplanner/opentripplanner:2.9.0 --build --save

  # 4) 建圖成功才換檔（舊 graph 留 .prev 可回滾）→ 重啟
  cp otp-data/graph.obj otp-data/graph.obj.prev
  cp $BUILD_DIR/taiwan-gtfs.zip otp-data/taiwan-gtfs.zip
  mv $BUILD_DIR/graph.obj otp-data/graph.obj
  OTP_DATA_DIR=$PWD/otp-data docker compose up -d otp

  # 5) 等就緒（~40 秒）→ 驗證 TRA 在 graph 裡
  until curl -fsS -m 3 http://localhost:8080/otp/gtfs/v1 -X POST -H 'Content-Type: application/json' -d '{"query":"{feeds{feedId}}"}' 2>/dev/null | grep -q feedId; do sleep 5; done
  curl -s http://localhost:8080/otp/gtfs/v1 -X POST -H 'Content-Type: application/json' -d '{"query":"{ agency(id: \"1:TRA\") { routes { shortName } } }"}'
  echo "✅ OTP 更新完成"
)
```

> 主 feed（公車/捷運/高鐵）也要換新時，先手動從 TDX 平台下載新的全國 GTFS zip 覆蓋 `otp-data/taiwan-gtfs.zip` 並跑 `python3 src/scripts/clean-gtfs-feed.py otp-data/taiwan-gtfs.zip`，再執行上面整段。未來 `OTP_GTFS_URLS` 確認後改用 §2.1 的一鍵腳本。

### 0.2 日常啟停

```bash
OTP_DATA_DIR=$PWD/otp-data docker compose up -d otp    # 啟動
docker stop otp                                         # 停止
docker logs otp --tail 20                               # 看載入進度
```

### 0.3 健康檢查（一行）

```bash
curl -s http://localhost:8080/otp/gtfs/v1 -X POST -H 'Content-Type: application/json' -d '{"query":"{feeds{feedId}}"}' && echo " ← 有 feedId 即正常"
```

### 0.4 故障急救

```bash
# API 每次 30 秒才回 → 十之八九是 Mongo 掛了
brew services restart mongodb-community@7.0

# Docker daemon 整個沒反應
pkill -9 -f "Docker.app" ; sleep 3 ; open -a Docker

# graph 換壞了 → 回滾上一版
mv otp-data/graph.obj.prev otp-data/graph.obj && OTP_DATA_DIR=$PWD/otp-data docker compose up -d otp
```

---

## 1. 架構與檔案位置

```
TDX 全國 GTFS feed ──┐
                     ├─ clean-gtfs-feed.py（去髒資料、移除票價）
TRA 班表 JSON ───────┤
                     ├─ inject-tra-gtfs.py（注入台鐵 943 車次）
Geofabrik 台灣 OSM ──┤
                     └─► otp --build --save ──► graph.obj
                                                  │
                              docker compose up ──┴─► localhost:8080（GraphQL）
                                                        ▲
                              otp-routing.service.ts ───┘（Node 後端唯一消費者）
```

| 路徑 | 內容 |
|---|---|
| `otp-data/` | OTP 資料目錄（容器 mount 到 `/var/opentripplanner`） |
| `otp-data/graph.obj` | 序列化路網圖（~1.8 GB，**與 OTP 版本綁定**） |
| `otp-data/taiwan-gtfs.zip` | 清理＋注入後的全國 GTFS feed |
| `otp-data/taiwan-otp.osm.pbf` | 台灣 OSM 街道圖（Geofabrik，~324 MB） |
| `otp-data/build-config.json` | 建圖設定（transitService 區間、OSM tag mapping） |
| `otp-data/router-config.json` | 查詢設定（輪椅成本、searchWindow、street timeout） |
| `otp-data/otp-config.json` | 功能開關（`ActuatorAPI: true`，healthcheck 用過、現已改 TCP） |
| `src/scripts/build-otp-graph.sh` | 一鍵更新 pipeline（cron 每週日 04:00 建議） |
| `src/scripts/clean-gtfs-feed.py` | TDX feed 髒資料修復（見檔頭註解的完整清單） |
| `src/scripts/inject-tra-gtfs.py` | 台鐵班表注入（TDX 無官方 TRA GTFS，見 §3） |

### 必要環境變數

| 變數 | 用途 | 範例 |
|---|---|---|
| `TDX_CLIENT_ID` / `TDX_CLIENT_SECRET` | TDX OAuth2 憑證（`.env` 已有） | — |
| `OTP_GTFS_URLS` | 全國 GTFS zip 下載 URL（空白分隔可多個） | 見 §2.1 |
| `OTP_DATA_DIR` | 資料目錄絕對路徑 | `$PWD/otp-data` |
| `OTP_JAVA_XMX` | 建圖 heap（選填，預設 12g） | `12g` |
| `OTP_SERVE_XMX` | 服務 heap（選填，預設 6g） | `6g` |
| `OTP_OSM_BBOX` | OSM 裁切範圍（選填，**不設 = 全台**） | — |

---

## 2. 資料更新

### 2.1 路徑 A：一鍵完整更新（建議走法）

```bash
export OTP_DATA_DIR="$PWD/otp-data"
export OTP_GTFS_URLS="<全國 GTFS zip 的下載 URL>"
src/scripts/build-otp-graph.sh
```

腳本自動執行：抓 feed → 清理 → **抓 TRA 班表並注入** → OSM 月度更新 → gtfs-validator 驗證 → 離線建圖 → 原子換檔 → 重啟容器 → healthcheck（失敗自動回滾舊 graph）。

> **⚠️ 全國 feed URL 注意事項**
> 目前 repo 內的 `taiwan-gtfs.zip` 來自 TDX「GTFS 服務（Beta）」的全國靜態資料集，當初為手動下載。TDX 的軌道 GTFS API 端點（`/api/gtfs/V3/Map/GTFS/Static/Rail/*`）**只提供北捷 TRTC**（實測 400：「目前只提供北捷(TRTC)的GTFS資料」），v2 premium 端點已棄用。設定 `OTP_GTFS_URLS` 前先到 [TDX 平台](https://tdx.transportdata.tw/) 會員中心的 GTFS 服務頁確認現行下載端點。

> **⚠️ 建圖前務必停掉服務容器**
> 本機 Docker VM 僅 15.6 GB，服務中的 otp 容器實際吃 ~12 GB，與 12g 建圖 heap 同時跑**必定 OOM（exit 137）**。`build-otp-graph.sh` 在獨立 temp 目錄離線建圖、不動服務容器——在記憶體吃緊的本機跑時，先 `docker stop otp` 再執行，建完腳本會自動重啟。

### 2.2 路徑 B：沿用現有 feed 重建（升級版本、改 build-config、僅更新 TRA）

不重新下載主 feed，直接用 `otp-data/` 裡的現有檔案：

```bash
# 1. 準備建圖目錄（複製、不動正在服務的資料）
BUILD_DIR=/tmp/otp-build
mkdir -p $BUILD_DIR
cp otp-data/{otp-config.json,build-config.json,router-config.json,taiwan-gtfs.zip,taiwan-otp.osm.pbf} $BUILD_DIR/

# 2.（選擇性）更新台鐵班表 — 見 §3
# 3. 停服務容器（釋放記憶體）
docker stop otp

# 4. 離線建圖（~9 分鐘）
docker run --rm -e JAVA_TOOL_OPTIONS="-Xmx12g" \
  -v $BUILD_DIR:/var/opentripplanner \
  opentripplanner/opentripplanner:2.9.0 --build --save

# 5. 換檔並重啟
cp otp-data/graph.obj otp-data/graph.obj.prev   # 留回滾備份
cp $BUILD_DIR/graph.obj otp-data/graph.obj.new && mv otp-data/graph.obj.new otp-data/graph.obj
OTP_DATA_DIR=$PWD/otp-data docker compose up -d otp
```

---

## 3. 台鐵（TRA）班表注入

**背景**：TDX 全國 feed 只有 TRA 的站點與 agency，**沒有班表**（routes/trips/calendar 為 0），官方也沒有 TRA 的 GTFS 端點。沒有注入的 graph 永遠排不出台鐵腿，台鐵覆蓋將完全依賴有 429 限流的 TDX MaaS API。

`inject-tra-gtfs.py` 把 TDX v3 `GeneralTrainTimetable` JSON 轉成 GTFS 列注入主 feed，引用 feed 既有的 `TRA_<StationID>` 站點（239 站全對齊、零新增）。路徑 A 已自動包含；手動執行：

```bash
# 1. 取 token 並下載班表（1 個 TDX 呼叫）
TOKEN=$(curl -fsS -X POST \
  "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=$TDX_CLIENT_ID&client_secret=$TDX_CLIENT_SECRET" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")

curl -fsSL --compressed -H "Authorization: Bearer $TOKEN" \
  -o /tmp/tra-timetable.json \
  "https://tdx.transportdata.tw/api/basic/v3/Rail/TRA/GeneralTrainTimetable?%24format=JSON"

# 2. 注入（冪等：重跑會先剝掉舊注入）
python3 src/scripts/inject-tra-gtfs.py otp-data/taiwan-gtfs.zip /tmp/tra-timetable.json
# 預期輸出：injecting: routes=7 trips=943 services=15 stop_times=21622 ...

# 3. 注入只改 zip，必須重建 graph 才生效 → 回 §2.2 步驟 3
```

### 已知限制（設計取捨，非 bug）

- **班表效期**：TDX 以「快照」發布（EffectiveDate == ExpireDate），注入時 calendar 設為生效日 +45 天，靠每週 rebuild 滾動。超過 45 天不更新，台鐵班次會從 OTP 消失。
- **假日班表**：`NationalHolidays`／`DayBeforeHoliday` 等旗標 GTFS calendar 無法表達，國定假日的加開/停駛不會反映——與 MaaS 班表漂移同級別誤差，誤點由 realtime overlay 修正。
- **輪椅標記**：`WheelChairFlag=1` 的 164 班標 `wheelchair_accessible=1`，其餘留「未知」。**不要改成 2（不可及）**——router-config 的 3600 秒 inaccessibleCost 會把輪椅查詢全部擠到那 164 班。

---

## 4. Docker 配置

`docker-compose.yml` 重點逐項：

```yaml
services:
  otp:
    image: opentripplanner/opentripplanner:2.9.0   # 永遠 pin 版本，不用 latest
    command: ["--load"]        # 只給 flags！entrypoint 寫死 /var/opentripplanner，
                               # 多給路徑會報 "must supply a single directory name"
    ports:
      - "127.0.0.1:8080:8080"  # 只綁 localhost，永不對外
    volumes:
      - ${OTP_DATA_DIR:-/var/otp}:/var/opentripplanner
    environment:
      JAVA_TOOL_OPTIONS: "-Xmx${OTP_SERVE_XMX:-6g}"   # 全台 graph 服務 heap
    healthcheck:
      # 2.9 image 沒帶 curl/wget；bash /dev/tcp 等價 —— Grizzly 在 graph
      # 載入完成後才綁 8080，TCP 通 = ready for routing
      test: ["CMD", "bash", "-c", "</dev/tcp/localhost/8080"]
```

**版本升級 SOP**：`graph.obj` 序列化與 OTP 版本綁定，**升級＝必須重建**。順序：改 compose 與 build script 的 pin → 走 §2.2 用新 image 建圖 → 換檔 → `docker compose up -d otp`（compose 會用新 image 重建容器）。舊 graph 留 `graph.obj.prev` 可配舊 image 回滾。

---

## 5. 啟動與驗證

```bash
OTP_DATA_DIR=$PWD/otp-data docker compose up -d otp
```

載入 1.8 GB graph 約 30–60 秒。**判斷健康打 GraphQL，別只看 actuator**：

```bash
# ready 檢查（回 {"data":{"feeds":[{"feedId":"1"}]}} 即就緒）
curl -s http://localhost:8080/otp/gtfs/v1 -X POST \
  -H 'Content-Type: application/json' -d '{"query":"{feeds{feedId}}"}'

# TRA 注入驗證（應回 7 種車種）
curl -s http://localhost:8080/otp/gtfs/v1 -X POST \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ agency(id: \"1:TRA\") { routes { shortName } } }"}'

# 端對端試排（台中→豐原，應出現 RAIL 腿；locale 影響站名語言）
curl -s http://localhost:8080/otp/gtfs/v1 -X POST \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ plan(from:{lat:24.137288,lon:120.6869251}, to:{lat:24.254204,lon:120.723735}, transportModes:[{mode:TRANSIT},{mode:WALK}], numItineraries:3, locale:\"zh-TW\") { itineraries { duration legs { mode from { name } } } } }"}'
```

Node 端固定使用 OTP 作為唯一路徑規劃引擎；設定 `OTP_BASE_URL` 指向 GraphQL 服務即可。

---

## 6. 故障排查

| 症狀 | 原因 | 處置 |
|---|---|---|
| 建圖 exit 137（Killed） | Docker VM 記憶體不足（服務容器 ~12 GB + 建圖 12g heap） | 先 `docker stop otp` 再建 |
| 容器無限重啟、載入 NPE | feed 有自迴圈電梯 pathway（from==to） | 確認 feed 過了 `clean-gtfs-feed.py` |
| 查詢 20 秒以上 | feed 帶 384 萬行票價，OTP 每條 itinerary 掃票價 | cleaner 已整包移除 `fare_*.txt`，確認沒用未清理的 zip |
| plan 全回空陣列（連純步行都空） | 起訖點 snap 到斷裂街道孤島（2.5 的台中車站正門案例） | 2.9 已大幅改善；Node 端有 snap-to-stop fallback 防禦 |
| API 回應每次都 ~30 秒 | 不是 OTP——通常是 **MongoDB 掛了**，mongoose 連線逾時疊加 | `brew services restart mongodb-community@7.0` |
| healthcheck unhealthy 但查詢正常 | healthcheck 用了 image 沒有的指令（如 curl） | 用 bash `/dev/tcp` TCP 檢查（現行配置） |
| `/otp/actuators/health` 404 | ActuatorAPI 是 sandbox 功能預設關 | `otp-config.json` 開 `{"otpFeatures":{"ActuatorAPI":true}}`，或直接打 GraphQL |
| 排不出台鐵腿 | TRA 注入後沒重建 graph；或 calendar 過期（+45 天） | 重走 §3 + §2.2；檢查 `agency(id:"1:TRA")` 的 routes 數 |
| 站名變英文 | plan 預設 locale=en，feed 的 translations.txt 只有英譯 | 查詢帶 `locale:"zh-TW"`（`otp-routing.service.ts` 已內建） |
| 文湖線/環狀線/台中捷運排不到 | OTP graph 沒含該路線有效班表 | 比照 TRA 注入或修補 feed 後重建 graph |
| TDX 下載 429 | quota 限流（burst 4–6 呼叫即觸發） | 等冷卻重試；pipeline 每次 build 僅 2–3 個呼叫，正常不會撞 |

---

## 7. 例行排程建議

```cron
# 每週日 04:00 全量更新（feed + TRA + 月度 OSM + 建圖 + 換檔）
0 4 * * 0  cd /path/to/accessible-smart-map-backend && \
           OTP_DATA_DIR=$PWD/otp-data OTP_GTFS_URLS="<url>" \
           src/scripts/build-otp-graph.sh >> /var/log/otp-build.log 2>&1
```

每週滾動即可同時滿足：TRA calendar 的 45 天效期、TDX 班表改點、OSM 月度更新（腳本內建 30 天判斷）。
