import type { Request, Response } from "express";
import { getCoordinates, sendResponse } from "../config/lib";
import { getCity } from "../config/map";
import { findAccessibleRoutes } from "../service/accessible-route.service";
import { ApiResponse } from "../types/response";
import { TaiwanCityEn } from "../types/transit";

export async function accessibleRoute(
  req: Request,
  res: Response<ApiResponse<any>>
) {
  const { origin, destination } = req.body;

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

    const routes = await findAccessibleRoutes(
      { lat, lng },
      { lat: destCoords.latitude, lng: destCoords.longitude },
      city
    );

    if (!routes.length) {
      return sendResponse(
        res,
        false,
        "error",
        404,
        "找不到連通的公車路線，請嘗試擴大搜尋範圍或確認出發地/目的地"
      );
    }

    return sendResponse(res, true, "success", 200, "OK", {
      origin: { lat, lng },
      destination: { lat: destCoords.latitude, lng: destCoords.longitude },
      city,
      routes,
    });
  } catch (error: any) {
    console.error("[accessible-route]", error);
    return sendResponse(res, false, "error", 500, error?.message ?? "Internal Server Error");
  }
}
