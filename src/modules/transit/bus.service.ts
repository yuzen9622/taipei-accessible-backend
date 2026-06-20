/**
 * Bus query service powering the AI agent's bus tools and the /transit/bus/*
 * REST endpoints. Reads imported static data (BusRoute, BusVehicle) and calls
 * TDX only for the genuinely live bits (A1 position, N1 ETA, Schedule). The
 * headline feature: realtime positions are joined against the imported Vehicle
 * table by plate number, so the agent can tell the user whether the
 * approaching bus is low-floor — without ever asking for a plate number.
 *
 * Uses the TDX V2 City endpoints (busUrl): for this TDX account the V3 City
 * endpoints are restricted to a single city, whereas V2 serves all of Taiwan
 * and still exposes Vehicle (IsLowFloor / HasLiftOrRamp). Inter-city (公路客運,
 * 1xxx) routes fall back to the V2 InterCity endpoints.
 */

import { detectBusApiType, equalStopName } from "../../utils/transit-text";
import { busUrl } from "../../config/transit";
import { tdxFetch } from "../../config/fetch";
import { getCity } from "../../adapters/google.adapter";
import BusRouteModel from "../../model/bus-route.model";
import BusVehicleModel from "../../model/bus-vehicle.model";
import { TaiwanCityEn } from "../../types/transit";
import { ITdxBusVehicle } from "../../types";
import {
  cityFromAlias,
  yesNoLabel,
  VEHICLE_CLASS_LABEL,
  DIRECTION_LABEL,
  BUS_STATUS_LABEL,
  STOP_STATUS_LABEL,
} from "../../constants/bus";
import type {
  BusRouteInfoResult,
  BusRouteDirection,
  BusArrivalResult,
  BusArrival,
  BusTimetableResult,
  BusFrequency,
  BusScheduleByDirection,
  BusRealtimeOnRouteResult,
  BusOnRoad,
} from "./transit.types";

/**
 * Resolve a user-supplied city string (or fall back to reverse-geocoding the
 * user's coordinates) to a TDX city code.
 *
 * @param cityInput Raw city string from the request/tool (optional).
 * @param userLoc User coordinates used as a fallback (optional).
 * @returns The matching TaiwanCityEn, or null when it can't be determined.
 */
export async function resolveBusCity(
  cityInput?: string,
  userLoc?: { latitude: number; longitude: number },
): Promise<TaiwanCityEn | null> {
  const direct = cityFromAlias(cityInput);
  if (direct) return direct;
  if (userLoc) {
    try {
      return cityFromAlias(await getCity(userLoc.latitude, userLoc.longitude));
    } catch {
      return null;
    }
  }
  return null;
}

function dirLabel(d: number): string {
  return DIRECTION_LABEL[d] ?? "未知";
}

async function fetchTdxArray(url: string): Promise<any[]> {
  const res = await tdxFetch(url);
  if (!res.ok) throw new Error(`TDX ${res.status}`);
  const json = await res.json();
  return Array.isArray(json) ? json : [];
}

/** Build plate → vehicle (low-floor) lookup for a set of plate numbers. */
async function lowFloorMap(
  plates: (string | undefined)[],
): Promise<Map<string, ITdxBusVehicle>> {
  const uniq = [...new Set(plates.filter((p): p is string => !!p && p !== "-1"))];
  if (!uniq.length) return new Map();
  const docs = await BusVehicleModel.find({ plateNumb: { $in: uniq } }).lean();
  return new Map(
    docs.map((d): [string, ITdxBusVehicle] => [d.plateNumb, d as ITdxBusVehicle]),
  );
}

type NormalizedRoute = {
  direction: number;
  operators: string[];
  stops: { seq: number; name: string; lat?: number; lng?: number }[];
};

function buildDirections(records: NormalizedRoute[]): BusRouteDirection[] {
  const byDir = new Map<number, NormalizedRoute>();
  for (const r of records) {
    const existing = byDir.get(r.direction);
    // Keep the representative (longest) sub-route per direction.
    if (!existing || r.stops.length > existing.stops.length) byDir.set(r.direction, r);
  }
  return [...byDir.values()]
    .sort((a, b) => a.direction - b.direction)
    .map((r) => {
      const stops = [...r.stops].sort((a, b) => a.seq - b.seq);
      return {
        direction: r.direction,
        directionLabel: dirLabel(r.direction),
        from: stops[0]?.name ?? "",
        to: stops[stops.length - 1]?.name ?? "",
        stopCount: stops.length,
        stops,
      };
    });
}

/**
 * Look up a bus route's stop sequence (both directions). Prefers imported
 * BusRoute data; falls back to a live TDX StopOfRoute query when not imported.
 */
