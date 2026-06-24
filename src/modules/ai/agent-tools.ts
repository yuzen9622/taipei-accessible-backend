import * as a11yService from "../a11y/a11y.service";
import * as busService from "../transit/bus.service";
import * as airService from "../air/air.service";
import * as hazardService from "../hazard-report/hazard-report.service";
import { getEnvironmentInfo as fetchEnvironment } from "../environment/environment.service";
import { getCoordinates, searchPlaces } from "../../adapters/google.adapter";
import { planAccessibleRouteFromRequest } from "../accessible-route/accessible-route.service";
import { generateNavInstructions } from "../nav-instructions/nav-instructions.service";
import type {
  AccessibleRoute,
  WalkLeg,
  BusLeg,
  MetroLeg,
  ThsrLeg,
  TraLeg,
} from "../accessible-route/accessible-route.service";
import type { TaiwanCityEn } from "../../types/transit";

export async function findGooglePlaces(args: {
  query: string;
  latitude?: number;
  longitude?: number;
}): Promise<string> {
  try {
    const places = await searchPlaces(args.query, {
      latitude: args.latitude,
      longitude: args.longitude,
    });
    if (!places.length)
      return JSON.stringify({ status: "ZERO_RESULTS", places: [] });
    return JSON.stringify({ status: "OK", places });
  } catch (error: any) {
    console.error("[agent-tool:findGooglePlaces]", error.message);
    return JSON.stringify({ error: "Google Places API 查詢失敗" });
  }
}

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
      args.userLocation?.longitude,
    );
    if (!coords) {
      return JSON.stringify({
        ok: false,
        message: `找不到地點「${args.query}」的座標`,
      });
    }
    searchLat = coords.latitude;
    searchLng = coords.longitude;
  }

  if (!searchLat || !searchLng) {
    return JSON.stringify({
      ok: false,
      error: "缺少位置資訊（query 或 lat/lng 必填）",
    });
  }

  try {
    const places = await a11yService.findNearbyLimited(
      searchLat,
      searchLng,
      searchRange,
    );
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

function summarizeLeg(
  leg: WalkLeg | BusLeg | MetroLeg | ThsrLeg | TraLeg,
): Record<string, unknown> {
  if (leg.type === "WALK") {
    return {
      type: "WALK",
      from: leg.from,
      to: leg.to,
      distanceM: leg.distanceM,
      minutesEst: leg.minutesEst,
    };
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
      lineId: leg.lineId,
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
    const validMode = [
      "wheelchair",
      "elderly",
      "visual_impaired",
      "normal",
    ].includes(mode ?? "")
      ? (mode as "wheelchair" | "elderly" | "visual_impaired" | "normal")
      : "normal";

    // "current_location" only resolves via the caller-injected GPS fix; every
    // other origin and the destination are passed through verbatim so the SHARED
    // planner geocodes them — identical to POST /a11y/accessible-route. This keeps
    // the agent and the HTTP endpoint from ever drifting on geocoding, city
    // resolution or the transfer limit again. maxTransfers is 2 because realistic
    // cross-city trips (e.g. 雙鐵/高鐵接駁) routinely need two transfers.
    if (origin === "current_location" && !args.userLocation) {
      return JSON.stringify({
        ok: false,
        error: "需要使用者位置以使用「目前位置」作為起點",
      });
    }
    const originInput =
      origin === "current_location" ? args.userLocation : origin;

    const result = await planAccessibleRouteFromRequest({
      origin: originInput,
      destination,
      userLocation: args.userLocation,
      mode: validMode,
      maxTransfers: 2,
      departureTime,
    });

    if (!result.ok) {
      return JSON.stringify({ ok: false, error: result.error });
    }

    return JSON.stringify({
      ok: true,
      origin: {
        name: origin === "current_location" ? "目前位置" : origin,
        lat: result.data.origin.lat,
        lng: result.data.origin.lng,
      },
      destination: {
        name: destination,
        lat: result.data.destination.lat,
        lng: result.data.destination.lng,
      },
      city: result.data.city,
      mode: validMode,
      routes: result.data.routes.slice(0, 3).map(summarizeRoute),
    });
  } catch (error: any) {
    console.error("[agent-tool:planAccessibleRoute]", error);
    return JSON.stringify({
      ok: false,
      error: error?.message ?? "路線規劃失敗",
    });
  }
}

/**
 * Resolve the city for a bus tool from an explicit `city` arg, falling back to
 * the user's GPS fix. Returns the resolved code or a ready-to-return error
 * string when neither is usable.
 */
async function resolveBusCityOrError(
  city: string | undefined,
  userLocation?: { latitude: number; longitude: number },
): Promise<TaiwanCityEn | { error: string }> {
  const resolved = await busService.resolveBusCity(city, userLocation);
  if (!resolved) {
    return {
      error: "無法判斷縣市，請告訴我公車所在的縣市（例如「台北」「台中」）",
    };
  }
  return resolved;
}

export async function getBusRoute(args: {
  routeName: string;
  city?: string;
  userLocation?: { latitude: number; longitude: number };
}): Promise<string> {
  try {
    const city = await resolveBusCityOrError(args.city, args.userLocation);
    if (typeof city !== "string") return JSON.stringify({ ok: false, ...city });
    const result = await busService.getBusRouteInfo({ routeName: args.routeName, city });
    return JSON.stringify(result);
  } catch (error: any) {
    console.error("[agent-tool:getBusRoute]", error);
    return JSON.stringify({ ok: false, error: "公車路線查詢失敗" });
  }
}

export async function getBusArrival(args: {
  routeName: string;
  stopName: string;
  city?: string;
  direction?: number;
  userLocation?: { latitude: number; longitude: number };
}): Promise<string> {
  try {
    const city = await resolveBusCityOrError(args.city, args.userLocation);
    if (typeof city !== "string") return JSON.stringify({ ok: false, ...city });
    const result = await busService.getBusArrivalAtStop({
      routeName: args.routeName,
      stopName: args.stopName,
      city,
      direction: args.direction,
    });
    return JSON.stringify(result);
  } catch (error: any) {
    console.error("[agent-tool:getBusArrival]", error);
    return JSON.stringify({ ok: false, error: "公車到站查詢失敗" });
  }
}

export async function getBusTimetable(args: {
  routeName: string;
  city?: string;
  userLocation?: { latitude: number; longitude: number };
}): Promise<string> {
  try {
    const city = await resolveBusCityOrError(args.city, args.userLocation);
    if (typeof city !== "string") return JSON.stringify({ ok: false, ...city });
    const result = await busService.getBusTimetable({ routeName: args.routeName, city });
    return JSON.stringify(result);
  } catch (error: any) {
    console.error("[agent-tool:getBusTimetable]", error);
    return JSON.stringify({ ok: false, error: "公車時刻表查詢失敗" });
  }
}

export async function trackBuses(args: {
  routeName: string;
  city?: string;
  direction?: number;
  userLocation?: { latitude: number; longitude: number };
}): Promise<string> {
  try {
    const city = await resolveBusCityOrError(args.city, args.userLocation);
    if (typeof city !== "string") return JSON.stringify({ ok: false, ...city });
    const result = await busService.getBusRealtimeOnRoute({
      routeName: args.routeName,
      city,
      direction: args.direction,
    });
    return JSON.stringify(result);
  } catch (error: any) {
    console.error("[agent-tool:trackBuses]", error);
    return JSON.stringify({ ok: false, error: "公車即時位置查詢失敗" });
  }
}

export async function getAirQuality(args: {
  latitude: number;
  longitude: number;
}): Promise<string> {
  try {
    const data = await airService.getAirData(args.latitude, args.longitude);
    if (!data)
      return JSON.stringify({ ok: false, message: "此區域無空氣品質監測數據" });

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

export async function getA11yFacilityDetails(args: {
  osmId: string;
}): Promise<string> {
  try {
    const ids = args.osmId
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!ids.length) {
      return JSON.stringify({ ok: false, error: "缺少 osmId 參數" });
    }
    const places = await a11yService.findByOsmIds(ids);
    if (!places.length) {
      return JSON.stringify({
        ok: false,
        error: `找不到 osmId: ${ids.join(", ")} 的設施`,
      });
    }
    return JSON.stringify({
      ok: true,
      count: places.length,
      facilities: places,
    });
  } catch (error: any) {
    console.error("[agent-tool:getA11yFacilityDetails]", error);
    return JSON.stringify({ ok: false, error: "設施詳情查詢失敗" });
  }
}

export async function getEnvironmentInfo(args: {
  latitude: number;
  longitude: number;
  radius?: number;
  query?: string;
  userLocation?: { latitude: number; longitude: number };
}): Promise<string> {
  try {
    let { latitude, longitude } = args;
    if (args.query && (!latitude || !longitude)) {
      const coords = await getCoordinates(
        args.query,
        args.userLocation?.latitude,
        args.userLocation?.longitude,
      );
      if (!coords) {
        return JSON.stringify({ ok: false, error: `找不到地點「${args.query}」的座標` });
      }
      latitude = coords.latitude;
      longitude = coords.longitude;
    }
    if (!latitude || !longitude) {
      return JSON.stringify({ ok: false, error: "缺少位置資訊（query 或 lat/lng 必填）" });
    }
    const data = await fetchEnvironment(latitude, longitude, args.radius ?? 1000);
    return JSON.stringify({ ok: true, query: args.query ?? null, ...data });
  } catch (error: any) {
    console.error("[agent-tool:getEnvironmentInfo]", error);
    return JSON.stringify({ ok: false, error: "環境資訊查詢失敗" });
  }
}

export async function getNearbyHazards(args: {
  latitude?: number;
  longitude?: number;
  query?: string;
  radiusM?: number;
  hazardType?: string;
  userLocation?: { latitude: number; longitude: number };
}): Promise<string> {
  try {
    let { latitude, longitude } = args;
    if (args.query && (!latitude || !longitude)) {
      const coords = await getCoordinates(
        args.query,
        args.userLocation?.latitude,
        args.userLocation?.longitude,
      );
      if (!coords) {
        return JSON.stringify({ ok: false, error: `找不到地點「${args.query}」的座標` });
      }
      latitude = coords.latitude;
      longitude = coords.longitude;
    }
    if (!latitude || !longitude) {
      return JSON.stringify({ ok: false, error: "缺少位置資訊（query 或 lat/lng 必填）" });
    }
    const result = await hazardService.findNearby({
      lat: latitude,
      lng: longitude,
      radius: args.radiusM,
      hazardType: args.hazardType as any,
    });
    return JSON.stringify({ ok: result.ok, data: result.data });
  } catch (error: any) {
    console.error("[agent-tool:getNearbyHazards]", error);
    return JSON.stringify({ ok: false, error: "附近路況查詢失敗" });
  }
}

export async function findNearbyParking(args: {
  latitude?: number;
  longitude?: number;
  query?: string;
  radiusM?: number;
  userLocation?: { latitude: number; longitude: number };
}): Promise<string> {
  try {
    let { latitude, longitude } = args;
    if (args.query && (!latitude || !longitude)) {
      const coords = await getCoordinates(
        args.query,
        args.userLocation?.latitude,
        args.userLocation?.longitude,
      );
      if (!coords) {
        return JSON.stringify({ ok: false, error: `找不到地點「${args.query}」的座標` });
      }
      latitude = coords.latitude;
      longitude = coords.longitude;
    }
    if (!latitude || !longitude) {
      return JSON.stringify({ ok: false, error: "缺少位置資訊（query 或 lat/lng 必填）" });
    }
    const spots = await a11yService.findNearbyParking(latitude, longitude, args.radiusM ?? 500);
    return JSON.stringify({
      ok: true,
      query: args.query ?? null,
      searchLocation: { lat: latitude, lng: longitude },
      total: spots.length,
      parkingSpots: spots,
    });
  } catch (error: any) {
    console.error("[agent-tool:findNearbyParking]", error);
    return JSON.stringify({ ok: false, error: "身障停車位查詢失敗" });
  }
}

export async function getNavInstructions(args: {
  origin: string;
  destination: string;
  mode?: string;
  departureTime?: string;
  routeIndex?: number;
  userHeading?: number;
  userLocation?: { latitude: number; longitude: number };
}): Promise<string> {
  try {
    if (args.origin === "current_location" && !args.userLocation) {
      return JSON.stringify({ ok: false, error: "需要使用者位置以使用「目前位置」作為起點" });
    }
    const originInput = args.origin === "current_location" ? args.userLocation : args.origin;
    const validMode = ["wheelchair", "elderly", "visual_impaired", "normal"].includes(args.mode ?? "")
      ? (args.mode as "wheelchair" | "elderly" | "visual_impaired" | "normal")
      : "normal";

    const result = await planAccessibleRouteFromRequest({
      origin: originInput,
      destination: args.destination,
      userLocation: args.userLocation,
      mode: validMode,
      maxTransfers: 2,
      departureTime: args.departureTime,
    });
    if (!result.ok) {
      return JSON.stringify({ ok: false, error: result.error });
    }

    const routes = result.data.routes;
    const idx = Math.min(Math.max(args.routeIndex ?? 0, 0), routes.length - 1);
    const route = routes[idx];

    const navResult = generateNavInstructions(
      { legs: route.legs as any },
      args.userHeading,
    );
    if (!navResult.ok) {
      return JSON.stringify({ ok: false, error: navResult.message });
    }

    return JSON.stringify({
      ok: true,
      routeName: route.routeName,
      totalMinutes: route.totalMinutes,
      instructions: navResult.data.instructions,
      totalSteps: navResult.data.totalSteps,
      initialBearing: navResult.data.initialBearing,
      warnings: navResult.data.warnings,
    });
  } catch (error: any) {
    console.error("[agent-tool:getNavInstructions]", error);
    return JSON.stringify({ ok: false, error: error?.message ?? "導航指引產生失敗" });
  }
}

export async function executeLocalTool(
  name: string,
  args: Record<string, any>,
  userLocation?: { latitude: number; longitude: number },
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

    case "getBusRoute":
      return getBusRoute({
        routeName: args.routeName,
        city: args.city,
        userLocation,
      });

    case "getBusArrival":
      return getBusArrival({
        routeName: args.routeName,
        stopName: args.stopName,
        city: args.city,
        direction: args.direction,
        userLocation,
      });

    case "getBusTimetable":
      return getBusTimetable({
        routeName: args.routeName,
        city: args.city,
        userLocation,
      });

    case "trackBuses":
      return trackBuses({
        routeName: args.routeName,
        city: args.city,
        direction: args.direction,
        userLocation,
      });

    case "getAirQuality":
      return getAirQuality({
        latitude: args.latitude,
        longitude: args.longitude,
      });

    case "getA11yFacilityDetails":
      return getA11yFacilityDetails({ osmId: args.osmId });

    case "getEnvironmentInfo":
      return getEnvironmentInfo({
        latitude: args.latitude,
        longitude: args.longitude,
        radius: args.radius,
        query: args.query,
        userLocation,
      });

    case "getNearbyHazards":
      return getNearbyHazards({
        latitude: args.latitude,
        longitude: args.longitude,
        query: args.query,
        radiusM: args.radiusM,
        hazardType: args.hazardType,
        userLocation,
      });

    case "findNearbyParking":
      return findNearbyParking({
        latitude: args.latitude,
        longitude: args.longitude,
        query: args.query,
        radiusM: args.radiusM,
        userLocation,
      });

    case "getNavInstructions":
      return getNavInstructions({
        origin: args.origin as string,
        destination: args.destination as string,
        mode: args.mode as string | undefined,
        departureTime: args.departureTime as string | undefined,
        routeIndex: args.routeIndex as number | undefined,
        userHeading: args.userHeading as number | undefined,
        userLocation,
      });

    default:
      return JSON.stringify({ error: `未知工具：${name}` });
  }
}
