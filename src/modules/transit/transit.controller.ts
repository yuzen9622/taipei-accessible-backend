import { sendResponse } from "../../config/lib";
import { detectBusApiType } from "../../utils/transit-text";
import { getCity } from "../../adapters/google.adapter";
import { ResponseCode } from "../../types/code";
import { MSG, ERROR_MESSAGE } from "../../constants/messages";
import { ApiResponse } from "../../types/response";
import type { Response, Request } from "express";
import { TaiwanCityEn } from "../../types/transit";
import * as transitService from "./transit.service";

async function getBusData(req: Request, res: Response<ApiResponse<any>>) {
  try {
    const { arrival_stop, departure_stop, route_name, arrival_lat, arrival_lng, language } =
      req.body;

    if (!arrival_lat || !arrival_lng || !route_name || !arrival_stop || !departure_stop) {
      return sendResponse(res, false, "error", ResponseCode.INVALID_INPUT, ERROR_MESSAGE.MISSING_PARAMS);
    }

    const city = (await getCity(Number(arrival_lat), Number(arrival_lng))) as TaiwanCityEn;
    const result = await transitService.getBusEta({
      routeName: route_name as string,
      departureStop: departure_stop as string,
      arrivalStop: arrival_stop as string,
      city,
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
      return sendResponse(res, false, "error", ResponseCode.INVALID_INPUT, "無效的車牌號碼");
    }

    const city = (await getCity(Number(arrival_lat), Number(arrival_lng))) as TaiwanCityEn;
    const result = await transitService.getBusRealtimePosition({
      plateNumber: plate_number,
      routeName: route_name as string,
      city,
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

async function getTrainData(req: Request, res: Response<ApiResponse<null>>) {
  const { arrival_stop, departure_stop, train_no } = req.query;
}
async function getHighSpeedTrainData(req: Request, res: Response<ApiResponse<null>>) {
  const { type, detail } = req.query;
}

export { getBusData, getTrainData, getHighSpeedTrainData, getRealtimeBusPosition };
