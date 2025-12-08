import { findA11yPlacesDeclaration, findGooglePlacesDeclaration } from "./tool";
const agentConfig = {
  tools: [
    {
      functionDeclarations: [
        findA11yPlacesDeclaration,
        findGooglePlacesDeclaration,
      ],
    },
  ],
  temperature: 0.1, // 保持低溫，讓工具呼叫更精準
  topP: 0.95,
  topK: 40,
  candidateCount: 1,
};

const rankConfig = {
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

const routeConfig = {
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
