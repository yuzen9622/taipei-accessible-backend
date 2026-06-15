import type { Request, Response } from "express";
import { sendResponse } from "../../config/lib";
import { getCity, getCoordinates } from "../../adapters/google.adapter";
import {
  findAccessibleRoutes,
  resolveCityFromStops,
} from "./accessible-route.service";
import { parseRouteIntent, RouteIntent } from "../ai";
import { ApiResponse } from "../../types/response";
import { TaiwanCityEn } from "../../types/transit";
import { ResponseCode } from "../../types/code";
import { MSG, ERROR_MESSAGE } from "../../constants/messages";

export async function accessibleRoute(
  req: Request,
  res: Response<ApiResponse<any>>
) {
  let { origin, destination } = req.body;
  const { query, userLocation, maxTransfers, departureTime, format } = req.body;
  let mode: RouteIntent["mode"] | undefined = req.body.mode;

  // Phase 9 — optional intent switch: a natural-language `query` is parsed into
  // origin/destination (+ mode) when explicit endpoints are not supplied.
  let intent: RouteIntent | null = null;
  if (query && (!origin || !destination)) {
    try {
      intent = await parseRouteIntent(query);
    } catch (err) {
      console.error("[accessible-route] intent parsing failed", err);
      return sendResponse(res, false, "error", ResponseCode.INTERNAL_ERROR, "語意解析服務暫時無法使用，請稍後再試或直接提供 origin/destination");
    }
    if (!intent) {
      return sendResponse(
        res,
        false,
        "error",
        ResponseCode.INVALID_INPUT,
        ERROR_MESSAGE.INTENT_PARSE_FAILED
      );
    }
    origin =
      intent.from === "current_location"
        ? userLocation ?? undefined
        : intent.from;
    destination = intent.to;
    // Explicit body mode wins; otherwise adopt the parsed intent's mode.
    mode = mode ?? intent.mode;
    if (!origin) {
      return sendResponse(
        res,
        false,
        "error",
        ResponseCode.INVALID_INPUT,
        "查詢使用了『目前位置』，請一併提供 userLocation 座標"
      );
    }
  }

  if (!origin || !destination) {
    return sendResponse(res, false, "error", ResponseCode.INVALID_INPUT, `${ERROR_MESSAGE.MISSING_PARAMS}：origin, destination`);
  }

  try {
    // Resolve coordinates for both ends
    const [originCoords, destCoords] = await Promise.all([
      typeof origin === "string"
        ? getCoordinates(origin)
        : Promise.resolve(origin as { latitude: number; longitude: number }),
      typeof destination === "string"
        ? getCoordinates(destination)
        : Promise.resolve(destination as { latitude: number; longitude: number }),
    ]);

    if (!originCoords || !destCoords) {
      return sendResponse(res, false, "error", ResponseCode.INVALID_INPUT, "無法解析出發地或目的地座標");
    }

    const lat = originCoords.latitude;
    const lng = originCoords.longitude;

    // Local stop-based city lookup (~10ms) replaces the per-request Google
    // reverse geocode; Google remains the fallback for stop-less areas.
    const city = ((await resolveCityFromStops(lat, lng)) ??
      (await getCity(lat, lng))) as TaiwanCityEn;

    // Phase 11/12: thread mode + transfer budget + departure time through.
    // A departureTime in the past (stale client state / clock skew) would make
    // every planner return buses that already left — treat it as "now".
    const parsedDeparture = departureTime ? new Date(departureTime) : undefined;
    const futureDeparture =
      parsedDeparture &&
      !isNaN(parsedDeparture.getTime()) &&
      parsedDeparture.getTime() > Date.now()
        ? parsedDeparture
        : undefined;
    const routes = await findAccessibleRoutes(
      { lat, lng },
      { lat: destCoords.latitude, lng: destCoords.longitude },
      city,
      {
        mode: mode ?? "normal",
        maxTransfers: (maxTransfers ?? 1) as 0 | 1 | 2,
        departureTime: futureDeparture,
        // Phase 14: "compact" dedupes facilities into route.facilities.
        format: format === "compact" ? "compact" : "standard",
      }
    );

    if (!routes.length) {
      return sendResponse(
        res,
        false,
        "error",
        ResponseCode.NOT_FOUND,
        "找不到連通的公車或捷運路線，請嘗試擴大搜尋範圍或確認出發地/目的地"
      );
    }

    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, {
      origin: { lat, lng },
      destination: { lat: destCoords.latitude, lng: destCoords.longitude },
      city,
      routes,
      ...(intent ? { intent } : {}),
    });
  } catch (error: any) {
    console.error("[accessible-route]", error);
    return sendResponse(res, false, "error", ResponseCode.INTERNAL_ERROR, error?.message ?? ERROR_MESSAGE.INTERNAL);
  }
}
