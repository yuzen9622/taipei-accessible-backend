# 即時語音對話 WebSocket 協議規格（前端串接文件）

> 讀者：負責把語音功能接進正式前端的工程師。本文件目標是讓你不需要讀後端原始碼即可完成串接。
> 事實來源：`src/modules/voice/voice.gateway.ts`、`src/modules/voice/live-bridge.ts`、`src/modules/voice/poc-client.html`（可運作參考實作）、`memory/reviews/plans/a73ce70ab30ec0f2.md` §3.10。
> 定案：2026-07-10 使用者實測繁中音質可接受、工具轉接正常，採 **Gemini Live API proxy** 路線（詳見 `docs/specs/VOICE_POC_RESULT.md`）。

## 1. 總覽與架構

前端透過一條 WebSocket 連線把使用者的麥克風音訊即時串流給後端，後端不做語音辨識/合成，而是原樣轉發給 Google Gemini Live API，再把 Gemini 的逐字稿、工具呼叫、回覆音訊轉發回前端。後端同時是「單一真相」的工具執行者：Gemini 要查公車到站、規劃路線等，都是後端本地執行 tool 後把結果回傳給 Gemini。

```
┌──────────┐   wss:// (JSON + binary PCM16/16k)   ┌──────────────────┐   Gemini Live SDK   ┌─────────────────┐
│  前端       │ ───────────────────────────────────▶ │  Voice Gateway    │ ──────────────────▶ │ Gemini Live API │
│ (瀏覽器)    │ ◀─────────────────────────────────── │ (voice.gateway.ts │ ◀────────────────── │ (gemini-3.1-    │
│            │   JSON 事件 + binary PCM16/24k        │  + live-bridge.ts)│   audio/transcript/  │ flash-live-     │
└──────────┘                                        └──────────────────┘   tool_call          │ preview)        │
                                                              │                                └─────────────────┘
                                                              ▼
                                                     本地工具執行（公車到站、
                                                     路線規劃等，見 agent-tools.ts）
```

## 2. 連線與認證流程

### 2.1 WS 端點

```
wss://<host>/api/v1/voice/ws     (正式環境)
ws://localhost:<PORT>/api/v1/voice/ws   (本機開發)
```

其他路徑的 upgrade 請求會被回 `HTTP/1.1 404 Not Found` 並關閉 socket，不會升級成 WS。

### 2.2 首訊息認證（5 秒內）

連線建立（`onopen`）後，**必須在 5 秒內**送出第一個文字（JSON）訊息，型別為 `session.start`：

```json
{ "type": "session.start", "token": "<accessToken>", "userLocation": { "latitude": 25.0478, "longitude": 121.5170 } }
```

- `token`：必填，字串。**絕不可放在 URL query string**，只能放在這個首訊息的 body 裡。
- `userLocation`：選填，`{ latitude, longitude }` 皆為 number 才會生效，否則整欄位被忽略（不會報錯，只是後端當作沒帶）。
- 逾時未送、送出的不是合法 JSON、`type` 不是 `session.start`、`token` 不是字串、token 驗證失敗（含過期）→ 連線被關閉，close code `4401`。
- 認證完成前若送出 binary frame 或非 `session.start` 的訊息，同樣直接 `close(4401)`。
- 認證通過後，後端會先嘗試踢掉同一使用者「先前」的連線（見 §6 的 `4409`），再建立與 Gemini Live 的連線；成功後回傳 `{"type":"session.ready"}`，前端這時才能開始送音訊。

### 2.3 取得 token：登入 API

```bash
curl -X POST https://<host>/api/v1/user/login \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Jane Doe",
    "email": "jane@example.com",
    "client_id": "<OAuth 提供者的 sub/uid>",
    "avatar": "https://example.com/avatar.png"
  }'
```

回應（`accessToken` 在最外層，注意不是在 `data` 裡）：

```json
{
  "ok": true,
  "status": "success",
  "code": 200,
  "message": "OK",
  "data": {
    "user": { "_id": "...", "name": "Jane Doe", "email": "jane@example.com", "...": "..." },
    "config": { "...": "..." }
  },
  "accessToken": "<JWT，拿這個當 session.start 的 token>"
}
```

