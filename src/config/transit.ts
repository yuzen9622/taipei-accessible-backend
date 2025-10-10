export const TDX_API_KEY = process.env.TDX_API_KEY || "";

export const busUrl = {
  stopOfRouteUrl:
    "https://tdx.transportdata.tw/api/basic/v2/Bus/StopOfRoute/City",
  cityRealtimeByFrequencyUrl:
    "https://tdx.transportdata.tw/api/basic/v2/Bus/RealTimeByFrequency/City",
  cityRealtimeNearStopUrl:
    "https://tdx.transportdata.tw/api/basic/v2/Bus/RealTimeNearStop/City",
  cityEstimatedTimeOfArrivalUrl:
    "https://tdx.transportdata.tw/api/basic/v2/Bus/EstimatedTimeOfArrival/City",
  interCityEstimatedTimeOfArrivalUrl:
    "https://tdx.transportdata.tw/api/basic/v2/Bus/EstimatedTimeOfArrival/Streaming/InterCity",
};
