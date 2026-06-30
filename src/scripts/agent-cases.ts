/**
 * Labeled cases for the offline tool-routing eval (`eval-tool-routing.ts`).
 * `expectTool` strings MUST match the `openAiChatTools` names in
 * `src/config/ai/tool.ts` (e.g. `planAccessibleRoute`, not the legacy
 * `planRoute`). Cases deliberately stress the known-confusable boundaries.
 */
export interface AgentCase {
  id: string;
  query: string;
  userLocation?: { latitude: number; longitude: number };
  /** Expected tool, or "__none__" to assert NO tool fires (chitchat). */
  expectTool: string;
  mustNotCall?: string[];
  /** Acceptable alternatives for genuinely-ambiguous queries. */
  acceptAlso?: string[];
  /** When true, the memory tools are in the catalogue (logged-in user). */
  loggedIn?: boolean;
  notes?: string;
}

const TAIPEI_STATION = { latitude: 25.0478, longitude: 121.517 };

export const agentCases: AgentCase[] = [
  // A. parking vs findA11yPlaces (the 停車 trap)
  { id: "park-1", query: "台北101附近有沒有身障停車位", expectTool: "findNearbyParking", mustNotCall: ["findA11yPlaces"] },
  { id: "park-2", query: "板橋車站有無障礙廁所嗎", expectTool: "findA11yPlaces", mustNotCall: ["findNearbyParking"] },
  { id: "park-3", query: "我開車去台中歌劇院，哪裡可以停輪椅族的車", expectTool: "findNearbyParking", mustNotCall: ["findA11yPlaces", "findGooglePlaces"] },
  { id: "park-4", query: "附近哪裡有無障礙電梯", userLocation: TAIPEI_STATION, expectTool: "findA11yPlaces", mustNotCall: ["findNearbyParking"] },

  // B. getEnvironmentInfo vs getAirQuality
  { id: "env-1", query: "現在 PM2.5 多少", userLocation: TAIPEI_STATION, expectTool: "getAirQuality", mustNotCall: ["getEnvironmentInfo"] },
  { id: "env-2", query: "等等出門天氣如何", userLocation: TAIPEI_STATION, expectTool: "getEnvironmentInfo", mustNotCall: ["getAirQuality"] },
  { id: "env-3", query: "現在適合出門嗎", userLocation: TAIPEI_STATION, expectTool: "getEnvironmentInfo" },
  { id: "env-4", query: "台北車站附近有監視器可以看路況嗎", expectTool: "getEnvironmentInfo", mustNotCall: ["getNearbyHazards"] },
  { id: "env-5", query: "空氣品質好嗎，我想散步", userLocation: TAIPEI_STATION, expectTool: "getEnvironmentInfo", acceptAlso: ["getAirQuality"], notes: "soft: mentions air but asks about going out" },

  // C. planAccessibleRoute vs getNavInstructions
  { id: "route-1", query: "台中車站到高鐵台中站怎麼走", expectTool: "planAccessibleRoute", mustNotCall: ["getNavInstructions"] },
  { id: "route-2", query: "從台北車站帶我走到台北101，每一步怎麼走", expectTool: "getNavInstructions", mustNotCall: ["planAccessibleRoute"] },
  { id: "route-3", query: "我要從這裡去信義威秀的詳細步驟", userLocation: TAIPEI_STATION, expectTool: "getNavInstructions" },
  { id: "route-4", query: "規劃一條從淡水到北投的無障礙路線", expectTool: "planAccessibleRoute", mustNotCall: ["getNavInstructions", "findGooglePlaces"] },
  { id: "route-5", query: "step by step from Taipei Main Station to Ximen", expectTool: "getNavInstructions" },

  // D. the 5 bus tools
  { id: "bus-route", query: "307 經過哪些站", expectTool: "getBusRoute", mustNotCall: ["getBusRouteDetail", "getBusArrival"] },
  { id: "bus-detail", query: "紅2 的所有站點、到站時間和時刻表都給我", expectTool: "getBusRouteDetail" },
  { id: "bus-arrival", query: "307 在台北車站還有幾分鐘到", expectTool: "getBusArrival", mustNotCall: ["trackBuses", "getBusRoute"] },
  { id: "bus-timetable", query: "672 首末班車幾點", expectTool: "getBusTimetable", mustNotCall: ["getBusRouteDetail"] },
  { id: "bus-track", query: "307 來的這班是低底盤嗎", expectTool: "trackBuses", mustNotCall: ["getBusArrival"] },
  { id: "bus-track-2", query: "下一班紅2是無障礙公車嗎，不要跟我要車牌", expectTool: "trackBuses" },
  { id: "bus-track-3", query: "307 現在在哪", expectTool: "trackBuses", mustNotCall: ["getBusArrival"] },

  // E. searchAccessibilityGuide vs findGooglePlaces / findA11yPlaces
  { id: "guide-1", query: "輪椅怎麼搭公車", expectTool: "searchAccessibilityGuide", mustNotCall: ["getBusRoute", "findGooglePlaces"] },
  { id: "guide-2", query: "身障停車證怎麼申請", expectTool: "searchAccessibilityGuide", mustNotCall: ["findNearbyParking"] },
  { id: "guide-3", query: "捷運有哪些無障礙設施", expectTool: "searchAccessibilityGuide", acceptAlso: ["findA11yPlaces"], notes: "soft: knowledge vs place" },
  { id: "places-1", query: "台北車站附近哪裡有好吃的", expectTool: "findGooglePlaces", mustNotCall: ["findA11yPlaces"] },
  { id: "places-2", query: "附近的咖啡廳", userLocation: TAIPEI_STATION, expectTool: "findGooglePlaces" },

  // F. English
  { id: "en-a11y", query: "Is there an accessible toilet at Taipei Main Station?", expectTool: "findA11yPlaces" },
  { id: "en-air", query: "What's the air quality right now?", userLocation: TAIPEI_STATION, expectTool: "getAirQuality", acceptAlso: ["getEnvironmentInfo"], notes: "soft: English loses the 數值 nuance" },

  // G. saveMemory triggers (logged in)
  { id: "mem-save-1", query: "我住在板橋車站附近，平常都坐輪椅", loggedIn: true, expectTool: "saveMemory" },
  { id: "mem-save-2", query: "我每天搭307上班", loggedIn: true, expectTool: "saveMemory" },

  // H. mixed-intent / no-tool-expected
  { id: "mixed-1", query: "從台北車站到台北101怎麼走，那邊天氣如何", expectTool: "planAccessibleRoute", notes: "model may parallel-call; pass if expected tool present" },
  { id: "chitchat", query: "你好，你可以做什麼", expectTool: "__none__", notes: "must not spuriously route a greeting" },
];