- `avatar` 為選填，其餘三欄必填（`name` 非空字串、`email` 需是合法 email、`client_id` 非空字串）。
- refreshToken 不在 JSON body 裡，是以 `httpOnly` cookie（名稱 `refreshToken`）設定，前端不需要也拿不到它。
- **accessToken 效期 60 分鐘**（見 §8），過期後 WS 認證會直接 `4401`，前端需重新登入或用 `/api/v1/user/token`／`/refresh` 換新 token 後再連 WS。

## 3. 訊息協議完整參考

### 3.1 Client → Server

| 型別 | 傳輸 | 欄位 | 範例 | 說明 |
|---|---|---|---|---|
| `session.start` | text (JSON) | `type`, `token` (string, 必填), `userLocation?` (`{latitude:number, longitude:number}`) | `{"type":"session.start","token":"eyJ...","userLocation":{"latitude":25.0478,"longitude":121.5170}}` | 必須是連線後第一則訊息，5 秒內送出 |
| （音訊） | binary | 原始 PCM16 bytes | — | 僅認證成功後才會被接受並轉發給 Gemini；認證前送 binary 會被視為未授權而 `close(4401)` |
| `session.end` | text (JSON) | `type` | `{"type":"session.end"}` | 前端主動結束會話；後端收到後 `close(1000, "client-end")` |

其他未定義的文字訊息型別會被忽略並在伺服器端 log 一行警告，不會回應任何錯誤給前端。

### 3.2 Server → Client

| 型別 | 傳輸 | 欄位 | 範例 | 觸發時機 |
|---|---|---|---|---|
| `session.ready` | text (JSON) | `type` | `{"type":"session.ready"}` | 認證成功且 Gemini Live 連線建立完成，前端此時才可開始送音訊 |
| （音訊） | binary | 原始 PCM16 bytes | — | Gemini 回覆的語音，見 §3.3 |
| `transcript` | text (JSON) | `type`, `role` (`"user"` \| `"model"`), `text` (string) | `{"type":"transcript","role":"user","text":"公車到站時間"}` | 使用者語音辨識逐字稿（`role:"user"`）或模型回覆逐字稿（`role:"model"`） |
| `tool_call` | text (JSON) | `type`, `name` (string，工具名) | `{"type":"tool_call","name":"getBusArrivalEstimate"}` | 模型觸發工具呼叫的當下（工具開始執行前） |
| `tool_result` | text (JSON) | `type`, `name`, `ok` (boolean), `durationMs` (number) | `{"type":"tool_result","name":"getBusArrivalEstimate","ok":true,"durationMs":812}` | 工具執行完成（成功或失敗都會送），不含實際回傳內容 |
| `interrupted` | text (JSON) | `type` | `{"type":"interrupted"}` | 使用者開口打斷模型正在說話時（barge-in） |
| `turn.complete` | text (JSON) | `type` | `{"type":"turn.complete"}` | 這一輪模型回覆全部結束 |
| `error` | text (JSON) | `type`, `code` (`"LIVE_CONNECT_FAILED"` \| `"LIVE_SESSION_ENDED"`) | `{"type":"error","code":"LIVE_SESSION_ENDED"}` | 見下方說明 |

`error` 的兩種 `code`：
- `LIVE_CONNECT_FAILED`：認證成功後，後端連 Gemini Live 失敗；緊接著會 `close(1011)`。
- `LIVE_SESSION_ENDED`：Gemini Live 連線自然結束（如 ~10 分鐘上限，見 §8）；緊接著會 `close(1000, "live-session-ended")`。

### 3.3 Binary frame 音訊格式

| 方向 | 編碼 | 取樣率 | 聲道 | 切幀間隔 |
|---|---|---|---|---|
| 上行（前端 → 後端）| PCM16 (16-bit signed little-endian) | 16000 Hz | mono | 每累積 1600 samples（= 100ms）送一個 binary frame |
| 下行（後端 → 前端）| PCM16 (16-bit signed little-endian) | 24000 Hz | mono | 依 Gemini 回傳的 chunk 大小，非固定 100ms，前端需能處理任意長度並依序播放 |

