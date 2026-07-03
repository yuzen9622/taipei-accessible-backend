import type { Request, Response } from "express";
import { sendResponse } from "../../config/lib";
import { ApiResponse } from "../../types/response";
import { ResponseCode } from "../../types/code";
import { MSG, ERROR_MESSAGE } from "../../constants/messages";
import * as a11yService from "./a11y.service";
import type { A11yPlace } from "./a11y.service";

async function getA11yData(req: Request, res: Response<ApiResponse<A11yPlace[]>>) {
  const a11y = await a11yService.findAll();
  return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, a11y);
}

async function getBathroomData(req: Request, res: Response<ApiResponse<any>>) {
  try {
    const bathroom = await a11yService.findAllBathrooms();
    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, bathroom);
  } catch (error) {
    return sendResponse(res, false, "error", ResponseCode.INTERNAL_ERROR, (error as string) || ERROR_MESSAGE.INTERNAL);
  }
}

async function getA11yPlace(req: Request, res: Response<ApiResponse<any>>) {
  try {
    const raw = String(req.query.osmId ?? "");
    const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (!ids.length) {
      return sendResponse(res, false, "error", ResponseCode.INVALID_INPUT, `${ERROR_MESSAGE.MISSING_PARAMS}：osmId`);
    }
    const places = await a11yService.findByOsmIds(ids);
    if (!places.length) {
      return sendResponse(res, false, "error", ResponseCode.NOT_FOUND, "查無此設施");
    }
    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, places);
  } catch (error) {
    return sendResponse(res, false, "error", ResponseCode.INTERNAL_ERROR, (error as string) || ERROR_MESSAGE.INTERNAL);
  }
}

async function nearbyA11y(req: Request, res: Response<ApiResponse<any>>) {
  try {
    const { lat, lng } = req.query;
    const result = await a11yService.findNearby(Number(lat as string), Number(lng as string));
    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, result);
  } catch (error) {
    return sendResponse(res, false, "error", ResponseCode.INTERNAL_ERROR, (error as string) || ERROR_MESSAGE.INTERNAL);
  }
}

async function nearbyParking(req: Request, res: Response<ApiResponse<any>>) {
  try {
    const { lat, lng, radius } = req.query;
    const radiusM = radius != null ? Number(radius as string) : undefined;
    const result = await a11yService.findNearbyParking(
      Number(lat as string),
      Number(lng as string),
      radiusM
    );
    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, result);
  } catch (error) {
    return sendResponse(res, false, "error", ResponseCode.INTERNAL_ERROR, (error as string) || ERROR_MESSAGE.INTERNAL);
  }
}

export { getA11yData, nearbyA11y, nearbyParking, getBathroomData, getA11yPlace };
