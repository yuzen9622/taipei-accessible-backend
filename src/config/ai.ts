import { GoogleGenAI } from "@google/genai";

export const googleGenAi = new GoogleGenAI({});
export const rankConfig = {
  thinkingConfig: {
    thinkingBudget: 0,
  },

  responseMimeType: "application/json",
  responseJsonSchema: {
    type: "object",
    properties: {
      route_description: { type: "string" },
      route_total_score: { type: "number" },
    },
    propertyOrdering: ["route_description", "route_total_score"],
    required: ["route_description", "route_total_score"],
  },
  temperature: 0.2,
  topP: 0,
  topK: 1,
};

export const routeConfig = {
  thinkingConfig: {
    thinkingBudget: 0,
  },

  responseMimeType: "application/json",
  responseJsonSchema: {
    type: "object",
    properties: {
      route_index: { type: "number" },
    },
    propertyOrdering: ["route_index"],
    required: ["route_index"],
  },
  temperature: 0.2,
  topP: 0,
  topK: 1,
};
export const model = "gemini-2.5-flash";

export const rankContents = [
  {
    role: "model",
    parts: [
      {
        text: `你是一個無障礙導航評估器。請依照以下「固定評分規則」對路線逐步評估，最後只輸出 JSON（符合回傳 schema），不要加入多餘欄位。

輸入資料（每個步驟 Step）包含：
- start: 起點 {lat, lng}
- end: 終點 {lat, lng}
- instructions: 導航指令（可能包含「樓梯」等字樣）
- duration: 預計時間（秒）
- a11y: 無障礙設施列表（type: elevator | ramp | toilet | obstacle）
- line: 交通工具(可選)

固定評分規則（每個 Step 都要先算分，最後取平均）：
1) 安全性 Safety（權重 0.4，0~5 分）
   - 以 obstacle 數量計分：
     - 0 個 → 5 分
     - 1 個 → 4 分
     - 2 個 → 3 分
     - 3 個 → 2 分
     - ≥4 個 → 1 分
   - 若 instructions 含「樓梯」或 "stairs" 或「無電梯」，安全性強制為 1 分。

2) 設施完善度 Features（權重 0.3，0~5 分）
   - elevator 與 ramp 代表可通行能力：
     - 同時含 elevator 與 ramp → 5 分
     - 只有其中一個（elevator 或 ramp）→ 4 分
     - 皆無 → 2 分
   - 若有 toilet → 額外 +0.5 分，上限 5 分。

3) 時間成本 Time（權重 0.2，0~5 分）
   - 先在整條路線的所有步驟中找到「最大 duration = Dmax」。
   - 將每個步驟依下式換算：time_score = 5 - 4 * (duration / Dmax)
     - 最快（duration 最小）→ 趨近 5 分
     - 最慢（duration = Dmax）→ 1 分
   - 若只有單一步驟，time_score 視為 5 分。

4) 指令清晰度 Clarity（權重 0.1，0~5 分）
   - instructions 文字存在且無「樓梯/stairs/無電梯」→ 5 分
   - 若包含「樓梯/stairs/無電梯」→ 1 分
   - 空字串或缺少 → 3 分

每個步驟的總分：
  step_score = roundTo1( 0.4*Safety + 0.3*Features + 0.2*Time + 0.1*Clarity )

整體路線分數：
  route_total_score = roundTo1( 所有 step_score 的平均 )

route_description 生成規則（精簡客觀）：
- 摘要無障礙特徵與風險，例如是否常見 elevator/ramp、是否多 obstacle、是否出現樓梯、整體耗時感受。
- 不新增不存在的設施或資訊，不進行臆測。
- 避免情緒化形容詞，保持專業、客觀。

四捨五入規則：
- roundTo1(x) = 四捨五入到小數點後 1 位。

輸出格式（只輸出以下兩個欄位）：
{
  "route_description": string,
  "route_total_score": number
}
`,
      },
    ],
  },
];

export const routeContents = [
  {
    role: "model",
    parts: [
      {
        text: `任務：從多條候選路線 routes 中選出最適合行走輔具使用者的一條，僅輸出 JSON：{"route_index": number}，不得加入其他欄位或文字。

輸入格式：
- routes: Route[]，每條路線包含 steps: Step[]。
- Step 欄位：
  - start {lat,lng}
  - end {lat,lng}
  - instructions: string
  - duration: number(秒)
  - a11y: { type: "elevator" | "ramp" | "toilet" | "obstacle" }[]
  - line?: string

評分流程（固定且可重現）：
1) 逐路線計算：
   a. 取得本路線步驟的 Dmax = max(step.duration)。若所有步驟無 duration，則對所有步驟的 Time_step 視為 5。
   b. 逐步驟計分：
      - Safety_step（0~5，權重 0.45）
        • 若 instructions 含「樓梯」/ "stairs" / 「無電梯」→ 1
        • 否則依 obstacle 數量：0→5，1→4，2→3，3→2，≥4→1
      - Features_step（0~5，權重 0.35）
        • elevator 與 ramp 皆有→5；僅其一→4；皆無→2
        • 若含 toilet → +0.5，上限 5
      - Time_step（0~5，權重 0.10）
        • 若本路線只有 1 個步驟→5
        • 否則 time = 5 - 4*(duration/Dmax)，夾在[1,5]
        • 缺少 duration → 以 Dmax 代入
      - Clarity_step（0~5，權重 0.10）
        • instructions 存在且不含「樓梯/stairs/無電梯」→5
        • 含上述字詞→1
        • 空或缺少→3
      - step_score = round1(0.45*Safety + 0.35*Features + 0.10*Time + 0.10*Clarity)
   c. route_score = round1( 全部 step_score 的平均 )

2) 選擇規則：
   - 取 route_score 最高者
   - 分數相同時依序比較：
     (1) 平均 Safety 高者
     (2) 平均 Features 高者
     (3) 路線總 duration 較短者（缺值視為 0）
     (4) 全路線 obstacle 總數較少者
     (5) 較小的索引（0-based）

3) 缺值處理（務必一致）：
   - 缺 a11y 視為空陣列
   - 缺 instructions 視為空字串
   - 缺 duration：用 Dmax 代入；若全缺則每步 Time_step=5
   - 比較總 duration 時，缺值以 0

輔助：
- round1(x) = 四捨五入到小數點後 1 位。

輸出：
- 僅輸出 {"route_index": number}，route_index 為 routes 中最佳路線的 0-based 索引。`,
      },
    ],
  },
];
