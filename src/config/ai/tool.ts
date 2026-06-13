import { FunctionDeclaration, Type } from "@google/genai";
import OpenAI from "openai";

const findGooglePlacesDeclaration: FunctionDeclaration = {
  name: "findGooglePlaces",
  description:
    "使用 Google Maps 搜尋地點。可以用於搜尋附近的設施，也可以搜尋特定地標（如『台北101』、『台南車站』），不受距離限制。",
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: {
        // 參數名稱建議改為 query 或保持 keyword 但描述要變
        type: Type.STRING,
        description: "搜尋關鍵字，例如：'附近的咖啡廳' 或 '台中歌劇院'。",
      },
      latitude: {
        type: Type.NUMBER,
        description: "使用者當前緯度 (選填，用於優化搜尋結果)",
      },
      longitude: {
        type: Type.NUMBER,
        description: "使用者當前經度 (選填，用於優化搜尋結果)",
      },
      // 移除 radius
    },
    required: ["query"], // 現在只需要 query 是必填
  },
};
const findA11yPlacesDeclaration: FunctionDeclaration = {
  name: "findA11yPlaces",
  description:
    "查詢無障礙設施的專用資料庫。當用戶提到「無障礙」、「電梯」、「坡道」等關鍵字時，**務必優先**使用此工具。此工具可以接受經緯度，**也可以直接接受地點名稱**。",
  parameters: {
    type: Type.OBJECT,
    properties: {
      // 🌟 新增這個參數：讓 AI 可以傳 "台北車站" 進來
      query: {
        type: Type.STRING,
        description: "地點名稱，例如：'台北車站'、'淡水捷運站'。",
      },
      latitude: { type: Type.NUMBER, description: "如果有經緯度則填入" },
      longitude: { type: Type.NUMBER, description: "如果有經緯度則填入" },
      range: { type: Type.NUMBER, description: "搜尋範圍，預設200，單位公尺" },
    },
    // 🌟 關鍵：不要強制要求 latitude/longitude，只要 query 或 lat/lng 其中之一即可
    // 但在 function calling 定義中很難寫 OR 邏輯，所以我們通常把它們都設為 optional (不放在 required 裡)
    // 或者只 require 'query' (如果不清楚經緯度，query 就填地點名)
    required: ["query"],
  },
};

const planRouteDeclaration: FunctionDeclaration = {
  name: "planRoute",
  description:
    "【導航專用】規劃從起點(Origin)到終點(Destination)的交通路線。當用戶的語句結構為「從 A 到 B」、「A 去 B 怎麼走」或包含「導航」、「路線規劃」時，**必須**使用此工具。",
  parameters: {
    type: Type.OBJECT,
    properties: {
      origin: {
        type: Type.STRING,
        description:
          "起點。若用戶說「台中車站到...」，則起點為「台中車站」。若說「從這裡」、「目前位置」，填入 'current_location'。",
      },
      destination: {
        type: Type.STRING,
        description:
          "終點。若用戶說「...到台中高鐵站」，則終點為「台中高鐵站」。",
      },
      travelMode: {
        type: Type.STRING,
        enum: ["TRANSIT", "WALKING"],
        description: "交通方式。預設 'TRANSIT'。",
      },
    },
    required: ["origin", "destination"],
  },
};

export {
  findGooglePlacesDeclaration,
  findA11yPlacesDeclaration,
  planRouteDeclaration,
};

// ─── OpenAI SDK ChatCompletionTool format (for Agent Chat) ────────────────────

export const openAiChatTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "findGooglePlaces",
      description:
        "使用 Google Maps 搜尋地點。可搜尋附近設施或特定地標（如「台北101」），不受距離限制。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜尋關鍵字，例如：'附近的咖啡廳' 或 '台中歌劇院'" },
          latitude: { type: "number", description: "使用者當前緯度（選填）" },
          longitude: { type: "number", description: "使用者當前經度（選填）" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "findA11yPlaces",
      description:
        "查詢無障礙設施資料庫（捷運電梯出口、無障礙廁所、OSM 坡道/導盲磚等）。當使用者提到「無障礙、電梯、坡道、廁所、輪椅」時優先使用。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "地點名稱，例如：'台北車站'、'淡水捷運站'" },
          latitude: { type: "number", description: "搜尋中心緯度（選填）" },
          longitude: { type: "number", description: "搜尋中心經度（選填）" },
          range: { type: "number", description: "搜尋範圍，預設 300，單位公尺" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "planAccessibleRoute",
      description:
        "規劃無障礙混合式交通路線（公車/捷運/步行/高鐵/台鐵），回傳真實路線名稱、轉乘次數、預估時間與無障礙評分。當使用者說「從 A 到 B」、「怎麼去」、「路線規劃」時使用。",
      parameters: {
        type: "object",
        properties: {
          origin: { type: "string", description: "起點名稱，例如：'台北車站'；若說「這裡/目前位置」請填 'current_location'" },
          destination: { type: "string", description: "終點名稱，例如：'台北101'" },
          mode: {
            type: "string",
            enum: ["wheelchair", "elderly", "visual_impaired", "normal"],
            description: "無障礙需求模式，預設 'normal'",
          },
          departureTime: {
            type: "string",
            description: "出發時間，ISO8601 字串或 HH:mm；不指定表示現在",
          },
        },
        required: ["origin", "destination"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getBusArrivalEstimate",
      description: "查詢特定公車路線在指定站點的即時預估到站時間 (ETA)。",
      parameters: {
        type: "object",
        properties: {
          routeName: { type: "string", description: "公車路線名稱，例如：'307'、'紅2'" },
          departureStop: { type: "string", description: "起點/出發站牌名稱" },
          arrivalStop: { type: "string", description: "終點/抵達站牌名稱" },
          latitude: { type: "number", description: "使用者當前緯度（選填）" },
          longitude: { type: "number", description: "使用者當前經度（選填）" },
        },
        required: ["routeName", "departureStop", "arrivalStop"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getBusPosition",
      description: "根據公車車牌號碼與路線名稱，查詢該公車目前的即時 GPS 位置與行駛狀態。",
      parameters: {
        type: "object",
        properties: {
          plateNumber: { type: "string", description: "車牌號碼，例如：'EAL-1234'" },
          routeName: { type: "string", description: "公車路線名稱，例如：'307'" },
          latitude: { type: "number", description: "使用者當前緯度（選填）" },
          longitude: { type: "number", description: "使用者當前經度（選填）" },
        },
        required: ["plateNumber", "routeName"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getAirQuality",
      description: "根據經緯度查詢該地區的即時空氣品質指標 (PM2.5) 與健康防護建議。",
      parameters: {
        type: "object",
        properties: {
          latitude: { type: "number", description: "目標地區之緯度" },
          longitude: { type: "number", description: "目標地區之經度" },
        },
        required: ["latitude", "longitude"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getA11yFacilityDetails",
      description: "根據 OpenStreetMap (OSM) 的 osmId 查詢無障礙設施的完整詳細 Tags 與底層註記資料。",
      parameters: {
        type: "object",
        properties: {
          osmId: {
            type: "string",
            description: "設施的 OSM ID，單個或以逗號分隔的多個，例如：'node/123456'",
          },
        },
        required: ["osmId"],
      },
    },
  },
];
