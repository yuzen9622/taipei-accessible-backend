import { TaiwanCityEn } from "../types/transit";

export const TDX_API_KEY = process.env.TDX_API_KEY || "";

export const busUrl = {
  cityRouteSearchUrl:
    "https://tdx.transportdata.tw/api/basic/v2/Bus/Route/City",
  stopOfRouteUrl:
    "https://tdx.transportdata.tw/api/basic/v2/Bus/StopOfRoute/City",
  cityRealtimeByFrequencyUrl:
    "https://tdx.transportdata.tw/api/basic/v2/Bus/RealTimeByFrequency/City",
  cityEstimatedTimeOfArrivalUrl:
    "https://tdx.transportdata.tw/api/basic/v2/Bus/EstimatedTimeOfArrival/City",
  cityScheduleUrl:
    "https://tdx.transportdata.tw/api/basic/v2/Bus/Schedule/City",
  interCityStopOfRouteUrl:
    "https://tdx.transportdata.tw/api/basic/v2/Bus/StopOfRoute/InterCity/",
  interCityEstimatedTimeOfArrivalUrl:
    "https://tdx.transportdata.tw/api/basic/v2/Bus/EstimatedTimeOfArrival/Streaming/InterCity",
  interCityRealTimeByFrequencyUrl:
    "https://tdx.transportdata.tw/api/basic/v2/Bus/RealTimeByFrequency/Streaming/InterCity",
};

export const trainUrl = {
  liveBoardUrl: "https://tdx.transportdata.tw/api/basic/v2/Rail/TRA/LiveBoard",
  // v3: realtime position + delay of every currently-running TRA train.
  trainLiveBoardUrl:
    "https://tdx.transportdata.tw/api/basic/v3/Rail/TRA/TrainLiveBoard",
};

const METRO_BASE = "https://tdx.transportdata.tw/api/basic/v2/Rail/Metro";

export const metroUrl = {
  stationUrl:         (s: string) => `${METRO_BASE}/Station/${s}`,
  stationOfLineUrl:   (s: string) => `${METRO_BASE}/StationOfLine/${s}`,
  s2sTravelTimeUrl:   (s: string) => `${METRO_BASE}/S2STravelTime/${s}`,
  frequencyUrl:       (s: string) => `${METRO_BASE}/Frequency/${s}`,
  stationFacilityUrl: (s: string) => `${METRO_BASE}/StationFacility/${s}`,
  alertUrl:           (s: string) => `${METRO_BASE}/Alert/${s}`,
};

export const CITY_METRO_SYSTEMS: Partial<Record<TaiwanCityEn, string[]>> = {
  [TaiwanCityEn.Taipei]:    ["TRTC"],
  [TaiwanCityEn.NewTaipei]: ["NTMC", "KLRT"],
  [TaiwanCityEn.Taoyuan]:   ["TYMC"],
  [TaiwanCityEn.Taichung]:  ["TMRT"],
  [TaiwanCityEn.Kaohsiung]: ["KRTC"],
};

const RAIL_BASE = "https://tdx.transportdata.tw/api/basic/v2/Rail";

export const thsrUrl = {
  stationUrl:          `${RAIL_BASE}/THSR/Station`,
  generalTimetableUrl: `${RAIL_BASE}/THSR/GeneralTimetable`,
  dailyTimetableUrl:   `${RAIL_BASE}/THSR/DailyTrainTimetable/Today`,
  stationFacilityUrl:  `${RAIL_BASE}/THSR/StationFacility`,
};

export const traUrl = {
  stationUrl:          `${RAIL_BASE}/TRA/Station`,
  generalTimetableUrl: `${RAIL_BASE}/TRA/GeneralTimetable`,
  dailyTimetableUrl:   `${RAIL_BASE}/TRA/DailyTrainTimetable/Today`,
  // OD timetable: all trains from→to on a date — used to recover the TrainNo
  // of MaaS-built TRA legs (station names + departure time, no train number).
  dailyTimetableOdUrl: (from: string, to: string, date: string) =>
    `${RAIL_BASE}/TRA/DailyTimetable/OD/${from}/to/${to}/${date}`,
  stationFacilityUrl:  `${RAIL_BASE}/TRA/StationFacility`,
};
