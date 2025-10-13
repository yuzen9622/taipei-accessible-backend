import { ResponseCode } from "../types/code";
import { Response } from "express";
import type { ApiResponse } from "../types/response";
import { BusRealtimeNearbyStop, BusRoute } from "../types/transit";
import route from "../routes/user.route";

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

function normalizeStopName(name?: string): string {
  if (!name) return "";
  return name
    .normalize("NFKC") // 全半形統一
    .replace(/[\(（][^）\)]*[\)）]/g, "") // 移除 () 與 （）中的內容
    .replace(/站/g, "") // 可選：移除「站」字
    .replace(/\s+/g, "") // 移除所有空白
    .replace(/臺/g, "台") // 統一臺/台
    .replace(/[－–—]/g, "-") // 統一破折號
    .replace("副線", "副")
    .toLowerCase()
    .trim();
}

function equalStopName(a?: string, b?: string): boolean {
  const na = normalizeStopName(a);
  const nb = normalizeStopName(b);
  if (!na || !nb) return false;
  // 嚴格相等 + 含括（避免資料來源前後綴差異）
  return na === nb || na.includes(nb) || nb.includes(na);
}

export function getRouteDirectionImproved(
  routeStopsByDirection: { [direction: number]: BusRoute["Stops"] },
  startStopName: string,
  endStopName: string
): number {
  for (const dirStr in routeStopsByDirection) {
    const direction = parseInt(dirStr) as 0 | 1;
    const stops = routeStopsByDirection[direction];
    const normStart = normalizeStopName(startStopName);
    const normEnd = normalizeStopName(endStopName);

    const startIndex = stops.findIndex((s) =>
      equalStopName(s?.StopName?.Zh_tw, normStart)
    );
    const endIndex = stops.findIndex((s) =>
      equalStopName(s?.StopName?.Zh_tw, normEnd)
    );

    console.log(startIndex, endIndex, normStart, normEnd);

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

function formatRouteName(routeName: string): string {
  return (
    routeName
      .replace(/[\(（][^）\)]*[\)）]/g, "") // 去掉括號內容
      .match(/[A-Za-z0-9\u4e00-\u9fa5]+(?:延)?/)?.[0] || ""
  );
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
  const formatRouteId = formatRouteName(routeId);
  return { type, routeId: formatRouteId };
}
