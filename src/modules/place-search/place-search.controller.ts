import type { Request, Response } from "express";
import { sendResponse } from "../../config/lib";
import { ApiResponse } from "../../types/response";
import { ResponseCode } from "../../types/code";
import { MSG, ERROR_MESSAGE } from "../../constants/messages";
import * as placeSearchService from "./place-search.service";
import type { AutocompleteItem, PlaceResult } from "./place-search.service";

const PLACE_NOT_FOUND_MSG = "查無此地點";

/** Parses a validated coordinate string into a number, or undefined when absent. */
function toNum(value?: string): number | undefined {
  return value === undefined ? undefined : Number(value);
}

async function autocomplete(req: Request, res: Response<ApiResponse<AutocompleteItem[]>>) {
  try {
    const { q, sessiontoken, lat, lng } = (req.validated?.query ?? {}) as {
      q: string;
      sessiontoken?: string;
      lat?: string;
      lng?: string;
    };
    const data = await placeSearchService.autocomplete({
      q,
      sessionToken: sessiontoken,
      lat: toNum(lat),
      lng: toNum(lng),
    });
    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, data);
  } catch {
    return sendResponse(res, false, "error", ResponseCode.INTERNAL_ERROR, ERROR_MESSAGE.INTERNAL);
  }
}

async function details(req: Request, res: Response<ApiResponse<PlaceResult>>) {
  try {
    const { placeId } = (req.validated?.params ?? {}) as { placeId: string };
    const { sessiontoken, lat, lng } = (req.validated?.query ?? {}) as {
      sessiontoken?: string;
      lat?: string;
      lng?: string;
    };
    const data = await placeSearchService.details({
      placeId,
      sessionToken: sessiontoken,
      lat: toNum(lat),
      lng: toNum(lng),
    });
    if (!data) {
      return sendResponse(res, false, "error", ResponseCode.NOT_FOUND, PLACE_NOT_FOUND_MSG);
    }
    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, data);
  } catch {
    return sendResponse(res, false, "error", ResponseCode.INTERNAL_ERROR, ERROR_MESSAGE.INTERNAL);
  }
}

export { autocomplete, details };
