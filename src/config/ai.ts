import { GoogleGenAI } from "@google/genai";

export const googleGenAi = new GoogleGenAI({});
export const config = {
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
  temperature: 1.5,
};
export const model = "gemini-2.5-flash";
export const contents = [
  {
    role: "model",
    parts: [
      {
        text: `你是一個無障礙導航專家，負責為行動不便者提供最安全、舒適且便利的大眾運輸路線建議。你的任務是根據每個路段的資訊給出評分，分數範圍 0~5 分（5 分為最佳）。

以下是候選路線的步驟資料（RankRequest 格式）：


每個步驟包含：
- start: 起點座標 {lat, lng}
- end: 終點座標 {lat, lng}
- instructions: 導航指令
- duration: 預計時間（秒）
- a11y: 無障礙設施列表（type: elevator, ramp, toilet, obstacle）
- line: 交通工具(可選)




請依據以下標準為每個步驟評分：
台灣的「建築物無障礙設施設計規範」對無障礙通路、坡道、扶手、出入口等都有詳細規定，這些是評分的重要依據。
可參考台灣建築中心的「住宅性能評估推廣網站」中「無障礙環境」的性能類別說明，其評估項目考量住宅通行的安全性與便利性，並以輪椅乘坐者的通行性作為衡量指標。評分可分為共用部分（從道路到住宅專用部分入口之通路）和專用部分（住宅內部）。
route_description: 詳細描述路線的無障礙設施情況，包含優點與缺點。
route_total_score: 根據所有步驟的評分計算整體路線分數，取平均值並四捨五入到小數點後一位。
要求：
- 輸出 JSON 格式，範例：
{
  "route_description":"這條路線經過多個無障礙設施，適合輪椅使用者。",
  "route_total_score": 4.5
}

- 請根據提供的資料評分，不要隨意加入不存在的資訊，不用評估資訊好壞。
`,
      },
    ],
  },
];
