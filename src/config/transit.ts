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
};
