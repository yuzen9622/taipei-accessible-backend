import {
  findA11yPlacesDeclaration,
  findGooglePlacesDeclaration,
  planRouteDeclaration,
} from "./tool";
import {
  GenerateContentConfig,
  FunctionCallingConfigMode,
} from "@google/genai";
const agentConfig: GenerateContentConfig = {
  tools: [
    {
      functionDeclarations: [
        findA11yPlacesDeclaration,
        findGooglePlacesDeclaration,
        planRouteDeclaration,
      ],
    },
  ],
  temperature: 0.1,
  topP: 0.95,
  topK: 40,
  candidateCount: 1,
  maxOutputTokens: 1000,
  toolConfig: {
    functionCallingConfig: {
      mode: FunctionCallingConfigMode.AUTO,
    },
  },
};

const rankConfig: GenerateContentConfig = {
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

const routeConfig: GenerateContentConfig = {
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

const intentConfig: GenerateContentConfig = {
  responseMimeType: "application/json",
  responseJsonSchema: {
    type: "object",
    properties: {
      from: {
        type: "string",
        description: "出發地名稱；若用戶說『現在位置/這裡』則填 'current_location'",
      },
      to: { type: "string", description: "目的地名稱" },
      mode: {
        type: "string",
        enum: ["wheelchair", "elderly", "visual_impaired", "normal"],
      },
      departureTime: {
        type: "string",
        description: "'now' 或 ISO8601 / HH:mm；未指定時填 'now'",
      },
      preferences: {
        type: "object",
        properties: {
          minimizeTransfers: { type: "boolean" },
          preferElevator: { type: "boolean" },
        },
        propertyOrdering: ["minimizeTransfers", "preferElevator"],
        required: ["minimizeTransfers", "preferElevator"],
      },
    },
    propertyOrdering: ["from", "to", "mode", "departureTime", "preferences"],
    required: ["from", "to", "mode", "departureTime", "preferences"],
  },
  temperature: 0.1,
  topP: 0,
  topK: 1,
};

const explainConfig: GenerateContentConfig = {
  responseMimeType: "application/json",
  responseJsonSchema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "一句話路線摘要（交通工具、總時間、無障礙重點）",
      },
      accessibilityHighlights: {
        type: "array",
        items: { type: "string" },
        description: "無障礙亮點，只能取材自輸入資料，不可捏造",
      },
      warnings: {
        type: "array",
        items: { type: "string" },
        description: "風險與注意事項；無則為空陣列",
      },
      alternatives: {
        type: "string",
        description: "替代建議；無建議時填空字串",
      },
    },
    propertyOrdering: [
      "summary",
      "accessibilityHighlights",
      "warnings",
      "alternatives",
    ],
    required: ["summary", "accessibilityHighlights", "warnings", "alternatives"],
  },
  temperature: 0.2,
  topP: 0,
  topK: 1,
};

const airConfig: GenerateContentConfig = {
  responseMimeType: "application/json",
  responseJsonSchema: {
    type: "object",
    properties: {
      description: {
        type: "string",
        description: "對目前空氣品質的簡短說明與給行動不便人士的防護建議",
      },
      quality: {
        type: "string",
        enum: [
          "GOOD",
          "MODERATE",
          "UNHEALTHY_SENSITIVE",
          "UNHEALTHY",
          "VERY_UNHEALTHY",
          "HAZARDOUS",
          "",
        ],
      },
    },
    propertyOrdering: ["description", "quality"],
    required: ["description", "quality"],
  },
  temperature: 0.2,
  topP: 0,
  topK: 1,
};

export { agentConfig, rankConfig, routeConfig, intentConfig, explainConfig, airConfig };
