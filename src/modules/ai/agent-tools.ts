import * as a11yService from "../a11y/a11y.service";
import * as transitService from "../transit/transit.service";
import * as airService from "../air/air.service";
import { getCity, getCoordinates, searchPlaces } from "../../adapters/google.adapter";
import { findAccessibleRoutes } from "../accessible-route/accessible-route.service";
import type { AccessibleRoute, WalkLeg, BusLeg, MetroLeg, ThsrLeg, TraLeg } from "../accessible-route/accessible-route.service";
import { TaiwanCityEn } from "../../types/transit";

// ─── Tool 7: findGooglePlaces ─────────────────────────────────────────────────

export async function findGooglePlaces(args: {
  query: string;
  latitude?: number;
  longitude?: number;
}): Promise<string> {
  try {
    const places = await searchPlaces(args.query, { latitude: args.latitude, longitude: args.longitude });
    if (!places.length) return JSON.stringify({ status: "ZERO_RESULTS", places: [] });
    return JSON.stringify({ status: "OK", places });
  } catch (error: any) {
    console.error("[agent-tool:findGooglePlaces]", error.message);
    return JSON.stringify({ error: "Google Places API 查詢失敗" });
  }
}

// ─── Tool 1: findA11yPlaces (upgraded — adds OsmA11y) ────────────────────────

export async function findA11yPlaces(args: {
  query?: string;
  latitude?: number;
  longitude?: number;
  range?: number;
  userLocation?: { latitude: number; longitude: number };
}): Promise<string> {
  let { latitude: searchLat, longitude: searchLng } = args;
  const searchRange = args.range ?? 300;

  if (args.query && (!searchLat || !searchLng)) {
    const coords = await getCoordinates(
      args.query,
      args.userLocation?.latitude,
      args.userLocation?.longitude
    );
    if (!coords) {
      return JSON.stringify({ ok: false, message: `找不到地點「${args.query}」的座標` });
    }
    searchLat = coords.latitude;
    searchLng = coords.longitude;
  }

  if (!searchLat || !searchLng) {
    return JSON.stringify({ ok: false, error: "缺少位置資訊（query 或 lat/lng 必填）" });
  }

  try {
    const places = await a11yService.findNearbyLimited(searchLat, searchLng, searchRange);
    return JSON.stringify({
      ok: true,
      searchLocation: { lat: searchLat, lng: searchLng, query: args.query },
      places,
    });
  } catch (error) {
    console.error("[agent-tool:findA11yPlaces]", error);
    return JSON.stringify({ error: "資料庫查詢失敗" });
  }
}

// ─── Tool 2: planAccessibleRoute (upgraded — calls findAccessibleRoutes) ──────

function summarizeLeg(
  leg: WalkLeg | BusLeg | MetroLeg | ThsrLeg | TraLeg
): Record<string, unknown> {
  if (leg.type === "WALK") {
    return { type: "WALK", from: leg.from, to: leg.to, distanceM: leg.distanceM, minutesEst: leg.minutesEst };
  }
  if (leg.type === "BUS") {
    return {
      type: "BUS",
      routeName: leg.routeName,
      departureStop: leg.departureStop,
      arrivalStop: leg.arrivalStop,
      direction: leg.direction,
      waitMinutes: leg.estimatedWaitMinutes,
      departureTime: leg.departureTime ?? null,
      arrivalTime: leg.arrivalTime ?? null,
    };
  }
  if (leg.type === "METRO") {
    return {
      type: "METRO",
      railSystem: leg.railSystem,
      lineName: leg.lineName,
      departureStation: leg.departureStation,
      arrivalStation: leg.arrivalStation,
      rideMinutes: leg.rideMinutes,
      waitMinutes: leg.estimatedWaitMinutes,
      departureTime: leg.departureTime ?? null,
      arrivalTime: leg.arrivalTime ?? null,
    };
  }
  if (leg.type === "THSR") {
    return {
      type: "THSR",
      trainNo: leg.trainNo,
      departureStation: leg.departureStation,
      arrivalStation: leg.arrivalStation,
      departureTime: leg.departureTime,
      arrivalTime: leg.arrivalTime,
      rideMinutes: leg.rideMinutes,
    };
  }
  if (leg.type === "TRA") {
    return {
      type: "TRA",
      trainNo: leg.trainNo,
      trainTypeName: leg.trainTypeName,
      departureStation: leg.departureStation,
      arrivalStation: leg.arrivalStation,
      departureTime: leg.departureTime,
      arrivalTime: leg.arrivalTime,
      rideMinutes: leg.rideMinutes,
    };
  }
  return { type: (leg as any).type };
}

