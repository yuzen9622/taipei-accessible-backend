import type { Request, Response } from "express";
import { IA11y } from "../../types";
import { sendResponse } from "../../config/lib";
import { ApiResponse } from "../../types/response";
import * as a11yService from "./a11y.service";

async function getA11yData(req: Request, res: Response<ApiResponse<IA11y[]>>) {
  const a11y = await a11yService.findAll();
  return sendResponse(res, true, "success", 200, "OK", a11y);
}

async function getBathroomData(req: Request, res: Response<ApiResponse<any>>) {
  try {
    const bathroom = await a11yService.findAllBathrooms();
    return sendResponse(res, true, "success", 200, "OK", bathroom);
  } catch (error) {
    return sendResponse(res, false, "error", 500, (error as string) || "Internal Server Error");
  }
}

async function getA11yPlace(req: Request, res: Response<ApiResponse<any>>) {
  try {
    const raw = String(req.query.osmId ?? "");
    const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (!ids.length) {
      return sendResponse(res, false, "error", 400, "缺少必要參數：osmId");
    }
    const places = await a11yService.findByOsmIds(ids);
    if (!places.length) {
      return sendResponse(res, false, "error", 404, "查無此設施");
    }
    return sendResponse(res, true, "success", 200, "OK", places);
  } catch (error) {
    return sendResponse(res, false, "error", 500, (error as string) || "Internal Server Error");
  }
}

async function nearbyA11y(req: Request, res: Response<ApiResponse<any>>) {
  try {
    const { lat, lng } = req.query;
    const result = await a11yService.findNearby(Number(lat as string), Number(lng as string));
    return sendResponse(res, true, "success", 200, "OK", result);
  } catch (error) {
    return sendResponse(res, false, "error", 500, (error as string) || "Internal Server Error");
  }
}

export { getA11yData, nearbyA11y, getBathroomData, getA11yPlace };
