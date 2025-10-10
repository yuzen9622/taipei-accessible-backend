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
import { get } from "http";
import { tdxFetch } from "../config/fetch";

async function getBusData(req: Request, res: Response<ApiResponse<any>>) {
  const {
    arrival_stop,
    departure_stop,
    routeName,

    arrival_lat,
    arrival_lng,
  } = req.query;
  const city = (await getCity(
    Number(arrival_lat),
    Number(arrival_lng)
  )) as TaiwanCityEn;
  console.log(city);
  if (
    !arrival_lat ||
    !arrival_lng ||
    !routeName ||
    !arrival_stop ||
    !departure_stop
  ) {
    return sendResponse(res, false, "error", 400, "缺少必要參數");
  }
  const url = `${busUrl.stopOfRouteUrl}/${city}/${routeName}?$format=JSON`;

  const busStopInfo = await tdxFetch(url);
  const busInfoJson = (await busStopInfo.json()) as BusRoute[];
  const direction = getRouteDirectionImproved(
    { 0: busInfoJson[0].Stops, 1: busInfoJson[1].Stops },
    departure_stop as string,
    arrival_stop as string
  );
  console.log("direction", direction);
  const realtimeBusInfo = await tdxFetch(
    `${busUrl.cityEstimatedTimeOfArrivalUrl}/${city}/${routeName}?$format=JSON&$filter=Direction eq ${direction}`
  );

  const realtimeClosestBusInfoJson = await realtimeBusInfo.json();

  // const closestBus = getBusFrontOfArrivalStop(
  //   busInfoJson[direction].Stops,
  //   departure_stop as string,
  //   realtimeClosestBusInfoJson
  // );

  return sendResponse(
    res,
    true,
    "success",
    200,
    "OK",
    realtimeClosestBusInfoJson
  );
}

async function getRealtimeBusPosition(
  req: Request,
  res: Response<ApiResponse<any>>
) {}

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
