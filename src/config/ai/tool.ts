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
        "使用 Google Maps 搜尋一般地點、商家或景點。這是 fallback 工具——若上述專用工具（無障礙設施 findA11yPlaces、校園無障礙 findCampusAccessibility、停車位 findNearbyParking、路況 getNearbyHazards、天氣 getEnvironmentInfo）都不適用，才使用此工具。",
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
        "查詢無障礙設施資料庫，回傳捷運電梯出口、無障礙廁所、OSM 坡道/導盲磚等設施的位置。涵蓋一般公共空間的無障礙設施；不含身障停車位（停車位用 findNearbyParking），不含校園內設施（校園用 findCampusAccessibility）。",
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
      name: "findCampusAccessibility",
      description:
        "查詢教育部校園無障礙資料庫，回傳學校/大學/校區內無障礙設施（電梯、廁所、坡道、輪椅通道）的校區摘要與 campusId。可用校名/校區關鍵字（支援簡稱如「中科大」與臺台通用）、城市、設施類型搜尋，或用座標/目前位置找附近校區。要看某校區完整設施清單再用 getCampusAccessibilityDetails。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "校名、校區名或附近地點，例如：'國立臺灣大學'、'台大校總區'、'台北車站附近'" },
          latitude: { type: "number", description: "搜尋中心緯度（選填）" },
          longitude: { type: "number", description: "搜尋中心經度（選填）" },
          radiusM: { type: "number", description: "附近搜尋半徑（公尺），預設 1000，上限由資料庫查詢決定" },
          city: { type: "string", description: "縣市篩選（臺/台通用），例如：'台北市'" },
          type: { type: "string", description: "設施類型代碼（英文 code），例如：'elevator'（無障礙電梯）、'accessible_toilet'（無障礙廁所）、'ramp'（無障礙坡道）、'accessible_parking'（無障礙停車位）" },
          page: { type: "number", description: "列表頁碼，預設 1" },
          limit: { type: "number", description: "回傳筆數，預設 5，最大 20" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getCampusAccessibilityDetails",
      description:
        "依 findCampusAccessibility 回傳的 campusId，回傳單一校區的完整無障礙設施摘要與設施清單（含各無障礙電梯/廁所/坡道）。",
      parameters: {
        type: "object",
        properties: {
          campusId: { type: "number", description: "校區 campusId，來自 findCampusAccessibility 的結果" },
          type: { type: "string", description: "選填，僅列出特定設施類型代碼，例如：'elevator'、'accessible_toilet'" },
          limit: { type: "number", description: "設施清單最多回傳筆數，預設 30，最大 80" },
        },
        required: ["campusId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "planAccessibleRoute",
      description:
        "規劃無障礙混合式交通路線（公車/捷運/步行/高鐵/台鐵），回傳路線**摘要**：候選路線、包含哪些公車/捷運班次、轉乘次數、預估時間、無障礙評分。用於「怎麼去/有哪些走法」的整段路線建議；也可作為「兩地間有哪些公車」的候選路線來源（之後再用公車工具查各線到站時間）。要逐步指引（每一步怎麼走）用 getNavInstructions。",
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
        "回傳某條公車路線的行駛方向與完整站序（去程/返程的起訖站與停靠站列表）。",
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
      name: "getBusRouteDetail",
      description:
        "一次回傳某條公車路線的所有站點、各站預估到站時間（ETA）與當前班次時刻表（像公車 App 的完整路線動態：站點＋幾分鐘來＋時刻表）。",
      parameters: {
        type: "object",
        properties: {
          routeName: { type: "string", description: "公車路線名稱，例如：'307'、'紅2'" },
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
      name: "getBusArrival",
      description:
        "回傳某條公車路線在某個站牌的即時預估到站時間（還有幾分鐘到）。若已知該班車車牌，會一併回報是否為低底盤車。適合比較多條路線在同一站誰先到。",
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
        "回傳某條公車路線的時刻表：首班車/末班車時間與今日各班次發車時刻。",
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
        "回傳某條公車路線目前所有在線車輛的即時 GPS 位置、行駛狀態，以及每台車是否為低底盤/有無升降斜坡板。**不需要、也不要向使用者索取車牌號碼**，會自動取得在線車輛。",
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
      name: "findNearbyBusStops",
      description:
        "回傳使用者附近的公車站牌：每個站牌的名稱、距離、以及經過該站的真實公車路線清單。先用它拿到附近站牌與真實路線，再用 getBusArrival 查特定路線到站時間。**不要自己猜路線號碼**。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "地點名稱（選填）；不填則用使用者目前位置" },
          latitude: { type: "number", description: "搜尋中心緯度（選填）" },
          longitude: { type: "number", description: "搜尋中心經度（選填）" },
          radius: { type: "number", description: "搜尋半徑（公尺），預設 500" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getAirQuality",
      description: "僅查詢 PM2.5 數值與分級。若使用者同時問天氣、出門建議或 CCTV，請改用 getEnvironmentInfo（含天氣+空品+CCTV 三合一）。",
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
  {
    type: "function",
    function: {
      name: "getEnvironmentInfo",
      description:
        "回傳指定地點的即時出行環境資訊：天氣（溫度、降雨、風速）、空氣品質（PM2.5 與健康建議）與附近路況監視器畫面（三合一）。支援地名或經緯度查詢。只問 PM2.5 數值用 getAirQuality。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "地點名稱，例如：'台北車站'、'台中公園'。與 latitude/longitude 二擇一。" },
          latitude: { type: "number", description: "查詢中心緯度（選填）" },
          longitude: { type: "number", description: "查詢中心經度（選填）" },
          radius: { type: "number", description: "CCTV 搜尋範圍（公尺），預設 1000" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getNearbyHazards",
      description:
        "回傳指定地點附近的即時路況危險回報（施工 construction、路面障礙物 obstacle、資料錯誤 data_error）。也可在規劃路線後查詢起終點附近的危險資訊。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "地點名稱，例如：'台北車站'。與 latitude/longitude 二擇一。" },
          latitude: { type: "number", description: "查詢中心緯度（選填）" },
          longitude: { type: "number", description: "查詢中心經度（選填）" },
          radiusM: { type: "number", description: "搜尋範圍（公尺），預設 500，最大 5000" },
          hazardType: {
            type: "string",
            enum: ["obstacle", "construction", "data_error"],
            description: "篩選特定危險類型（選填）",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "findNearbyParking",
      description:
        "回傳指定地點附近的身障停車位（身心障礙者專用停車格）。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "地點名稱，例如：'台北101'、'板橋車站'。與 latitude/longitude 二擇一。" },
          latitude: { type: "number", description: "搜尋中心緯度（選填）" },
          longitude: { type: "number", description: "搜尋中心經度（選填）" },
          radiusM: { type: "number", description: "搜尋範圍（公尺），預設 500" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getNavInstructions",
      description:
        "回傳從起點到終點的**逐步**導航指引（「沿中山路直行 120 公尺」「請向右轉」「請在台北車站搭乘板南線」）。用於要「詳細步驟/每一步怎麼走/帶我走」時；不需先呼叫 planAccessibleRoute。與 planAccessibleRoute 差別＝逐步 vs 摘要。",
      parameters: {
        type: "object",
        properties: {
          origin: { type: "string", description: "起點名稱，請完整照抄使用者說的地名；若說「這裡/目前位置」請填 'current_location'" },
          destination: { type: "string", description: "終點名稱，請完整照抄使用者說的地名" },
          mode: {
            type: "string",
            enum: ["wheelchair", "elderly", "visual_impaired", "normal"],
            description: "無障礙需求模式，預設 'normal'",
          },
          departureTime: { type: "string", description: "出發時間，ISO8601 或 HH:mm；不指定表示現在" },
          routeIndex: { type: "number", description: "選擇第幾條路線（0-based），預設 0（最佳路線）" },
          userHeading: { type: "number", description: "使用者當前朝向（度，正北=0，順時針），有此值時會產生相對方向（左前方/右側等）" },
        },
        required: ["origin", "destination"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "searchAccessibilityGuide",
      description:
        "從策展的無障礙知識庫搜尋並回傳一般知識（車站無障礙指南、輪椅搭乘 SOP、身障福利法規、交通營運商政策）。適合不需即時位置或交通資料的知識性問題；比模型內建知識更準確。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜尋關鍵字或問題" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "webSearch",
      description:
        "搜尋公開網路並回傳最新資訊與來源（answer 與 sources）。適合最新消息、近期政策、當前狀態、或本地工具與知識庫都無法回答的一般網路問題。回答必須根據回傳的 answer 與 sources 並附上來源。",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "要搜尋的完整問題或關鍵字，保留使用者原本語言與重要地名/日期。",
          },
        },
        required: ["query"],
      },
    },
  },
];

export const memoryTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "saveMemory",
      description:
        "儲存一筆關於使用者的記憶。只有在使用者明確要求「記住」或使用者已開啟記憶功能且該資訊對未來無障礙導航有穩定幫助時使用。只存最小化摘要，不要存完整原話、精準住址、精準座標或不必要的個資。",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "用自然語言描述要記住的最小化事實，例如：「使用者偏好輪椅友善路線」「常從板橋車站附近出發」「常搭307公車通勤」",
          },
          category: {
            type: "string",
            enum: ["preference", "place", "habit", "context"],
            description: "preference=行動模式/偏好, place=地點, habit=交通習慣, context=近期計畫",
          },
        },
        required: ["content", "category"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "deleteMemory",
      description:
        "刪除一筆使用者記憶（用於使用者要求忘記/移除某筆記憶時）。memoryId 從【使用者記憶】區塊中取得。",
      parameters: {
        type: "object",
        properties: {
          memoryId: { type: "string", description: "要刪除的記憶 ID" },
        },
        required: ["memoryId"],
      },
    },
  },
];

export const lineFamilyTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "bindEmergencyContactCode",
      description:
        "把使用者輸入的 6 碼綁定碼套用到目前這個 LINE 使用者，完成緊急聯絡人綁定。這是緊急聯絡人綁定流程，與 app 帳號綁定不同；若不是 6 碼或找不到對應資料，回傳失敗原因。",
      parameters: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "6 碼英數大寫綁定碼；可接受小寫，工具會自行正規化。",
          },
        },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bindLineAccountCode",
      description:
        "把使用者輸入的 6 碼帳號綁定碼套用到目前這個 LINE 使用者，完成 app 帳號與 LINE 的對應。這個工具只處理 app 帳號綁定，不處理緊急聯絡人綁定。",
      parameters: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "6 碼英數大寫綁定碼；可接受小寫，工具會自行正規化。",
          },
        },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getActiveSosContext",
      description:
        "查目前這個 LINE 使用者所綁定的所有聯絡人對應的 SOS 狀態，回傳進行中的求救清單與最近一筆求救摘要。使用者問『他現在在哪』『目前狀況如何』『有沒有在求救』時先用這個工具。",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getSosLiveLocation",
      description:
        "回傳指定 SOS session 的即時位置、地址、更新時間與 Google Maps 連結。先用 getActiveSosContext 找到 sessionId，再用這個工具查細節。",
      parameters: {
        type: "object",
        properties: {
          sessionId: {
            type: "string",
            description: "SOS session ID，來自 getActiveSosContext 的結果",
          },
        },
        required: ["sessionId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "findSosNearbyPlaces",
      description:
        "以指定 SOS session 的受困者位置為中心，搜尋附近一般地點（例如醫院、警局、超商）。不要拿家人的位置當中心。",
      parameters: {
        type: "object",
        properties: {
          sessionId: {
            type: "string",
            description: "SOS session ID，來自 getActiveSosContext 的結果",
          },
          query: {
            type: "string",
            description: "搜尋關鍵字，例如：『醫院』『警局』『超商』",
          },
          maxResults: {
            type: "number",
            description: "回傳筆數上限，預設 3",
          },
        },
        required: ["sessionId", "query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "findSosNearbyA11yPlaces",
      description:
        "以指定 SOS session 的受困者位置為中心，搜尋附近無障礙設施（電梯、無障礙廁所、坡道等）。不要拿家人的位置當中心。",
      parameters: {
        type: "object",
        properties: {
          sessionId: {
            type: "string",
            description: "SOS session ID，來自 getActiveSosContext 的結果",
          },
          query: {
            type: "string",
            description: "地點名稱，例如：『台北車站』『附近捷運站』",
          },
          range: {
            type: "number",
            description: "搜尋範圍（公尺），預設 300",
          },
        },
        required: ["sessionId", "query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getSosEnvironmentInfo",
      description:
        "以指定 SOS session 的受困者位置為中心，回傳天氣、空品與周邊環境資訊。使用者問『那邊天氣怎樣』『附近環境如何』時用這個工具。",
      parameters: {
        type: "object",
        properties: {
          sessionId: {
            type: "string",
            description: "SOS session ID，來自 getActiveSosContext 的結果",
          },
          radius: {
            type: "number",
            description: "查詢半徑（公尺），預設 1000",
          },
        },
        required: ["sessionId"],
      },
    },
  },
];
