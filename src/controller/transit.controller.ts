import {
  getBusFrontOfArrivalStop,
  getRouteDirectionImproved,
  sendResponse,
} from "../config/lib";
import { busUrl } from "../config/transit";
import { getCity } from "../config/map";
import { ApiResponse } from "../types/response";
import type { Response, Request } from "express";
import {
  BusRealtimeNearbyStop,
  BusRoute,
  TaiwanCityEn,
} from "../types/transit";

import { tdxFetch } from "../config/fetch";

async function getBusData(req: Request, res: Response<ApiResponse<any>>) {
  try {
    const {
      arrival_stop,
      departure_stop,
      route_name,
      head_sign,
      arrival_lat,
      arrival_lng,
    } = req.body;
    const city = (await getCity(
      Number(arrival_lat),
      Number(arrival_lng)
    )) as TaiwanCityEn;
    console.log(city);
    if (
      !arrival_lat ||
      !arrival_lng ||
      !route_name ||
      !arrival_stop ||
      !departure_stop
    ) {
      return sendResponse(res, false, "error", 400, "缺少必要參數");
    }
    const url = `${busUrl.stopOfRouteUrl}/${city}/${route_name}?$format=JSON&$filter=RouteName/Zh_tw eq '${route_name}'`;

    const busStopInfo = await tdxFetch(url);

    if (!busStopInfo.ok) {
      console.log(await busStopInfo.json(), busStopInfo.status);
      return sendResponse(res, false, "error", 400, "TDX Too Many Requests");
    }

    const busInfoJson = (await busStopInfo.json()) as BusRoute[];

    const direction = getRouteDirectionImproved(
      { 0: busInfoJson[0].Stops, 1: busInfoJson[1].Stops },
      departure_stop as string,
      arrival_stop as string
    );
    console.log("direction", direction);
    const realtimeBusInfo = await tdxFetch(
      `${busUrl.cityEstimatedTimeOfArrivalUrl}/${city}/${route_name}?$format=JSON&$filter=Direction eq ${direction} and StopName/Zh_tw eq '${departure_stop}' and RouteName/Zh_tw eq '${route_name}'`
    );

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
    const { plate_number } = req.query;
  } catch (error) {}
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
export { getBusData, getTrainData, getHighSpeedTrainData };
