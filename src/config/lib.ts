import { ResponseCode } from "../types/code";
import { Response } from "express";
import type { ApiResponse } from "../types/response";
import { BusRealtimeNearbyStop, BusRoute } from "../types/transit";
import axios from "axios";
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
      secure: process.env.SECURE_COOKIE === "true",
      maxAge: 24 * 60 * 60 * 1000 * 7,
      sameSite: process.env.SECURE_COOKIE === "true" ? "none" : "lax",
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
    .replace(/[－–—-]/g, "") // 統一破折號
    .replace("副線", "副")
    .replace(".", "")
    .replace("Rd", "")
    .toLowerCase()
    .trim();
}

function equalStopName(a?: string, b?: string): boolean {
  const na = normalizeStopName(a);
  const nb = normalizeStopName(b);
  console.log("comparing:", na, nb);
  if (!na || !nb) return false;

  // 嚴格相等 + 含括（避免資料來源前後綴差異）
  return na === nb || na.includes(nb) || nb.includes(na);
}

export function getRouteDirectionImproved(
  routeStopsByDirection: { [direction: number]: BusRoute["Stops"] },
  startStopName: string,
  endStopName: string,
  language: "Zh_tw" | "En"
): number {
  for (const dirStr in routeStopsByDirection) {
    const direction = parseInt(dirStr) as 0 | 1;
    const stops = routeStopsByDirection[direction];
    const normStart = normalizeStopName(startStopName);
    const normEnd = normalizeStopName(endStopName);

    const startIndex = stops.findIndex((s) =>
      equalStopName(s?.StopName?.[language], normStart)
    );
    const endIndex = stops.findIndex((s) =>
      equalStopName(s?.StopName?.[language], normEnd)
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

/**
 * 格式化路線名稱，只保留英文字母、數字和特定中文字
 * @param routeName 原始路線名稱 (例如: "307經中港路", "紅50延", "藍1區間車")
 * @returns 格式化後的路線名稱 (例如: "307", "紅50延", "藍1區間")
 */
function formatRouteName(routeName: string): string {
  // 要保留的中文字 (顏色和類型)
  const keepChars = [
    // 顏色
    "紅",
    "藍",
    "綠",
    "黃",
    "橘",
    "橙",
    "棕",
    "粉",
    "灰",
    "白",

    "延",
    "副",
    "區",
    "間",
    "幹",
    "快",
    "直",
    "環",
  ];

  // 先去掉括號內容
  const withoutBrackets = routeName.replace(/[\(（][^）\)]*[\)）]/g, "");

  // 逐字過濾，只保留英文、數字和特定中文字
  return withoutBrackets
    .split("")
    .filter((char) => {
      // 保留英文字母和數字
      if (/[A-Za-z0-9]/.test(char)) return true;

      // 保留指定的中文字符
      if (keepChars.includes(char)) return true;

      // 過濾其他中文字符
      return false;
    })
    .join("");
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
  const formatRouteId = formatRouteName(fullName);
  return { type, routeId: formatRouteId };
}
// 放在您的 controller 或 utility 檔案中
export async function getCoordinates(query: string) {
  if (!process.env.GOOGLE_MAPS_API_KEY) return null;

  // 使用 Text Search API 找地點座標 (比 Geocoding API 對模糊搜尋更友善)
  const url = "https://places.googleapis.com/v1/places:searchText";
  const headers = {
    "Content-Type": "application/json",
    "X-Goog-Api-Key": process.env.GOOGLE_MAPS_API_KEY,
    "X-Goog-FieldMask": "places.location", // 我們只需要座標
  };
  const body = { textQuery: query, maxResultCount: 1 };

  try {
    const response = await axios.post(url, body, { headers });
    if (response.data.places && response.data.places.length > 0) {
      return response.data.places[0].location; // { latitude: 123, longitude: 456 }
    }
    return null;
  } catch (error) {
    console.error("Geocoding error:", error);
    return null;
  }
}
