import { BusRealtimeNearbyStop, BusRoute } from "../types/transit";

/**
 * Pure transit text / route helpers — stop-name normalization, route-name
 * formatting, City-vs-InterCity bus API detection, and direction / front-bus
 * resolution. Shared by the transit and accessible-route modules.
 * (Moved out of config/lib.ts: these are domain utilities, not config.)
 */

export function normalizeStopName(name?: string): string {
  if (!name) return "";
  return name
    .normalize("NFKC")
    .replace(/[\(（][^）\)]*[\)）]/g, "")
    .replace(/站/g, "")
    .replace(/\s+/g, "")
    .replace(/臺/g, "台")
    .replace(/[－–—-]/g, "")
    .replace("副線", "副")
    .replace(".", "")
    .replace("Rd", "")
    .toLowerCase()
    .trim();
}

export function equalStopName(a?: string, b?: string): boolean {
  const na = normalizeStopName(a);
  const nb = normalizeStopName(b);
  if (!na || !nb) return false;

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

    if (startIndex !== -1 && endIndex !== -1) {
      return direction;
    }
  }

  return -1;
}
export function getBusFrontOfArrivalStop(
  stops: BusRoute["Stops"],
  arrivalStopName: string,
  bus: BusRealtimeNearbyStop[]
): BusRealtimeNearbyStop | null {
  const arrivalIndex = stops.findIndex(
    (s) => s.StopName.Zh_tw === arrivalStopName
  );
  if (arrivalIndex === -1) return null;

  const busesInFront = bus.filter((b) => {
    const busIndex = stops.findIndex((s) => s.StopUID === b.StopUID);
    return busIndex !== -1 && busIndex < arrivalIndex;
  });

  if (busesInFront.length === 0) return null;

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
export function formatRouteName(routeName: string): string {
  const keepChars = [
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

  const withoutBrackets = routeName.replace(/[\(（][^）\)]*[\)）]/g, "");

  return withoutBrackets
    .split("")
    .filter((char) => {
      if (/[A-Za-z0-9]/.test(char)) return true;

      if (keepChars.includes(char)) return true;

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
  const routeId = fullName.match(/^[A-Z]?\d+[A-Z]?/)?.[0] ?? fullName.trim();

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