後端把上行 PCM16 轉成 base64 塞進 `mimeType: "audio/pcm;rate=16000"` 送給 Gemini；下行則是 Gemini inline audio data 解 base64 後原樣以 binary frame（`{binary:true}`）轉發，前端收到的 `ws.onmessage` 若 `e.data instanceof ArrayBuffer` 就是這個下行音訊。

## 4. 一次完整對話 turn 的時序

```
前端                         後端 Voice Gateway              Gemini Live API
 │  (連線 wss://.../voice/ws) │                               │
 │ ─session.start(token)────▶ │                               │
 │                            │ ── verify token ──            │
 │                            │ ── live.connect ─────────────▶ │
 │ ◀────session.ready──────── │ ◀──────────────────────────── │
 │  (開始送 16k PCM16 binary,  │                               │
 │   每 100ms 一個 frame)       │                               │
 │ ──binary audio───────────▶ │ ──sendRealtimeInput──────────▶ │
 │        ...（持續說話中）    │                               │
 │ ◀───transcript(role=user)─ │ ◀── inputTranscription ────── │
 │                            │                               │  （使用者停止說話，模型判斷需要查資料）
 │ ◀───tool_call─────────────  │ ◀── toolCall.functionCalls ── │
 │                            │ (本地執行工具，如查公車到站)      │
 │                            │ ──sendToolResponse───────────▶ │
 │ ◀───tool_result───────────  │                               │
 │ ◀───transcript(role=model)─ │ ◀── outputTranscription ───── │
 │ ◀───binary audio (24k)────  │ ◀── inlineData (audio) ────── │  （可能連續多個 chunk）
 │ ◀───turn.complete─────────  │ ◀── turnComplete ──────────── │
```

若使用者在模型說話中途開口，會收到 `interrupted`（見 §5）而非依序播完。

## 5. 打斷（barge-in）處理

收到 `{"type":"interrupted"}` 時，前端**必須立刻清空音訊播放佇列**（停止/丟棄所有已排程但尚未播放的下行音訊 buffer），否則會出現舊回覆音訊與新回覆重疊。參考實作 `poc-client.html` 的 `clearPlayback()`（關閉並捨棄整個 playback `AudioContext`，下一段音訊到達時重建）。

## 6. Close codes 與前端應對

| Code | 觸發原因（依程式碼） | 前端建議行為 |
|---|---|---|
| `4401` | token 缺失/格式錯誤/驗證失敗/過期；或 5 秒內未送 `session.start`；或認證前送了 binary/其他訊息 | 視為未授權：清除本地 token，導去重新登入（`/api/v1/user/login` 或 `/refresh`）取得新 accessToken 後重連 |
| `4409` | 同一使用者在別處開了新的語音連線（新連線會踢掉舊連線） | 提示使用者「已在其他裝置/分頁開啟語音對話」，不要自動重連此連線 |
| `1000` | 正常關閉：前端主動送 `session.end`（reason `client-end`），或 Gemini Live 連線結束（reason `live-session-ended`，伴隨先前收到的 `error:LIVE_SESSION_ENDED`） | 若是使用者主動結束，正常收尾；若是 `LIVE_SESSION_ENDED`（~10 分鐘連線上限，見 §8），提示使用者「對話已逾時，請重新開始會話」並重新走一次連線+認證流程 |
| `1011` | 伺服器內部錯誤，目前唯一來源是認證後連 Gemini Live 失敗（`LIVE_CONNECT_FAILED`） | 提示暫時無法使用語音，可加退避後重試 |

### 6.1 異常斷線（close code `1006`）

上表之外，前端一定會遇到**沒有 close handshake 的異常斷線**：後端每 30 秒 `ws.ping()`、連續兩次未收到 pong 就直接 `ws.terminate()`（`voice.gateway.ts`）；行動網路切換、斷網、電腦休眠也會產生相同結果。這些情況瀏覽器端看到的都是 `CloseEvent.code === 1006`（abnormal closure），不會落在上表任何一列。前端必須把 `1006` 當成一級公民處理，不可只實作上表四個 code。

**斷線當下（無論是否重連）立即執行：**

