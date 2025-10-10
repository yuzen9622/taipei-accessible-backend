import { ResponseCode } from "../types/code";
import { Response } from "express";
import type { ApiResponse } from "../types/response";
import { BusRealtimeNearbyStop, BusRoute } from "../types/transit";

export const sendResponse = <T = unknown>(
  res: Response<ApiResponse<T>>,
  ok: boolean,
  status: "success" | "error",
  code: ResponseCode,
  message: string,
  data?: T,
  accessToken?: string,
  refreshToken?: string
) => {
  if (refreshToken) {
    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: false,
      maxAge: 24 * 60 * 60 * 1000 * 7,
    });
  }

  res.status(code).json({
    ok,
    status,
    code,
    message,
    data,
    accessToken,
  });
};
export function getRouteDirectionImproved(
  routeStopsByDirection: { [direction: number]: BusRoute["Stops"] },
  startStopName: string,
  endStopName: string
): number {
  for (const dirStr in routeStopsByDirection) {
    const direction = parseInt(dirStr) as 0 | 1;
    const stops = routeStopsByDirection[direction];

    const startIndex = stops.findIndex(
      (s) =>
        s.StopName.Zh_tw.replace(/\(.*?\)/g, "") ===
        startStopName.replace(/\(.*?\)/g, "")
    );
    const endIndex = stops.findIndex(
      (s) =>
        s.StopName.Zh_tw.replace(/\(.*?\)/g, "") ===
        endStopName.replace(/\(.*?\)/g, "")
    );
    console.log(
      endStopName.replace(/\(.*?\)/g, ""),
      startStopName.replace(/\(.*?\)/g, "")
    );
    if (startIndex !== -1 && endIndex !== -1) {
      return direction; // 0 = 去程, 1 = 回程
    }
  }

  return -1;
}
export function getBusFrontOfArrivalStop(
  stops: BusRoute["Stops"],
  arrivalStopName: string,
  bus: BusRealtimeNearbyStop[]
): BusRealtimeNearbyStop | null {
  // 找到目標站的索引
  const arrivalIndex = stops.findIndex(
    (s) => s.StopName.Zh_tw === arrivalStopName
  );
  if (arrivalIndex === -1) return null;

  // 過濾出還沒到目標站的公車
  const busesInFront = bus.filter((b) => {
    const busIndex = stops.findIndex((s) => s.StopUID === b.StopUID);
    return busIndex !== -1 && busIndex < arrivalIndex;
  });

  if (busesInFront.length === 0) return null;

  // 找到最接近目標站的公車（StopSequence 最大的）
  let closestBus = busesInFront[0];
  let maxStopIndex = stops.findIndex((s) => s.StopUID === closestBus.StopUID);

  for (const b of busesInFront) {
    const idx = stops.findIndex((s) => s.StopUID === b.StopUID);
    if (idx > maxStopIndex) {
      maxStopIndex = idx;
      closestBus = b;
    }
  }

  return closestBus;
}

/**
 * 自動偵測要查詢的公車 API 類型（市區 or 公路）
 * @param fullName 例如 "1619B經中港路不經竹科"、"綠1"、"307"
 * @returns { type: "City" | "InterCity", routeId: string }
 */
export function detectBusApiType(fullName: string): {
  type: "City" | "InterCity";
  routeId: string;
} {
  // 先取出路線主要代號（忽略中文敘述、括號、空白）
  const routeId = fullName.match(/^[A-Z]?\d+[A-Z]?/)?.[0] ?? fullName.trim();

  // 判斷邏輯
  let type: "City" | "InterCity";

  if (/^1\d{3}[A-Z]?$/.test(routeId)) {
    type = "InterCity";
  } else if (/^\d{4,}$/.test(routeId)) {
    type = "InterCity";
  } else if (/[\u4e00-\u9fa5]/.test(routeId)) {
    type = "City";
  } else if (/^\d{1,3}$/.test(routeId)) {
    type = "City";
  } else {
    type = "City";
  }

  return { type, routeId };
}
