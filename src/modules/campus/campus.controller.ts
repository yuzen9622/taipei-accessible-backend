import type { Request, Response } from "express";
import { sendResponse } from "../../config/lib";
import { ResponseCode } from "../../types/code";
import { MSG, ERROR_MESSAGE, CAMPUS_MSG } from "../../constants/messages";
import * as service from "./campus.service";

/** GET /a11y/campus/nearby — campus summaries within radius of the coordinate. */
export async function nearbyCampus(req: Request, res: Response) {
  try {
    const { lat, lng, radius, facType } = req.validated?.query as {
      lat: number;
      lng: number;
      radius: number;
      facType?: string;
    };
    const result = await service.findNearby(lat, lng, radius, facType);
    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, result);
  } catch (error) {
    console.error(error);
    return sendResponse(res, false, "error", ResponseCode.INTERNAL_ERROR, ERROR_MESSAGE.INTERNAL);
  }
}

/** GET /a11y/campus — paginated campus directory, optionally filtered. */
export async function listCampus(req: Request, res: Response) {
  try {
    const { city, facType, keyword, page, limit } = req.validated?.query as {
      city?: string;
      facType?: string;
      keyword?: string;
      page: number;
      limit: number;
    };
    const result = await service.findAll({ city, facType, keyword, page, limit });
    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, result);
  } catch (error) {
    console.error(error);
    return sendResponse(res, false, "error", ResponseCode.INTERNAL_ERROR, ERROR_MESSAGE.INTERNAL);
  }
}

/** GET /a11y/campus/:branchId — single campus detail with full facilities. */
export async function getCampusByBranchId(req: Request, res: Response) {
  try {
    const { branchId } = req.validated?.params as { branchId: number };
    const result = await service.findByBranchId(branchId);
    if (!result) {
      return sendResponse(res, false, "error", ResponseCode.NOT_FOUND, CAMPUS_MSG.NOT_FOUND);
    }
    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, result);
  } catch (error) {
    console.error(error);
    return sendResponse(res, false, "error", ResponseCode.INTERNAL_ERROR, ERROR_MESSAGE.INTERNAL);
  }
}
