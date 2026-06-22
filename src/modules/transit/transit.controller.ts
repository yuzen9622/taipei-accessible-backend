import { sendResponse } from "../../config/lib";
import { detectBusApiType } from "../../utils/transit-text";
import { ResponseCode } from "../../types/code";
import { MSG, ERROR_MESSAGE, TRANSIT_MSG } from "../../constants/messages";
import { ApiResponse } from "../../types/response";
import type { Response, Request } from "express";
import { TaiwanCityEn } from "../../types/transit";
import * as transitService from "./transit.service";
import * as busService from "./bus.service";

async function getBusData(req: Request, res: Response<ApiResponse<any>>) {
  try {
    const { arrival_stop, departure_stop, route_name, arrival_lat, arrival_lng, language } =
      req.body;

    if (!arrival_lat || !arrival_lng || !route_name || !arrival_stop || !departure_stop) {
      return sendResponse(res, false, "error", ResponseCode.INVALID_INPUT, ERROR_MESSAGE.MISSING_PARAMS);
    }

    const result = await transitService.getBusEta({
      routeName: route_name as string,
      departureStop: departure_stop as string,
      arrivalStop: arrival_stop as string,
      arrivalLat: Number(arrival_lat),
      arrivalLng: Number(arrival_lng),
      language: language as "Zh_tw" | "En" | undefined,
    });

    if (!result.ok) {
      return sendResponse(res, false, "error", result.status, result.error);
    }

    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, result.etaData);
  } catch (error: any) {
    return sendResponse(res, false, "error", ResponseCode.INTERNAL_ERROR, error.message);
  }
}

async function getRealtimeBusPosition(req: Request, res: Response<ApiResponse<any>>) {
  try {
    const { plate_number, arrival_lat, arrival_lng, route_name } = req.query;

    if (!plate_number || !arrival_lat || !arrival_lng || !route_name) {
      return sendResponse(res, false, "error", ResponseCode.INVALID_INPUT, ERROR_MESSAGE.MISSING_PARAMS);
    }

    if (typeof plate_number !== "string" || !/^[\w-]{1,15}$/.test(plate_number)) {
      return sendResponse(res, false, "error", ResponseCode.INVALID_INPUT, TRANSIT_MSG.INVALID_PLATE);
    }

    const result = await transitService.getBusRealtimePosition({
      plateNumber: plate_number,
      routeName: route_name as string,
      arrivalLat: Number(arrival_lat),
      arrivalLng: Number(arrival_lng),
    });

    if (!result.ok) {
      return sendResponse(res, false, "error", result.status, result.error);
    }

    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, result.positionData);
  } catch (error) {
    console.error("Error fetching realtime bus position:", error);
    return sendResponse(res, false, "error", ResponseCode.INTERNAL_ERROR, ERROR_MESSAGE.INTERNAL);
  }
}

async function resolveCityOr400(
  city: string | undefined,
  res: Response<ApiResponse<any>>,
): Promise<TaiwanCityEn | null> {
  const resolved = await busService.resolveBusCity(city);
  if (!resolved) {
    sendResponse(
      res,
      false,
      "error",
      ResponseCode.INVALID_INPUT,
      TRANSIT_MSG.INVALID_CITY,
    );
    return null;
  }
  return resolved;
}

async function getBusRouteHandler(req: Request, res: Response<ApiResponse<any>>) {
  try {
    const { routeName, city } = req.validated?.query as { routeName: string; city?: string };
    const resolved = await resolveCityOr400(city, res);
    if (!resolved) return;
    const result = await busService.getBusRouteInfo({ routeName, city: resolved });
    if (!result.ok) return sendResponse(res, false, "error", result.status, result.error);
    const { ok, ...data } = result;
    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, data);
  } catch (error: any) {
    return sendResponse(res, false, "error", ResponseCode.INTERNAL_ERROR, error.message);
  }
}

async function getBusArrivalHandler(req: Request, res: Response<ApiResponse<any>>) {
  try {
    const { routeName, stopName, city, direction } = req.validated?.query as {
      routeName: string;
      stopName: string;
      city?: string;
      direction?: number;
    };
    const resolved = await resolveCityOr400(city, res);
    if (!resolved) return;
    const result = await busService.getBusArrivalAtStop({
      routeName,
      stopName,
      city: resolved,
      direction,
    });
    if (!result.ok) return sendResponse(res, false, "error", result.status, result.error);
    const { ok, ...data } = result;
    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, data);
  } catch (error: any) {
    return sendResponse(res, false, "error", ResponseCode.INTERNAL_ERROR, error.message);
  }
}

async function getBusTimetableHandler(req: Request, res: Response<ApiResponse<any>>) {
  try {
    const { routeName, city } = req.validated?.query as { routeName: string; city?: string };
    const resolved = await resolveCityOr400(city, res);
    if (!resolved) return;
    const result = await busService.getBusTimetable({ routeName, city: resolved });
    if (!result.ok) return sendResponse(res, false, "error", result.status, result.error);
    const { ok, ...data } = result;
    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, data);
  } catch (error: any) {
    return sendResponse(res, false, "error", ResponseCode.INTERNAL_ERROR, error.message);
  }
}

async function getBusPositionsHandler(req: Request, res: Response<ApiResponse<any>>) {
  try {
    const { routeName, city, direction } = req.validated?.query as {
      routeName: string;
      city?: string;
      direction?: number;
    };
    const resolved = await resolveCityOr400(city, res);
    if (!resolved) return;
    const result = await busService.getBusRealtimeOnRoute({
      routeName,
      city: resolved,
      direction,
    });
    if (!result.ok) return sendResponse(res, false, "error", result.status, result.error);
    const { ok, ...data } = result;
    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, data);
  } catch (error: any) {
    return sendResponse(res, false, "error", ResponseCode.INTERNAL_ERROR, error.message);
  }
}

async function getTrainData(req: Request, res: Response<ApiResponse<null>>) {
  const { arrival_stop, departure_stop, train_no } = req.query;
}
async function getHighSpeedTrainData(req: Request, res: Response<ApiResponse<null>>) {
  const { type, detail } = req.query;
}

export {
  getBusData,
  getTrainData,
  getHighSpeedTrainData,
  getRealtimeBusPosition,
  getBusRouteHandler,
  getBusArrivalHandler,
  getBusTimetableHandler,
  getBusPositionsHandler,
};
