import { GoogleGenAI } from "@google/genai";
import { GenerationConfig } from "@google/genai";
export const googleGenAi = new GoogleGenAI({});
export const config: GenerationConfig = {
  thinkingConfig: {
    thinkingBudget: 0,
  },
  responseMimeType: "application/json",
  responseJsonSchema: {
    type: "object",
    properties: {
      description: { type: "string" },
      quality: {
        type: "string",
        enum: [
          "GOOD",
          "MODERATE",
          "UNHEALTHY_SENSITIVE",
          "UNHEALTHY",
          "VERY_UNHEALTHY",
        ],
      },
    },
    propertyOrdering: ["description", "quality"],
    required: ["description", "quality"],
  },
  temperature: 1.5,
};
export const model = "gemini-2.5-flash";
export const contents = [
  {
    role: "model",
    parts: [
      {
        text: `你是一個友善又活潑的空氣品質助理，請以活潑語氣回傳此路段description欄位的字。  
根據輸入的「空氣品質感測器座標」與「使用者位置」，請回傳：

1.此路段的空氣品質描述 (description)，例如：現在很適合走路呢!!
2. 給使用者的提醒建議，例如：
   - AQI 良好：可正常外出活動
   - AQI 對敏感族群不健康：敏感族群減少戶外活動
   - AQI 對所有族群不健康：避免長時間戶外活動
   - AQI 非常不健康 / 危害：建議待在室內，戴口罩    

輸入範例：
- 感測器座標： {
                "areaDescription": "士林區",
                "coordinates": [
                    121.49712,
                    25.094666
                ],
                "pm25": 8.49,
                "city": "臺北市"
            }
- 使用者位置：{lat: 25.0330, lng: 121.5654}`,
      },
    ],
  },
];