export async function getBusRouteInfo(params: {
  routeName: string;
  city: TaiwanCityEn;
}): Promise<BusRouteInfoResult> {
  const { city } = params;
  const { type, routeId } = detectBusApiType(params.routeName);

  try {
    const docs = await BusRouteModel.find({
      city,
      "routeName.Zh_tw": routeId,
    }).lean();

    if (docs.length) {
      const normalized: NormalizedRoute[] = docs.map((d) => ({
        direction: d.direction,
        operators: (d.operators ?? []).map((o) => o.name).filter(Boolean) as string[],
        stops: (d.stops ?? []).map((s) => ({
          seq: s.seq,
          name: s.stopName?.Zh_tw ?? "",
          lat: s.lat,
          lng: s.lng,
        })),
      }));
      return {
        ok: true,
        routeName: routeId,
        city,
        source: "db",
        operators: [...new Set(normalized.flatMap((n) => n.operators))],
        directions: buildDirections(normalized),
      };
    }

    // Live fallback (route not imported, e.g. inter-city or a non-六都 city).
    const url =
      type === "City"
        ? `${busUrl.stopOfRouteUrl}/${city}?$format=JSON&$filter=RouteName/Zh_tw eq '${routeId}'`
        : `${busUrl.interCityStopOfRouteUrl}?$format=JSON&$filter=RouteName/Zh_tw eq '${routeId}'`;
    const live = await fetchTdxArray(url);
    if (!live.length) {
      return { ok: false, error: `找不到路線「${params.routeName}」的站序資料`, status: 404 };
    }
    const normalized: NormalizedRoute[] = live.map((r: any) => ({
      direction: r.Direction,
      operators: (r.Operators ?? [])
        .map((o: any) => o.OperatorName?.Zh_tw)
        .filter(Boolean),
      stops: (r.Stops ?? []).map((s: any) => ({
        seq: s.StopSequence,
        name: s.StopName?.Zh_tw ?? "",
        lat: s.StopPosition?.PositionLat,
        lng: s.StopPosition?.PositionLon,
      })),
    }));
    return {
      ok: true,
      routeName: routeId,
      city,
      source: "tdx",
      operators: [...new Set(normalized.flatMap((n) => n.operators))],
      directions: buildDirections(normalized),
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message || "路線查詢失敗", status: 500 };
  }
}

/**
 * Predicted arrival of the next bus of a route at a named stop (TDX N1).
 * V2 N1 does not carry a plate number, so low-floor is reported separately via
 * getBusRealtimeOnRoute / trackBuses.
 */
export async function getBusArrivalAtStop(params: {
  routeName: string;
  stopName: string;
  city: TaiwanCityEn;
  direction?: number;
}): Promise<BusArrivalResult> {
  const { city, stopName, direction } = params;
  const { type, routeId } = detectBusApiType(params.routeName);

  try {
    // No server-side StopName filter: TDX stores 臺/台 variants and bracketed
    // suffixes, so match client-side with equalStopName (which normalizes both).
    const dirFilter =
      direction === 0 || direction === 1 ? `&$filter=Direction eq ${direction}` : "";
    const url =
      type === "City"
        ? `${busUrl.cityEstimatedTimeOfArrivalUrl}/${city}/${routeId}?$format=JSON${dirFilter}`
        : `${busUrl.interCityEstimatedTimeOfArrivalUrl}/${routeId}?$format=JSON${dirFilter}`;

    const records = await fetchTdxArray(url);
    const matched = records.filter((r: any) =>
      equalStopName(r.StopName?.Zh_tw, stopName),
    );
    if (!matched.length) {
      return {
        ok: false,
        error: `找不到路線「${params.routeName}」在「${stopName}」的到站資料`,
        status: 404,
      };
    }

    const arrivals: BusArrival[] = matched
      .map((r: any) => {
        const est: number | null =
          typeof r.EstimateTime === "number" && r.EstimateTime >= 0
            ? Math.round(r.EstimateTime / 60)
            : null;
        return {
          stopName: r.StopName?.Zh_tw ?? stopName,
          direction: r.Direction,
          directionLabel: dirLabel(r.Direction),
          estimateMinutes: est,
          statusLabel: STOP_STATUS_LABEL[r.StopStatus] ?? "正常",
        };
      })
      .sort((a, b) => {
        if (a.estimateMinutes == null) return 1;
        if (b.estimateMinutes == null) return -1;
        return a.estimateMinutes - b.estimateMinutes;
      });

    return { ok: true, routeName: routeId, city, stopName, arrivals };
  } catch (err) {
    return { ok: false, error: (err as Error).message || "到站查詢失敗", status: 500 };
  }
}

function serviceDayLabel(sd?: Record<string, number>): string {
  if (!sd) return "";
  const days = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ];
  const on = days.filter((d) => sd[d]);
  if (on.length === 7) return "每日";
  const weekday = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
  if (on.length === 5 && weekday.every((d) => sd[d])) return "平日";
  if (on.length === 2 && sd.Saturday && sd.Sunday) return "假日";
  const zh: Record<string, string> = {
    Monday: "一",
    Tuesday: "二",
    Wednesday: "三",
    Thursday: "四",
    Friday: "五",
    Saturday: "六",
    Sunday: "日",
  };
  return on.length ? `週${on.map((d) => zh[d]).join("")}` : "";
}