function summarizeRoute(route: AccessibleRoute): Record<string, unknown> {
  return {
    routeName: route.routeName,
    totalMinutes: route.totalMinutes,
    transferCount: route.transferCount,
    accessibilityScore: route.accessibilityScore ?? null,
    accessibilityLabel: route.accessibilityLabel ?? null,
    departureDate: route.departureDate ?? null,
    accessibilityHighlights: route.accessibilityHighlights ?? [],
    legs: route.legs.map(summarizeLeg),
  };
}

export async function planAccessibleRoute(args: {
  origin: string;
  destination: string;
  mode?: string;
  departureTime?: string;
  userLocation?: { latitude: number; longitude: number };
}): Promise<string> {
  const { origin, destination, mode, departureTime } = args;

  try {
    // Resolve origin coords
    let originCoords: { latitude: number; longitude: number } | null;
    if (origin === "current_location" && args.userLocation) {
      originCoords = args.userLocation;
    } else if (origin === "current_location") {
      return JSON.stringify({ ok: false, error: "需要使用者位置以使用「目前位置」作為起點" });
    } else {
      originCoords = await getCoordinates(origin);
    }

    const destCoords = await getCoordinates(destination);

    if (!originCoords) return JSON.stringify({ ok: false, error: `無法解析起點「${origin}」的座標` });
    if (!destCoords) return JSON.stringify({ ok: false, error: `無法解析終點「${destination}」的座標` });

    const city = (await getCity(originCoords.latitude, originCoords.longitude)) as TaiwanCityEn;

    const parsedDeparture = departureTime ? new Date(departureTime) : undefined;
    const futureDeparture =
      parsedDeparture && !isNaN(parsedDeparture.getTime()) && parsedDeparture.getTime() > Date.now()
        ? parsedDeparture
        : undefined;

    const validMode = ["wheelchair", "elderly", "visual_impaired", "normal"].includes(mode ?? "")
      ? (mode as "wheelchair" | "elderly" | "visual_impaired" | "normal")
      : "normal";

    const routes = await findAccessibleRoutes(
      { lat: originCoords.latitude, lng: originCoords.longitude },
      { lat: destCoords.latitude, lng: destCoords.longitude },
      city,
      { mode: validMode, maxTransfers: 1, departureTime: futureDeparture, format: "standard" }
    );

    if (!routes.length) {
      return JSON.stringify({ ok: false, error: "找不到可用的無障礙路線，請嘗試其他起終點" });
    }

    return JSON.stringify({
      ok: true,
      origin: { name: origin, lat: originCoords.latitude, lng: originCoords.longitude },
      destination: { name: destination, lat: destCoords.latitude, lng: destCoords.longitude },
      city,
      mode: validMode,
      routes: routes.slice(0, 3).map(summarizeRoute),
    });
  } catch (error: any) {
    console.error("[agent-tool:planAccessibleRoute]", error);
    return JSON.stringify({ ok: false, error: error?.message ?? "路線規劃失敗" });
  }
}

// ─── Tool 3: getBusArrivalEstimate ────────────────────────────────────────────

export async function getBusArrivalEstimate(args: {
  routeName: string;
  departureStop: string;
  arrivalStop: string;
  latitude?: number;
  longitude?: number;
}): Promise<string> {
  const { routeName, departureStop, arrivalStop } = args;
  const lat = args.latitude ?? 25.0478;
  const lng = args.longitude ?? 121.517;

  try {
    const city = (await getCity(lat, lng)) as TaiwanCityEn;
    const result = await transitService.getBusEta({ routeName, departureStop, arrivalStop, city });
    if (!result.ok) return JSON.stringify({ ok: false, error: result.error });

    return JSON.stringify({
      ok: true,
      routeName: result.routeId,
      departureStop,
      arrivalStop,
      direction: result.direction,
      city: result.city,
      etaData: Array.isArray(result.etaData) ? result.etaData.slice(0, 5) : result.etaData,
    });
  } catch (error: any) {
    console.error("[agent-tool:getBusArrivalEstimate]", error);
    return JSON.stringify({ ok: false, error: "公車到站查詢失敗" });
  }
}

