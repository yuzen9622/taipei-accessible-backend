import {
  detectBusApiType,
  getBusFrontOfArrivalStop,
  getRouteDirectionImproved,
  sendResponse,
} from "../config/lib";
import { busUrl } from "../config/transit";
import { getCity } from "../config/map";
import { ApiResponse } from "../types/response";
import type { Response, Request } from "express";
import { BusRoute, TaiwanCityEn } from "../types/transit";

import { tdxFetch } from "../config/fetch";

async function getBusData(req: Request, res: Response<ApiResponse<any>>) {
  try {
    const {
      arrival_stop,
      departure_stop,
      route_name,
      arrival_lat,
      arrival_lng,
    } = req.body;

    if (
      !arrival_lat ||
      !arrival_lng ||
      !route_name ||
      !arrival_stop ||
      !departure_stop
    ) {
      return sendResponse(res, false, "error", 400, "缺少必要參數");
    }
    const city = (await getCity(
      Number(arrival_lat),
      Number(arrival_lng)
    )) as TaiwanCityEn;
    console.log(city);
    const formatRouteName = detectBusApiType(route_name as string);
    console.log(formatRouteName);
    const url =
      formatRouteName.type === "City"
        ? `${busUrl.stopOfRouteUrl}/${city}?$format=JSON&$filter=RouteName/Zh_tw eq '${formatRouteName.routeId}'`
        : `${busUrl.interCityStopOfRouteUrl}?$format=JSON&$filter=SubRouteName/Zh_tw eq '${formatRouteName.routeId}'`;
    const busStopInfo = await tdxFetch(url);

    const busInfoJson = (await busStopInfo.json()) as BusRoute[];
    if (!busStopInfo.ok) {
      console.error("TDX fetch error:", busStopInfo.status, busInfoJson);
      return sendResponse(res, false, "error", 400, "TDX Error");
    }
    console.log(busInfoJson);
    const direction = getRouteDirectionImproved(
      { 0: busInfoJson[0].Stops, 1: busInfoJson[1].Stops },
      departure_stop as string,
      arrival_stop as string
    );
    console.log("direction", direction);
    const estimatedTimeArrivalUrl =
      formatRouteName.type === "City"
        ? `${busUrl.cityEstimatedTimeOfArrivalUrl}/${city}/${formatRouteName.routeId}?$format=JSON&$filter=Direction eq ${direction} and StopName/Zh_tw eq '${departure_stop}' and RouteName/Zh_tw eq '${formatRouteName.routeId}'`
        : `${busUrl.interCityEstimatedTimeOfArrivalUrl}/${formatRouteName.routeId}?$format=JSON&$filter=Direction eq ${direction} and StopName/Zh_tw eq '${departure_stop}' and RouteName/Zh_tw eq '${formatRouteName.routeId}'`;
    const realtimeBusInfo = await tdxFetch(estimatedTimeArrivalUrl);

    const realtimeClosestBusInfoJson = (await realtimeBusInfo.json()) as any;
    if (realtimeClosestBusInfoJson.message) {
      return sendResponse(
        res,
        false,
        "error",
        500,
        realtimeClosestBusInfoJson.message
      );
    }

    return sendResponse(
      res,
      true,
      "success",
      200,
      "OK",
      realtimeClosestBusInfoJson
    );
  } catch (error: any) {
    return sendResponse(res, false, "error", 500, error.message);
  }
}

async function getMetroData(req: Request, res: Response<ApiResponse<any>>) {}

async function getRealtimeBusPosition(
  req: Request,
  res: Response<ApiResponse<any>>
) {
  try {
    const { plate_number, arrival_lat, arrival_lng, route_name } = req.query;
    const city = (await getCity(
      Number(arrival_lat),
      Number(arrival_lng)
    )) as TaiwanCityEn;
    const formatRouteName = detectBusApiType(route_name as string);
    const url =
      formatRouteName.type === "City"
        ? `${busUrl.cityRealtimeByFrequencyUrl}/${city}?$format=JSON&$filter=PlateNumb eq '${plate_number}'`
        : `${busUrl.interCityRealTimeByFrequencyUrl}?$format=JSON&$filter=PlateNumb eq '${plate_number}'`;
    const busStopInfo = await tdxFetch(url);
    const busInfoJson = await busStopInfo.json();
    console.log(busInfoJson);
    return sendResponse(res, true, "success", 200, "OK", busInfoJson);
  } catch (error) {
    return sendResponse(res, false, "error", 500, "Internal Server Error");
  }
}

async function getTrainData(req: Request, res: Response<ApiResponse<null>>) {
  const { arrival_stop, departure_stop, routeName } = req.query;
}
async function getHighSpeedTrainData(
  req: Request,
  res: Response<ApiResponse<null>>
) {
  const { type, detail } = req.query;
}
export {
  getBusData,
  getTrainData,
  getHighSpeedTrainData,
  getRealtimeBusPosition,
};