1. 停止並釋放麥克風：對 MediaStream 的每個 track 呼叫 `track.stop()`——不是只停止送資料，要真正釋放裝置（瀏覽器的錄音指示燈要熄滅）。
2. 清空播放佇列並釋放 AudioContext 資源（同打斷處理，見 §5）。
3. UI 顯示「連線中斷」狀態。

**重連狀態機：**

- 僅在使用者意圖仍為「會話啟用」（使用者沒按結束、語音元件仍掛載）時，才排程**指數退避**自動重連：初始 1 秒、每次倍增、**上限 30 秒**。
- 以下任一事件發生時，**必須取消所有待執行的重連計時器**：使用者按下結束、元件卸載（unmount/離開頁面）、登出、token 失效、或收到 `4409`。
- 差異化規則（與 §6 表格一致）：`4401` 必須先重新取得新 token 才可重連（不可拿舊 token 自動重試）；`4409` **不自動重連**；`1000`/`1011` 依表格處理。自動重連只適用於 `1006`。

**麥克風恢復規則（隱私）：**

- 重連成功並收到 `session.ready` 之後，才重新 `getUserMedia` 取得新的 MediaStream 恢復擷取（瀏覽器可能再次跳出權限提示，屬預期行為）。
- **絕不在使用者已結束會話後自動恢復**麥克風擷取——重連與恢復擷取的前提永遠是「使用者的會話啟用意圖還在」。

## 7. 音訊實作指引

**直接參考 `src/modules/voice/poc-client.html`（可運作的完整實作），不需要重新設計音訊管線。** 關鍵函式：

- 上行擷取與降頻（`AudioWorkletProcessor`，用「取樣抽稀」而非重取樣濾波，把瀏覽器原生取樣率降到 16kHz，並每 1600 samples/100ms 送一個 binary frame）：`captureWorklet` 字串，`src/modules/voice/poc-client.html:161-192`。
- 啟動麥克風、掛載 worklet、送出上行 binary frame：`startMic()`，`poc-client.html:194-222`。
- 下行 PCM16/24kHz 播放佇列（用 `AudioContext({sampleRate:24000})` 排程 buffer 依序播放，`playHead` 追蹤下一段開始時間）：`playPcm24()`，`poc-client.html:224-246`。
- 打斷時清空播放佇列：`clearPlayback()`，`poc-client.html:248-253`。
- WS 連線、認證、事件分派（`ws.onmessage` 依 `type` switch）：`connect()`，`poc-client.html:255-317`。

建議直接抄 `captureWorklet` / `startMic` / `playPcm24` / `clearPlayback` 這幾段邏輯搬進正式前端的音訊模組，不要重新發明取樣率轉換或播放排程邏輯。

## 8. 限制與已知事項

- **每使用者同時只允許一個語音會話**：第二條認證連線會讓第一條收到 `4409` 並被關閉（見 §6）。
- **accessToken 效期 60 分鐘**（`createAccessToken` 的 `expiresIn: "60m"`）；WS 只在握手當下驗證一次 token，會話中不會重驗——最壞情況是 token 在會話尾端過期，但當次會話仍會正常跑完。
- **Gemini Live 連線約 10 分鐘上限**，到時後端會收到 Gemini 端的 `onclose`，回前端 `error:LIVE_SESSION_ENDED` 後 `close(1000)`；**目前未實作 session resumption**（不會自動接續），前端需整個重新走一次連線＋認證流程。
- **Gateway 目前未做 Origin 檢查**（任何來源都能發起 WS upgrade）；正式上線前後端會補上，前端不需為此做任何事，但不要假設目前有這層防護。
- **透過 Cloudflare Tunnel 部署時，`wss://` 的 upgrade 是否放行尚未驗證**（POC 階段未經過 tunnel 測試），正式環境串接時若連線失敗需優先確認 tunnel 設定。

## 9. 本機開發環境

```bash
VOICE_POC_ENABLED=true npm run dev
```

啟動後瀏覽器開 `http://localhost:<PORT>/api/v1/voice/poc`，即可用後端提供的參考測試頁（`poc-client.html`）貼上 accessToken 實際跑一次語音對話，用來對照自己前端實作的行為是否一致。
