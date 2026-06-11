import type { Request, Response } from "express";
import { getCoordinates, sendResponse } from "../../config/lib";
import { getCity } from "../../config/map";
import { findAccessibleRoutes } from "./accessible-route.service";
import { parseRouteIntent, RouteIntent } from "../ai";
import { ApiResponse } from "../../types/response";
import { TaiwanCityEn } from "../../types/transit";

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
      return sendResponse(res, false, "error", 500, "語意解析服務暫時無法使用，請稍後再試或直接提供 origin/destination");
    }
    if (!intent) {
      return sendResponse(
        res,
        false,
        "error",
        400,
        "無法解析您的查詢，請改用『從 A 到 B』的描述或直接提供 origin/destination"
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
        400,
        "查詢使用了『目前位置』，請一併提供 userLocation 座標"
      );
    }
  }

  if (!origin || !destination) {
    return sendResponse(res, false, "error", 400, "缺少必要參數：origin, destination");
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
      return sendResponse(res, false, "error", 400, "無法解析出發地或目的地座標");
    }

    const lat = originCoords.latitude;
    const lng = originCoords.longitude;

    const city = (await getCity(lat, lng)) as TaiwanCityEn;

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
        404,
        "找不到連通的公車或捷運路線，請嘗試擴大搜尋範圍或確認出發地/目的地"
      );
    }

    return sendResponse(res, true, "success", 200, "OK", {
      origin: { lat, lng },
      destination: { lat: destCoords.latitude, lng: destCoords.longitude },
      city,
      routes,
      ...(intent ? { intent } : {}),
    });
  } catch (error: any) {
    console.error("[accessible-route]", error);
    return sendResponse(res, false, "error", 500, error?.message ?? "Internal Server Error");
  }
}
