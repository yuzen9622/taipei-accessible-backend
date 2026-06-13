import axios from "axios";
import { getCoordinates, detectBusApiType, getRouteDirectionImproved } from "../../config/lib";
import * as a11yService from "../a11y/a11y.service";
import { getCity } from "../../config/map";
import { busUrl } from "../../config/transit";
import { tdxFetch } from "../../config/fetch";
import { findAccessibleRoutes } from "../accessible-route/accessible-route.service";
import type { AccessibleRoute, WalkLeg, BusLeg, MetroLeg, ThsrLeg, TraLeg } from "../accessible-route/accessible-route.service";
import type { BusRoute } from "../../types/transit";
import { TaiwanCityEn } from "../../types/transit";
import type { STAApiResponse } from "../../types/air";

const MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// ─── Tool 7: findGooglePlaces ─────────────────────────────────────────────────

export async function findGooglePlaces(args: {
  query: string;
  latitude?: number;
  longitude?: number;
}): Promise<string> {
  const { query, latitude, longitude } = args;
  if (!MAPS_API_KEY) return JSON.stringify({ error: "Google Places API Key is not set." });

  const headers = {
    "Content-Type": "application/json",
    "X-Goog-Api-Key": MAPS_API_KEY,
    "X-Goog-FieldMask":
      "places.id,places.displayName,places.formattedAddress,places.rating,places.location",
  };
  const body: Record<string, unknown> = {
    textQuery: query,
    languageCode: "zh-TW",
    maxResultCount: 3,
  };
  if (latitude !== undefined && longitude !== undefined) {
    body.locationBias = {
      circle: { center: { latitude, longitude }, radius: 1000.0 },
    };
  }

  try {
    const response = await axios.post(
      "https://places.googleapis.com/v1/places:searchText",
      body,
      { headers }
    );
    const { places } = response.data;
    if (!places?.length) return JSON.stringify({ status: "ZERO_RESULTS", places: [] });

    return JSON.stringify({
      status: "OK",
      places: places.map((p: any) => ({
        name: p.displayName?.text ?? "未知名稱",
        place_id: p.id,
        formatted_address: p.formattedAddress,
        rating: p.rating,
        location: p.location,
      })),
    });
  } catch (error: any) {
    console.error("[agent-tool:findGooglePlaces]", error.response?.data ?? error.message);
    return JSON.stringify({ error: "Google Places API 查詢失敗", details: error.response?.data?.error?.message ?? error.message });
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
  const lat = args.latitude ?? 25.0478; // fallback: Taipei
  const lng = args.longitude ?? 121.517;

  try {
    const city = (await getCity(lat, lng)) as TaiwanCityEn;
    const fmt = detectBusApiType(routeName);
    const lang = "Zh_tw";

    const stopUrl =
      fmt.type === "City"
        ? `${busUrl.stopOfRouteUrl}/${city}?$format=JSON&$filter=SubRouteName/${lang} eq '${fmt.routeId}'`
        : `${busUrl.interCityStopOfRouteUrl}?$format=JSON&$filter=SubRouteName/${lang} eq '${fmt.routeId}'`;

    const stopRes = await tdxFetch(stopUrl);
    if (!stopRes.ok) {
      return JSON.stringify({ ok: false, error: "TDX 公車路線資料查詢失敗" });
    }

    const stopJson = (await stopRes.json()) as BusRoute[];
    if (!stopJson || stopJson.length < 2) {
      return JSON.stringify({ ok: false, error: `找不到路線 ${routeName} 的站點資料` });
    }

    const direction = getRouteDirectionImproved(
      { 0: stopJson[0].Stops, 1: stopJson[1].Stops },
      departureStop,
      arrivalStop,
      lang
    );

    if (direction === -1) {
      return JSON.stringify({ ok: false, error: "無法辨識路線方向，請確認站牌名稱是否正確" });
    }

    const etaUrl =
      fmt.type === "City"
        ? `${busUrl.cityEstimatedTimeOfArrivalUrl}/${city}/${fmt.routeId}?$format=JSON&$filter=Direction eq ${direction} and contains(StopName/${lang},'${departureStop}') and RouteName/${lang} eq '${fmt.routeId}'`
        : `${busUrl.interCityEstimatedTimeOfArrivalUrl}/${fmt.routeId}?$format=JSON&$filter=Direction eq ${direction} and contains(StopName/${lang},'${departureStop}') and contains(SubRouteName/${lang},'${fmt.routeId}')`;

    const etaRes = await tdxFetch(etaUrl);
    const etaJson = (await etaRes.json()) as any;

    if (etaJson?.message) {
      return JSON.stringify({ ok: false, error: etaJson.message });
    }

    return JSON.stringify({
      ok: true,
      routeName: fmt.routeId,
      departureStop,
      arrivalStop,
      direction,
      city,
      etaData: Array.isArray(etaJson) ? etaJson.slice(0, 5) : etaJson,
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
    const fmt = detectBusApiType(routeName);

    const url =
      fmt.type === "City"
        ? `${busUrl.cityRealtimeByFrequencyUrl}/${city}?$format=JSON&$filter=PlateNumb eq '${plateNumber}'`
        : `${busUrl.interCityRealTimeByFrequencyUrl}?$format=JSON&$filter=PlateNumb eq '${plateNumber}'`;

    const res = await tdxFetch(url);
    if (!res.ok) {
      return JSON.stringify({ ok: false, error: "TDX 公車位置查詢失敗" });
    }

    const data = (await res.json()) as any;
    return JSON.stringify({ ok: true, plateNumber, routeName, city, positionData: data });
  } catch (error: any) {
    console.error("[agent-tool:getBusPosition]", error);
    return JSON.stringify({ ok: false, error: "公車位置查詢失敗" });
  }
}

// ─── Tool 5: getAirQuality ────────────────────────────────────────────────────

function classifyPm25(pm25: number): { quality: string; advice: string } {
  if (pm25 <= 12) {
    return { quality: "良好", advice: "空氣品質良好，適合戶外活動" };
  }
  if (pm25 <= 35.4) {
    return { quality: "普通", advice: "空氣品質尚可，敏感族群可考慮減少長時間戶外活動" };
  }
  if (pm25 <= 55.4) {
    return {
      quality: "對敏感族群不健康",
      advice: "輪椅使用者及呼吸道敏感者建議配戴口罩，減少戶外停留時間",
    };
  }
  if (pm25 <= 150.4) {
    return { quality: "不健康", advice: "建議所有人減少戶外活動，出門配戴口罩" };
  }
  return { quality: "非常不健康", advice: "強烈建議不要外出，若必須外出請配戴 N95 口罩" };
}

export async function getAirQuality(args: {
  latitude: number;
  longitude: number;
}): Promise<string> {
  const { latitude, longitude } = args;

  try {
    const geocode = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?latlng=${latitude},${longitude}&key=${process.env.GOOGLE_MAPS_API_KEY}&language=zh-TW`
    );
    const geocodeData = (await geocode.json()) as any;

    let city = "臺北市";
    const cityComp = geocodeData?.results?.[0]?.address_components?.find((c: any) =>
      c.types.includes("administrative_area_level_1")
    );
    if (cityComp) city = (cityComp.long_name as string).replace("台", "臺");

    const staUrl =
      `https://sta.ci.taiwan.gov.tw/STA_AirQuality_EPAIoT/v1.0/Datastreams` +
      `?$expand=Thing,Observations($orderby=phenomenonTime desc;$top=1)` +
      `&$filter=name eq 'PM2.5' and Thing/properties/areaType eq '${city}'`;

    const staRes = await fetch(staUrl);
    const staData = (await staRes.json()) as STAApiResponse;

    const readings = staData.value
      .map((item) => ({
        area: item.Thing?.properties?.areaDescription ?? null,
        pm25: item.Observations?.[0]?.result ?? null,
        coordinates: item.observedArea?.coordinates,
        city: item.Thing?.properties?.areaType ?? null,
      }))
      .filter((v) => v.pm25 !== null);

    if (!readings.length) {
      return JSON.stringify({ ok: false, message: "此區域無空氣品質監測數據" });
    }

    const pm25 = readings[0].pm25 as number;
    const { quality, advice } = classifyPm25(pm25);

    return JSON.stringify({
      ok: true,
      city,
      area: readings[0].area,
      pm25,
      quality,
      advice,
      coordinates: readings[0].coordinates,
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
