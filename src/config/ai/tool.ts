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
    },
    required: ["query"],
  },
};
const findA11yPlacesDeclaration: FunctionDeclaration = {
  name: "findA11yPlaces",
  description:
    "查詢無障礙設施的專用資料庫。當用戶提到「無障礙」、「電梯」、「坡道」等關鍵字時，**務必優先**使用此工具。此工具可以接受經緯度，**也可以直接接受地點名稱**。",
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: {
        type: Type.STRING,
        description: "地點名稱，例如：'台北車站'、'淡水捷運站'。",
      },
      latitude: { type: Type.NUMBER, description: "如果有經緯度則填入" },
      longitude: { type: Type.NUMBER, description: "如果有經緯度則填入" },
      range: { type: Type.NUMBER, description: "搜尋範圍，預設200，單位公尺" },
    },
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
          origin: { type: "string", description: "起點名稱，請『完整照抄』使用者說的地名（含校區/分館/分店/路段等後綴，例如『台中科大三民校區』不可簡化成『台中科大』）；若說「這裡/目前位置」請填 'current_location'" },
          destination: { type: "string", description: "終點名稱，請『完整照抄』使用者說的地名（含校區/分館/分店/路段等後綴，例如『台中科大三民校區』不可簡化成『台中科大』）" },
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
      name: "getBusRoute",
      description:
        "查詢公車路線的行駛方向與完整站序（去程/返程的起訖站與停靠站列表）。當使用者問「X 路經過哪些站」、「X 路怎麼走」、「X 路的路線」時使用。",
      parameters: {
        type: "object",
        properties: {
          routeName: { type: "string", description: "公車路線名稱，例如：'307'、'紅2'、'672'" },
          city: {
            type: "string",
            description: "公車所在縣市，例如：'台北'、'新北'、'台中'、'高雄'。未提供時會用使用者位置推斷。",
          },
        },
        required: ["routeName"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getBusArrival",
      description:
        "查詢某條公車路線在某個站牌的即時預估到站時間（還有幾分鐘到）。當使用者問「X 路在 Y 站還有多久」、「X 路到 Y 站的時間」時使用。若已知該班車車牌，會一併回報是否為低底盤車。",
      parameters: {
        type: "object",
        properties: {
          routeName: { type: "string", description: "公車路線名稱，例如：'307'、'紅2'" },
          stopName: { type: "string", description: "要查詢到站時間的站牌名稱，例如：'台北車站'" },
          city: {
            type: "string",
            description: "公車所在縣市，例如：'台北'。未提供時會用使用者位置推斷。",
          },
          direction: {
            type: "number",
            description: "行駛方向（0=去程，1=返程）。不確定可省略。",
          },
        },
        required: ["routeName", "stopName"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getBusTimetable",
      description:
        "查詢公車路線的時刻表：首班車/末班車時間與今日各班次發車時刻。當使用者問「X 路的時刻表」、「X 路首末班車幾點」時使用。",
      parameters: {
        type: "object",
        properties: {
          routeName: { type: "string", description: "公車路線名稱，例如：'307'" },
          city: {
            type: "string",
            description: "公車所在縣市，例如：'台北'。未提供時會用使用者位置推斷。",
          },
        },
        required: ["routeName"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "trackBuses",
      description:
        "查詢某條公車路線目前所有在線車輛的即時 GPS 位置、行駛狀態，以及『每台車是否為低底盤/有無升降斜坡板』。當使用者問「X 路現在在哪」、「X 路來的這班是低底盤嗎」、「下一班 X 路是無障礙車嗎」時使用。**不需要、也不要向使用者索取車牌號碼**，本工具會自動取得在線車輛。",
      parameters: {
        type: "object",
        properties: {
          routeName: { type: "string", description: "公車路線名稱，例如：'307'、'紅2'" },
          city: {
            type: "string",
            description: "公車所在縣市，例如：'台北'。未提供時會用使用者位置推斷。",
          },
          direction: {
            type: "number",
            description: "行駛方向（0=去程，1=返程）。不確定可省略。",
          },
        },
        required: ["routeName"],
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