// ─── Tool 4: getBusPosition ───────────────────────────────────────────────────

export async function getBusPosition(args: {
  plateNumber: string;
  routeName: string;
  latitude?: number;
  longitude?: number;
}): Promise<string> {
  const { plateNumber, routeName } = args;
  const lat = args.latitude ?? 25.0478;
  const lng = args.longitude ?? 121.517;

  if (!/^[\w-]{1,15}$/.test(plateNumber)) {
    return JSON.stringify({ ok: false, error: "無效的車牌號碼格式" });
  }

  try {
    const city = (await getCity(lat, lng)) as TaiwanCityEn;
    const result = await transitService.getBusRealtimePosition({ plateNumber, routeName, city });
    if (!result.ok) return JSON.stringify({ ok: false, error: result.error });

    return JSON.stringify({ ok: true, plateNumber, routeName, city, positionData: result.positionData });
  } catch (error: any) {
    console.error("[agent-tool:getBusPosition]", error);
    return JSON.stringify({ ok: false, error: "公車位置查詢失敗" });
  }
}

// ─── Tool 5: getAirQuality ────────────────────────────────────────────────────

export async function getAirQuality(args: {
  latitude: number;
  longitude: number;
}): Promise<string> {
  try {
    const data = await airService.getAirData(args.latitude, args.longitude);
    if (!data) return JSON.stringify({ ok: false, message: "此區域無空氣品質監測數據" });

    const pm25 = data.readings[0].pm25;
    const { quality, advice } = airService.classifyPm25(pm25);

    return JSON.stringify({
      ok: true,
      city: data.city,
      area: data.readings[0].area,
      pm25,
      quality,
      advice,
      coordinates: data.readings[0].coordinates,
    });
  } catch (error: any) {
    console.error("[agent-tool:getAirQuality]", error);
    return JSON.stringify({ ok: false, error: "空氣品質查詢失敗" });
  }
}

// ─── Tool 6: getA11yFacilityDetails ──────────────────────────────────────────

export async function getA11yFacilityDetails(args: { osmId: string }): Promise<string> {
  try {
    const ids = args.osmId.split(",").map((s) => s.trim()).filter(Boolean);
    if (!ids.length) {
      return JSON.stringify({ ok: false, error: "缺少 osmId 參數" });
    }
    const places = await a11yService.findByOsmIds(ids);
    if (!places.length) {
      return JSON.stringify({ ok: false, error: `找不到 osmId: ${ids.join(", ")} 的設施` });
    }
    return JSON.stringify({ ok: true, count: places.length, facilities: places });
  } catch (error: any) {
    console.error("[agent-tool:getA11yFacilityDetails]", error);
    return JSON.stringify({ ok: false, error: "設施詳情查詢失敗" });
  }
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

export async function executeLocalTool(
  name: string,
  args: Record<string, any>,
  userLocation?: { latitude: number; longitude: number }
): Promise<string> {
  switch (name) {
    case "findGooglePlaces":
      return findGooglePlaces(args as Parameters<typeof findGooglePlaces>[0]);

    case "findA11yPlaces":
      return findA11yPlaces({
        query: args.query,
        latitude: args.latitude,
        longitude: args.longitude,
        range: args.range,
        userLocation,
      });

    case "planAccessibleRoute":
      return planAccessibleRoute({
        origin: args.origin,
        destination: args.destination,
        mode: args.mode,
        departureTime: args.departureTime,
        userLocation,
      });

    case "getBusArrivalEstimate":
      return getBusArrivalEstimate({
        routeName: args.routeName,
        departureStop: args.departureStop,
        arrivalStop: args.arrivalStop,
        latitude: args.latitude ?? userLocation?.latitude,
        longitude: args.longitude ?? userLocation?.longitude,
      });

    case "getBusPosition":
      return getBusPosition({
        plateNumber: args.plateNumber,
        routeName: args.routeName,
        latitude: args.latitude ?? userLocation?.latitude,
        longitude: args.longitude ?? userLocation?.longitude,
      });

    case "getAirQuality":
      return getAirQuality({ latitude: args.latitude, longitude: args.longitude });

    case "getA11yFacilityDetails":
      return getA11yFacilityDetails({ osmId: args.osmId });

    default:
      return JSON.stringify({ error: `未知工具：${name}` });
  }
}
