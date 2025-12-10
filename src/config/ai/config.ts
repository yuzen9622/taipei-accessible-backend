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
  temperature: 0.1, // 保持低溫，讓工具呼叫更精準
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

export { agentConfig, rankConfig, routeConfig };