/**
 * Route timetable per direction: first/last service time and the service
 * frequency (headway) bands (TDX V2 Schedule — frequency-based).
 */
export async function getBusTimetable(params: {
  routeName: string;
  city: TaiwanCityEn;
}): Promise<BusTimetableResult> {
  const { city } = params;
  const { type, routeId } = detectBusApiType(params.routeName);

  try {
    const url =
      type === "City"
        ? `${busUrl.cityScheduleUrl}/${city}?$format=JSON&$filter=RouteName/Zh_tw eq '${routeId}'`
        : `${busUrl.cityScheduleUrl.replace("/City", "/InterCity")}?$format=JSON&$filter=RouteName/Zh_tw eq '${routeId}'`;

    const records = await fetchTdxArray(url);
    if (!records.length) {
      return { ok: false, error: `找不到路線「${params.routeName}」的時刻表`, status: 404 };
    }

    const byDir = new Map<number, BusFrequency[]>();
    for (const r of records) {
      const list = byDir.get(r.Direction) ?? [];
      for (const f of r.Frequencys ?? []) {
        list.push({
          start: f.StartTime,
          end: f.EndTime,
          minHeadwayMins: f.MinHeadwayMins,
          maxHeadwayMins: f.MaxHeadwayMins,
          serviceDays: serviceDayLabel(f.ServiceDay),
        });
      }
      // Some operators publish Timetables (explicit trips) instead of Frequencys.
      for (const t of r.Timetables ?? []) {
        const dep = t.StopTimes?.[0]?.DepartureTime;
        if (dep) list.push({ start: dep, end: dep, serviceDays: serviceDayLabel(t.ServiceDay) });
      }
      byDir.set(r.Direction, list);
    }

    const schedules: BusScheduleByDirection[] = [...byDir.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([direction, frequencies]) => {
        const starts = frequencies.map((f) => f.start).filter(Boolean) as string[];
        const ends = frequencies.map((f) => f.end).filter(Boolean) as string[];
        return {
          direction,
          directionLabel: dirLabel(direction),
          first: starts.length ? starts.sort()[0] : undefined,
          last: ends.length ? ends.sort()[ends.length - 1] : undefined,
          frequencies,
        };
      });

    return { ok: true, routeName: routeId, city, schedules };
  } catch (err) {
    return { ok: false, error: (err as Error).message || "時刻表查詢失敗", status: 500 };
  }
}

/**
 * All buses currently running on a route (TDX A1), each annotated with
 * low-floor / lift-or-ramp status joined from the imported Vehicle table.
 * The user never supplies a plate number — the agent obtains the live plates.
 */
export async function getBusRealtimeOnRoute(params: {
  routeName: string;
  city: TaiwanCityEn;
  direction?: number;
}): Promise<BusRealtimeOnRouteResult> {
  const { city, direction } = params;
  const { type, routeId } = detectBusApiType(params.routeName);

  try {
    const dirFilter =
      direction === 0 || direction === 1 ? `&$filter=Direction eq ${direction}` : "";
    const url =
      type === "City"
        ? `${busUrl.cityRealtimeByFrequencyUrl}/${city}/${routeId}?$format=JSON${dirFilter}`
        : `${busUrl.interCityRealTimeByFrequencyUrl}?$format=JSON&$filter=RouteName/Zh_tw eq '${routeId}'${
            direction === 0 || direction === 1 ? ` and Direction eq ${direction}` : ""
          }`;

    const records = await fetchTdxArray(url);
    if (!records.length) {
      return {
        ok: false,
        error: `路線「${params.routeName}」目前沒有營運中的車輛`,
        status: 404,
      };
    }

    const vehicles = await lowFloorMap(records.map((r: any) => r.PlateNumb));
    const buses: BusOnRoad[] = records.map((r: any) => {
      const veh = vehicles.get(r.PlateNumb);
      return {
        plateNumb: r.PlateNumb,
        direction: r.Direction,
        directionLabel: dirLabel(r.Direction),
        lat: r.BusPosition?.PositionLat,
        lng: r.BusPosition?.PositionLon,
        speed: r.Speed,
        statusLabel: BUS_STATUS_LABEL[r.BusStatus] ?? "正常",
        gpsTime: r.GPSTime,
        isLowFloor: yesNoLabel(veh?.isLowFloor),
        hasLiftOrRamp: yesNoLabel(veh?.hasLiftOrRamp),
        vehicleClass:
          veh?.vehicleClass != null ? VEHICLE_CLASS_LABEL[veh.vehicleClass] : undefined,
      };
    });

    return {
      ok: true,
      routeName: routeId,
      city,
      count: buses.length,
      lowFloorCount: buses.filter((b) => b.isLowFloor === "是").length,
      buses,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message || "即時位置查詢失敗", status: 500 };
  }
}
