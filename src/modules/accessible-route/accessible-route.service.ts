import { tdxFetch } from "../../config/fetch";
import {
  busUrl,
  metroUrl,
  thsrUrl,
  traUrl,
  metroLineCode,
} from "../../config/transit";
import { CITY_METRO_SYSTEMS } from "../../constants/transit";
import { FACILITY_LABELS } from "../../constants/accessibility";
import { getRouteDirectionImproved, equalStopName } from "../../utils/transit-text";
import { orsWalkingRoute } from "./planners/ors";
import {
  taipeiMinutesOfDay,
  taipeiWeekday,
  taipeiHHmm,
} from "../../config/taipei-time";
import {
  scoreRoute,
  routeCost,
  prerankCost,
  MODE_PROFILES,
} from "./scoring";
import BusStopModel from "../../model/bus-stop.model";
import MetroStationModel from "../../model/metro-station.model";
import TrainStationModel from "../../model/train-station.model";
import OsmA11y from "../../model/osm-a11y.model";
import {
  IOsmA11y,
  ITdxBusStop,
  ITdxMetroStation,
  ITdxTrainStation,
} from "../../types";
import {
  BusRoute,
  TdxMetroStationOfLine,
  TdxMetroS2STravelTimeRecord,
  TdxMetroFrequencyRecord,
  TdxMetroStationFacility,
  TdxThsrGeneralTimetableItem,
  TdxTraGeneralTimetableItem,
} from "../../types/transit";
import { TaiwanCityEn } from "../../types/transit";
import { slimRoutes, compactRoutes } from "./facility-slim";
import { getCity, getCoordinates } from "../../adapters/google.adapter";
import { parseRouteIntent } from "../ai/ai.service";
import type { RouteIntent } from "../../types/ai";
import { ResponseCode } from "../../types/code";
import { ERROR_MESSAGE } from "../../constants/messages";
import type {
  FindAccessibleRoutesOptions,
  PlanRouteRequest,
  PlanRouteResult,
} from "./accessible-route.types";
export type {
  FindAccessibleRoutesOptions,
  PlanRouteRequest,
  PlanRouteResult,
};

import type {
  AccessibilityMode,
  SlimA11y,
  WaitInfo,
  WalkLeg,
  BusLeg,
  MetroLeg,
  ThsrLeg,
  TraLeg,
  AccessibleRoute,
} from "../../types/route";
export type {
  SlimA11y,
  WaitInfo,
  WalkLeg,
  BusLeg,
  MetroLeg,
  ThsrLeg,
  TraLeg,
  AccessibleRoute,
} from "../../types/route";

/**
 * Numeric wait estimate from a WaitInfo, for duration arithmetic: realtime
 * minutes pass through; a schedule "HH:mm" becomes (clock − now), midnight
 * wrap handled; unavailable → 0.
 */
export function waitInfoMinutes(w: WaitInfo): number {
  if (typeof w.time === "number") return w.time;
  if (typeof w.time === "string") {
    const [h, m] = w.time.split(":").map(Number);
    if (isNaN(h) || isNaN(m)) return 0;
    let diff = h * 60 + m - taipeiMinutesOfDay();
    if (diff < -720) diff += 1440;
    return Math.max(0, diff);
  }
  return 0;
}

export function nearQuery(coords: [number, number], maxDistM: number) {
  return {
    location: {
      $near: {
        $geometry: { type: "Point", coordinates: coords },
        $maxDistance: maxDistM,
      },
    },
  };
}

export function haversineM(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export async function fetchTdxRoute(
  subRouteId: string,
  city: string,
): Promise<BusRoute[]> {
  const url = `${busUrl.stopOfRouteUrl}/${city}?$format=JSON&$filter=SubRouteName/Zh_tw eq '${subRouteId}'`;
  const resp = await tdxFetch(url);
  if (!resp.ok) return [];
  return (await resp.json()) as BusRoute[];
}

async function fetchScheduledWait(
  subRouteId: string,
  city: string,
  direction: number,
): Promise<number | null> {
  try {
    const url = `${busUrl.cityScheduleUrl}/${city}/${subRouteId}?$format=JSON`;
    const resp = await tdxFetch(url);
    if (!resp.ok) return null;
    const data = (await resp.json()) as any[];
    if (!Array.isArray(data) || !data.length) return null;

    const nowMinutes = taipeiMinutesOfDay();
    let nearest: number | null = null;

    for (const entry of data) {
      if (entry.Direction !== direction) continue;
      for (const timetable of entry.Timetables ?? []) {
        for (const trip of timetable.Trips ?? []) {
          const firstStop = trip.StopTimes?.[0];
          if (!firstStop?.DepartureTime) continue;
          const [h, m] = (firstStop.DepartureTime as string)
            .split(":")
            .map(Number);
          if (isNaN(h) || isNaN(m)) continue;
          const depMinutes = h * 60 + m;
          let diff = depMinutes - nowMinutes;
          if (diff < -720) diff += 1440;
          if (diff >= 0 && (nearest === null || diff < nearest)) {
            nearest = diff;
          }
        }
      }
    }

    return nearest;
  } catch {
    return null;
  }
}

export async function fetchWaitInfo(
  subRouteId: string,
  city: string,
  direction: number,
  stopName: string,
): Promise<WaitInfo> {
  try {
    const url =
      `${busUrl.cityEstimatedTimeOfArrivalUrl}/${city}/${subRouteId}` +
      `?$format=JSON&$filter=Direction eq ${direction} and contains(StopName/Zh_tw,'${stopName}')`;
    const resp = await tdxFetch(url);
    if (resp.ok) {
      const data = (await resp.json()) as any[];
      if (Array.isArray(data) && data.length) {
        const record = data[0];
        const estimateTime: number | null = record.EstimateTime ?? null;
        const stopStatus: number = record.StopStatus ?? 0;

        if (estimateTime != null && estimateTime >= 0) {
          return { time: Math.round(estimateTime / 60), source: "realtime" };
        }
        if (stopStatus === 3 || stopStatus === 4) {
          return { time: null, source: "unavailable" };
        }
      }
    }
  } catch {
    /* ignore */
  }

  const scheduled = await fetchScheduledWait(subRouteId, city, direction);
  if (scheduled !== null) {
    const dep = new Date(Date.now() + scheduled * 60000);
    return { time: taipeiHHmm(dep), source: "schedule" };
  }
  return { time: null, source: "unavailable" };
}

export async function buildCandidate(
  subRouteId: string,
  city: string,
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  originStopDoc: ITdxBusStop | null,
  destStopDoc: ITdxBusStop | null,
  mode: AccessibilityMode = "normal",
): Promise<AccessibleRoute | null> {
  if (!originStopDoc || !destStopDoc) return null;

  const routes = await fetchTdxRoute(subRouteId, city);
  if (!routes.length) return null;

  const byDir: Record<number, BusRoute["Stops"]> = {};
  for (const r of routes) byDir[r.Direction] = r.Stops;

  const direction = getRouteDirectionImproved(
    byDir,
    originStopDoc.stopName.Zh_tw,
    destStopDoc.stopName.Zh_tw,
    "Zh_tw",
  );
  if (direction === -1) return null;

  const dirStops = byDir[direction] ?? [];
  const originIdx = dirStops.findIndex((s) =>
    equalStopName(s.StopName?.Zh_tw, originStopDoc.stopName.Zh_tw),
  );
  const destIdx = dirStops.findIndex((s) =>
    equalStopName(s.StopName?.Zh_tw, destStopDoc.stopName.Zh_tw),
  );
  if (originIdx === -1 || destIdx === -1 || originIdx >= destIdx) return null;

  const busPolyline: [number, number][] = dirStops
    .slice(originIdx, destIdx + 1)
    .map((s) => [s.StopPosition.PositionLon, s.StopPosition.PositionLat]);

  const originCoords: [number, number] = [origin.lng, origin.lat];
  const destCoords: [number, number] = [destination.lng, destination.lat];
  const originStopCoords = originStopDoc.location.coordinates as [
    number,
    number,
  ];
  const destStopCoords = destStopDoc.location.coordinates as [number, number];

  const [walkTo, walkFrom, waitInfo, originA11y, destA11y] =
    await Promise.all([
      orsWalkingRoute(originCoords, originStopCoords, mode),
      orsWalkingRoute(destStopCoords, destCoords, mode),
      fetchWaitInfo(subRouteId, city, direction, originStopDoc.stopName.Zh_tw),
      OsmA11y.find(nearQuery(originStopCoords, 150)).limit(5).lean(),
      OsmA11y.find(nearQuery(destStopCoords, 150)).limit(5).lean(),
    ]);

  const waitMinutes = waitInfoMinutes(waitInfo);
  const transitMinutes = (destIdx - originIdx) * 2;
  const totalMinutes = Math.round(
    walkTo.durationSec / 60 +
      waitMinutes +
      transitMinutes +
      walkFrom.durationSec / 60,
  );

  const tagVal = (nodes: IOsmA11y[], key: string, val: string) =>
    nodes.some((f) => f.tags?.[key] === val);

  const highlights: string[] = [];
  if (
    originA11y.some((f) => f.category === "elevator") ||
    tagVal(originA11y, "elevator", "yes")
  )
    highlights.push("上車站附近有電梯");
  if (
    destA11y.some((f) => f.category === "elevator") ||
    tagVal(destA11y, "elevator", "yes")
  )
    highlights.push("下車站附近有電梯");
  if (
    originA11y.some((f) => f.category === "kerb_cut" || f.category === "ramp")
  )
    highlights.push("上車站附近有無障礙坡道");
  if (destA11y.some((f) => f.category === "kerb_cut" || f.category === "ramp"))
    highlights.push("下車站附近有無障礙坡道");
  if (
    tagVal(originA11y, "toilets:wheelchair", "yes") ||
    tagVal(destA11y, "toilets:wheelchair", "yes")
  )
    highlights.push("站點附近有無障礙廁所");
  if (
    tagVal(originA11y, "tactile_paving", "yes") ||
    tagVal(destA11y, "tactile_paving", "yes")
  )
    highlights.push("附近有導盲磚");
  if (
    tagVal(originA11y, "traffic_signals:sound", "yes") ||
    tagVal(destA11y, "traffic_signals:sound", "yes")
  )
    highlights.push("附近有音響號誌");
  if (tagVal(originA11y, "wheelchair", "yes"))
    highlights.push("上車站設施完善");
  if (tagVal(destA11y, "wheelchair", "yes")) highlights.push("下車站設施完善");

  const busLeg: BusLeg = {
    type: "BUS",
    routeName: subRouteId,
    departureStop: originStopDoc.stopName.Zh_tw,
    arrivalStop: destStopDoc.stopName.Zh_tw,
    waitInfo,
    estimatedWaitMinutes: waitMinutes,
    direction: direction as 0 | 1,
    polyline: busPolyline,
    departureStopA11y: originA11y as IOsmA11y[],
    arrivalStopA11y: destA11y as IOsmA11y[],
    tdxCity: city,
  };

  return {
    routeId: subRouteId,
    routeName: subRouteId,
    totalMinutes,
    transferCount: 0,
    legs: [
      {
        type: "WALK",
        from: "出發地",
        to: originStopDoc.stopName.Zh_tw,
        distanceM: Math.round(walkTo.distanceM),
        minutesEst: Math.round(walkTo.durationSec / 60),
        polyline: walkTo.polyline,
        a11yFacilities: originA11y as IOsmA11y[],
      },
      busLeg,
      {
        type: "WALK",
        from: destStopDoc.stopName.Zh_tw,
        to: "目的地",
        distanceM: Math.round(walkFrom.distanceM),
        minutesEst: Math.round(walkFrom.durationSec / 60),
        polyline: walkFrom.polyline,
        a11yFacilities: destA11y as IOsmA11y[],
      },
    ],
    accessibilityHighlights: highlights,
  };
}

export async function fetchMetroStationOfLine(
  railSystem: string,
): Promise<TdxMetroStationOfLine[]> {
  const resp = await tdxFetch(
    `${metroUrl.stationOfLineUrl(railSystem)}?$format=JSON`,
  );
  if (!resp.ok) return [];
  return (await resp.json()) as TdxMetroStationOfLine[];
}

export async function fetchMetroTravelTimes(
  railSystem: string,
): Promise<Map<string, number>> {
  const travelMap = new Map<string, number>();
  try {
    const resp = await tdxFetch(
      `${metroUrl.s2sTravelTimeUrl(railSystem)}?$format=JSON`,
    );
    if (!resp.ok) return travelMap;
    const records = (await resp.json()) as TdxMetroS2STravelTimeRecord[];
    for (const record of records) {
      for (const tt of record.TravelTimes ?? []) {
        const fromUid = `${railSystem}-${tt.FromStationID}`;
        const toUid = `${railSystem}-${tt.ToStationID}`;
        travelMap.set(`${fromUid}|${toUid}`, Math.round(tt.RunTime / 60));
      }
    }
  } catch {
    /* return empty map */
  }
  return travelMap;
}

export async function fetchMetroHeadway(
  railSystem: string,
  lineUid: string,
): Promise<number> {
  try {
    const lineId = lineUid.startsWith(`${railSystem}-`)
      ? lineUid.slice(railSystem.length + 1)
      : lineUid;
    const resp = await tdxFetch(
      `${metroUrl.frequencyUrl(railSystem)}?$format=JSON&$filter=LineID eq '${lineId}'`,
    );
    if (!resp.ok) return 6;
    const records = (await resp.json()) as TdxMetroFrequencyRecord[];
    if (!Array.isArray(records) || !records.length) return 6;

    const nowMins = taipeiMinutesOfDay();

    const allHeadways = records.flatMap((r) => r.Headways ?? []);
    const hw =
      allHeadways.find((h) => {
        if (!h.StartTime || !h.EndTime) return false;
        const [sh, sm] = h.StartTime.split(":").map(Number);
        const [eh, em] = h.EndTime.split(":").map(Number);
        return nowMins >= sh * 60 + sm && nowMins <= eh * 60 + em;
      }) ?? allHeadways[0];

    const min: number = hw?.MinHeadwayMins ?? 6;
    const max: number = hw?.MaxHeadwayMins ?? 6;
    return Math.round((min + max) / 2);
  } catch {
    return 6;
  }
}

export async function fetchMetroFacilities(
  railSystem: string,
  stationUid: string,
): Promise<TdxMetroStationFacility | null> {
  try {
    const resp = await tdxFetch(
      `${metroUrl.stationFacilityUrl(railSystem)}?$format=JSON&$filter=StationUID eq '${stationUid}'`,
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as TdxMetroStationFacility[];
    return data[0] ?? null;
  } catch {
    return null;
  }
}

export async function buildMetroCandidate(
  railSystem: string,
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  mode: AccessibilityMode = "normal",
): Promise<AccessibleRoute | null> {
  const originCoords: [number, number] = [origin.lng, origin.lat];
  const destCoords: [number, number] = [destination.lng, destination.lat];

  const [originStations, destStations] = await Promise.all([
    MetroStationModel.find({
      ...nearQuery(originCoords, 800),
      railSystem,
    })
      .limit(5)
      .lean<ITdxMetroStation[]>(),
    MetroStationModel.find({
      ...nearQuery(destCoords, 800),
      railSystem,
    })
      .limit(5)
      .lean<ITdxMetroStation[]>(),
  ]);
  if (!originStations.length || !destStations.length) return null;

  const originLineIds = new Set(originStations.flatMap((s) => s.lineIds));
  const destLineIds = new Set(destStations.flatMap((s) => s.lineIds));
  const commonLines = [...originLineIds].filter((id) => destLineIds.has(id));
  if (!commonLines.length) return null;

  const [stationOfLines, travelMap] = await Promise.all([
    fetchMetroStationOfLine(railSystem),
    fetchMetroTravelTimes(railSystem),
  ]);

  let direction: 0 | 1 | null = null;
  let orderedSeq: TdxMetroStationOfLine["Stations"] = [];
  let lineUid = "";
  let boardStation: ITdxMetroStation | null = null;
  let alightStation: ITdxMetroStation | null = null;

  outer: for (const lid of commonLines) {
    const bareLineId = lid.startsWith(`${railSystem}-`)
      ? lid.slice(railSystem.length + 1)
      : lid;
    for (const sol of stationOfLines) {
      if (sol.LineID !== bareLineId) continue;
      for (const os of originStations.filter((s) => s.lineIds.includes(lid))) {
        for (const ds of destStations.filter((s) => s.lineIds.includes(lid))) {
          const bareBoard = os.stationUid.startsWith(`${railSystem}-`)
            ? os.stationUid.slice(railSystem.length + 1)
            : os.stationUid;
          const bareAlight = ds.stationUid.startsWith(`${railSystem}-`)
            ? ds.stationUid.slice(railSystem.length + 1)
            : ds.stationUid;
          const seqBoard = sol.Stations.findIndex(
            (s) => s.StationID === bareBoard,
          );
          const seqAlight = sol.Stations.findIndex(
            (s) => s.StationID === bareAlight,
          );
          if (seqBoard !== -1 && seqAlight !== -1 && seqBoard < seqAlight) {
            direction = 0;
            orderedSeq = sol.Stations.slice(seqBoard, seqAlight + 1);
            lineUid = lid;
            boardStation = os;
            alightStation = ds;
            break outer;
          }
        }
      }
    }
  }
  if (direction === null || !boardStation || !alightStation) return null;

  let rideMinutes =
    travelMap.get(`${boardStation.stationUid}|${alightStation.stationUid}`) ??
    null;
  if (rideMinutes === null) {
    let sum = 0;
    for (let i = 0; i < orderedSeq.length - 1; i++) {
      const fromUid = `${railSystem}-${orderedSeq[i].StationID}`;
      const toUid = `${railSystem}-${orderedSeq[i + 1].StationID}`;
      sum += travelMap.get(`${fromUid}|${toUid}`) ?? 2;
    }
    rideMinutes = sum;
  }

  const avgHeadway = await fetchMetroHeadway(railSystem, lineUid);
  const waitMinutes = Math.round(avgHeadway / 2);
  const waitInfo: WaitInfo = { time: waitMinutes, source: "schedule" };

  const boardCoords = boardStation.location.coordinates as [number, number];
  const alightCoords = alightStation.location.coordinates as [number, number];

  const [
    walkTo,
    walkFrom,
    boardFacility,
    alightFacility,
    boardA11y,
    alightA11y,
  ] = await Promise.all([
    orsWalkingRoute(originCoords, boardCoords, mode),
    orsWalkingRoute(alightCoords, destCoords, mode),
    fetchMetroFacilities(railSystem, boardStation.stationUid),
    fetchMetroFacilities(railSystem, alightStation.stationUid),
    OsmA11y.find(nearQuery(boardCoords, 200)).limit(5).lean(),
    OsmA11y.find(nearQuery(alightCoords, 200)).limit(5).lean(),
  ]);

  const facilityHighlights: string[] = [];
  for (const [facility, prefix] of [
    [boardFacility, "乘車站"],
    [alightFacility, "下車站"],
  ] as [TdxMetroStationFacility | null, string][]) {
    if (!facility) continue;
    for (const f of facility.Facilities) {
      const label = FACILITY_LABELS[f.FacilityType];
      if (label) facilityHighlights.push(`${prefix}${label}`);
    }
  }

  const osmTagVal = (nodes: IOsmA11y[], key: string, val: string) =>
    nodes.some((f) => f.tags?.[key] === val);

  const highlights: string[] = [...facilityHighlights];
  if (
    boardA11y.some((f: any) => f.category === "elevator") ||
    osmTagVal(boardA11y as IOsmA11y[], "elevator", "yes")
  )
    highlights.push("乘車站附近有電梯");
  if (
    alightA11y.some((f: any) => f.category === "elevator") ||
    osmTagVal(alightA11y as IOsmA11y[], "elevator", "yes")
  )
    highlights.push("下車站附近有電梯");
  if (
    osmTagVal(boardA11y as IOsmA11y[], "toilets:wheelchair", "yes") ||
    osmTagVal(alightA11y as IOsmA11y[], "toilets:wheelchair", "yes")
  )
    highlights.push("站點附近有無障礙廁所");
  if (
    osmTagVal(boardA11y as IOsmA11y[], "tactile_paving", "yes") ||
    osmTagVal(alightA11y as IOsmA11y[], "tactile_paving", "yes")
  )
    highlights.push("附近有導盲磚");
  if (
    osmTagVal(boardA11y as IOsmA11y[], "traffic_signals:sound", "yes") ||
    osmTagVal(alightA11y as IOsmA11y[], "traffic_signals:sound", "yes")
  )
    highlights.push("附近有音響號誌");
  if (osmTagVal(boardA11y as IOsmA11y[], "wheelchair", "yes"))
    highlights.push("乘車站設施完善");
  if (osmTagVal(alightA11y as IOsmA11y[], "wheelchair", "yes"))
    highlights.push("下車站設施完善");

  const metroPolyline: [number, number][] = orderedSeq
    .map((s) => {
      const doc = [...originStations, ...destStations].find(
        (d) => d.stationUid === `${railSystem}-${s.StationID}`,
      );
      return doc?.location.coordinates as [number, number] | undefined;
    })
    .filter((c): c is [number, number] => !!c);

  const totalMinutes = Math.round(
    walkTo.durationSec / 60 +
      waitMinutes +
      rideMinutes +
      walkFrom.durationSec / 60,
  );

  const metroLeg: MetroLeg = {
    type: "METRO",
    railSystem,
    lineId: metroLineCode(railSystem, lineUid),
    lineName: lineUid,
    lineUid,
    departureStation: boardStation.stationName.Zh_tw,
    arrivalStation: alightStation.stationName.Zh_tw,
    departureStationUid: boardStation.stationUid,
    arrivalStationUid: alightStation.stationUid,
    direction,
    stopsCount: orderedSeq.length - 1,
    rideMinutes,
    waitInfo,
    estimatedWaitMinutes: waitMinutes,
    polyline: metroPolyline,
    departureStationA11y: boardA11y as IOsmA11y[],
    arrivalStationA11y: alightA11y as IOsmA11y[],
    facilityHighlights,
  };

  return {
    routeId: `METRO-${boardStation.stationUid}-${alightStation.stationUid}`,
    routeName: `${railSystem} ${boardStation.stationName.Zh_tw} → ${alightStation.stationName.Zh_tw}`,
    totalMinutes,
    transferCount: 0,
    legs: [
      {
        type: "WALK",
        from: "出發地",
        to: boardStation.stationName.Zh_tw,
        distanceM: Math.round(walkTo.distanceM),
        minutesEst: Math.round(walkTo.durationSec / 60),
        polyline: walkTo.polyline,
        a11yFacilities: boardA11y as IOsmA11y[],
      },
      metroLeg,
      {
        type: "WALK",
        from: alightStation.stationName.Zh_tw,
        to: "目的地",
        distanceM: Math.round(walkFrom.distanceM),
        minutesEst: Math.round(walkFrom.durationSec / 60),
        polyline: walkFrom.polyline,
        a11yFacilities: alightA11y as IOsmA11y[],
      },
    ],
    accessibilityHighlights: highlights,
  };
}

const timetableCache = new Map<string, { data: any; expiresAt: number }>();

function getCachedTimetable<T>(key: string): T | null {
  const entry = timetableCache.get(key);
  if (!entry || Date.now() > entry.expiresAt) {
    timetableCache.delete(key);
    return null;
  }
  return entry.data as T;
}
function setCachedTimetable(key: string, data: any): void {
  timetableCache.set(key, { data, expiresAt: Date.now() + 2 * 60 * 60 * 1000 });
}

async function fetchWithCache<T>(
  url: string,
  cacheKey: string,
): Promise<T | null> {
  const cached = getCachedTimetable<T>(cacheKey);
  if (cached) return cached;
  const resp = await tdxFetch(url);
  if (!resp.ok) return null;
  const data = (await resp.json()) as T;
  setCachedTimetable(cacheKey, data);
  return data;
}

function timeToMins(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

const DOW_KEYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

async function findNextThsrTrain(
  originStationID: string,
  destStationID: string,
): Promise<{
  trainNo: string;
  departureTime: string;
  arrivalTime: string;
  rideMinutes: number;
  waitMinutes: number;
} | null> {
  try {
    const url =
      `${thsrUrl.generalTimetableUrl}?$format=JSON&$top=200` +
      `&$filter=GeneralTimetable/StopTimes/any(s:s/StationID eq '${originStationID}')`;
    const cacheKey = `THSR|${originStationID}`;
    const raw = await fetchWithCache<TdxThsrGeneralTimetableItem[]>(
      url,
      cacheKey,
    );
    if (!Array.isArray(raw) || !raw.length) return null;
    const data = raw.filter((item) =>
      item.GeneralTimetable.StopTimes.some(
        (s) => s.StationID === destStationID,
      ),
    );
    if (!data.length) return null;

    const now = new Date();
    const todayKey = DOW_KEYS[taipeiWeekday(now)];
    const nowMins = taipeiMinutesOfDay(now);

    let best: {
      trainNo: string;
      departureTime: string;
      arrivalTime: string;
      rideMinutes: number;
      waitMinutes: number;
    } | null = null;
    let bestArr = Infinity;

    for (const item of data) {
      const gt = item.GeneralTimetable;
      if (gt.ServiceDay && !gt.ServiceDay[todayKey]) continue;

      const originStops = gt.StopTimes.filter(
        (s) => s.StationID === originStationID,
      );
      const destStops = gt.StopTimes.filter(
        (s) => s.StationID === destStationID,
      );

      for (const o of originStops) {
        const depMins = timeToMins(o.DepartureTime);
        if (Number.isNaN(depMins)) continue;
        const diff = depMins - nowMins;
        if (diff < -30) continue;

        let chosen: (typeof destStops)[number] | null = null;
        let chosenArr = Infinity;
        for (const d of destStops) {
          if (d.StopSequence <= o.StopSequence) continue;
          const arrRaw = timeToMins(d.ArrivalTime);
          if (Number.isNaN(arrRaw)) continue;
          const effArr = arrRaw >= depMins ? arrRaw : arrRaw + 1440;
          if (effArr < chosenArr) {
            chosenArr = effArr;
            chosen = d;
          }
        }
        if (!chosen) continue;

        if (chosenArr < bestArr) {
          bestArr = chosenArr;
          best = {
            trainNo: gt.GeneralTrainInfo.TrainNo,
            departureTime: o.DepartureTime,
            arrivalTime: chosen.ArrivalTime,
            rideMinutes: chosenArr - depMins,
            waitMinutes: Math.max(0, diff),
          };
        }
      }
    }
    return best;
  } catch {
    return null;
  }
}

async function buildThsrCandidate(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  mode: AccessibilityMode = "normal",
): Promise<AccessibleRoute | null> {
  const originCoords: [number, number] = [origin.lng, origin.lat];
  const destCoords: [number, number] = [destination.lng, destination.lat];

  const [originStations, destStations] = await Promise.all([
    TrainStationModel.find({
      ...nearQuery(originCoords, 3000),
      railSystem: "THSR",
    })
      .limit(3)
      .lean<ITdxTrainStation[]>(),
    TrainStationModel.find({
      ...nearQuery(destCoords, 3000),
      railSystem: "THSR",
    })
      .limit(3)
      .lean<ITdxTrainStation[]>(),
  ]);
  if (!originStations.length || !destStations.length) return null;

  const boardStation = originStations[0];
  const alightStation = destStations[0];
  if (boardStation.stationUID === alightStation.stationUID) return null;

  const trainInfo = await findNextThsrTrain(
    boardStation.stationID,
    alightStation.stationID,
  );
  if (!trainInfo) return null;

  const boardCoords = boardStation.location.coordinates as [number, number];
  const alightCoords = alightStation.location.coordinates as [number, number];

  const [walkTo, walkFrom, boardA11y, alightA11y] = await Promise.all([
    orsWalkingRoute(originCoords, boardCoords, mode),
    orsWalkingRoute(alightCoords, destCoords, mode),
    OsmA11y.find(nearQuery(boardCoords, 300)).limit(5).lean(),
    OsmA11y.find(nearQuery(alightCoords, 300)).limit(5).lean(),
  ]);

  const waitInfo: WaitInfo = {
    time: trainInfo.departureTime,
    source: "schedule",
  };
  const totalMinutes = Math.round(
    walkTo.durationSec / 60 +
      trainInfo.waitMinutes +
      trainInfo.rideMinutes +
      walkFrom.durationSec / 60,
  );

  const osmTagVal = (nodes: IOsmA11y[], key: string, val: string) =>
    nodes.some((f) => f.tags?.[key] === val);

  const facilityHighlights: string[] = [
    "高鐵站設有無障礙設施",
    "列車備有無障礙座位及輪椅空間",
  ];
  if (
    boardA11y.some((f: any) => f.category === "elevator") ||
    osmTagVal(boardA11y as IOsmA11y[], "elevator", "yes")
  )
    facilityHighlights.push("乘車站附近有電梯");
  if (
    alightA11y.some((f: any) => f.category === "elevator") ||
    osmTagVal(alightA11y as IOsmA11y[], "elevator", "yes")
  )
    facilityHighlights.push("下車站附近有電梯");
  if (
    osmTagVal(boardA11y as IOsmA11y[], "toilets:wheelchair", "yes") ||
    osmTagVal(alightA11y as IOsmA11y[], "toilets:wheelchair", "yes")
  )
    facilityHighlights.push("站點附近有無障礙廁所");
  if (
    osmTagVal(boardA11y as IOsmA11y[], "tactile_paving", "yes") ||
    osmTagVal(alightA11y as IOsmA11y[], "tactile_paving", "yes")
  )
    facilityHighlights.push("附近有導盲磚");
  if (osmTagVal(boardA11y as IOsmA11y[], "wheelchair", "yes"))
    facilityHighlights.push("乘車站設施完善");
  if (osmTagVal(alightA11y as IOsmA11y[], "wheelchair", "yes"))
    facilityHighlights.push("下車站設施完善");

  const thsrLeg: ThsrLeg = {
    type: "THSR",
    trainNo: trainInfo.trainNo,
    departureStation: boardStation.stationName.Zh_tw,
    arrivalStation: alightStation.stationName.Zh_tw,
    departureStationUID: boardStation.stationUID,
    arrivalStationUID: alightStation.stationUID,
    departureTime: trainInfo.departureTime,
    arrivalTime: trainInfo.arrivalTime,
    rideMinutes: trainInfo.rideMinutes,
    waitInfo,
    estimatedWaitMinutes: trainInfo.waitMinutes,
    polyline: [boardCoords, alightCoords],
    departureStationA11y: boardA11y as IOsmA11y[],
    arrivalStationA11y: alightA11y as IOsmA11y[],
    facilityHighlights,
  };

  return {
    routeId: `THSR-${boardStation.stationID}-${alightStation.stationID}`,
    routeName: `高鐵 ${boardStation.stationName.Zh_tw} → ${alightStation.stationName.Zh_tw}`,
    totalMinutes,
    transferCount: 0,
    legs: [
      {
        type: "WALK",
        from: "出發地",
        to: boardStation.stationName.Zh_tw,
        distanceM: Math.round(walkTo.distanceM),
        minutesEst: Math.round(walkTo.durationSec / 60),
        polyline: walkTo.polyline,
        a11yFacilities: boardA11y as IOsmA11y[],
      },
      thsrLeg,
      {
        type: "WALK",
        from: alightStation.stationName.Zh_tw,
        to: "目的地",
        distanceM: Math.round(walkFrom.distanceM),
        minutesEst: Math.round(walkFrom.durationSec / 60),
        polyline: walkFrom.polyline,
        a11yFacilities: alightA11y as IOsmA11y[],
      },
    ],
    accessibilityHighlights: facilityHighlights,
  };
}

async function findNextTraTrain(
  originStationID: string,
  destStationID: string,
): Promise<{
  trainNo: string;
  trainTypeName: string;
  departureTime: string;
  arrivalTime: string;
  rideMinutes: number;
  waitMinutes: number;
} | null> {
  try {
    const url =
      `${traUrl.generalTimetableUrl}?$format=JSON` +
      `&$filter=GeneralTimetable/StopTimes/any(s:s/StationID eq '${originStationID}')`;
    const cacheKey = `TRA|${originStationID}`;
    const raw = await fetchWithCache<TdxTraGeneralTimetableItem[]>(
      url,
      cacheKey,
    );
    if (!Array.isArray(raw) || !raw.length) return null;
    const data = raw.filter((item) =>
      item.GeneralTimetable.StopTimes.some(
        (s) => s.StationID === destStationID,
      ),
    );
    if (!data.length) return null;

    const now = new Date();
    const todayKey = DOW_KEYS[taipeiWeekday(now)];
    const nowMins = taipeiMinutesOfDay(now);

    let best: {
      trainNo: string;
      trainTypeName: string;
      departureTime: string;
      arrivalTime: string;
      rideMinutes: number;
      waitMinutes: number;
    } | null = null;
    let bestArr = Infinity;

    for (const item of data) {
      const gt = item.GeneralTimetable;
      if (gt.ServiceDay && !gt.ServiceDay[todayKey]) continue;
      const originStops = gt.StopTimes.filter(
        (s) => s.StationID === originStationID,
      );
      const destStops = gt.StopTimes.filter(
        (s) => s.StationID === destStationID,
      );

      for (const o of originStops) {
        const depMins = timeToMins(o.DepartureTime);
        if (Number.isNaN(depMins)) continue;
        const diff = depMins - nowMins;
        if (diff < -30) continue;

        let chosen: (typeof destStops)[number] | null = null;
        let chosenArr = Infinity;
        for (const d of destStops) {
          if (d.StopSequence <= o.StopSequence) continue;
          const arrRaw = timeToMins(d.ArrivalTime);
          if (Number.isNaN(arrRaw)) continue;
          const effArr = arrRaw >= depMins ? arrRaw : arrRaw + 1440;
          if (effArr < chosenArr) {
            chosenArr = effArr;
            chosen = d;
          }
        }
        if (!chosen) continue;

        if (chosenArr < bestArr) {
          bestArr = chosenArr;
          best = {
            trainNo: gt.GeneralTrainInfo.TrainNo,
            trainTypeName: gt.GeneralTrainInfo.TrainTypeName?.Zh_tw ?? "列車",
            departureTime: o.DepartureTime,
            arrivalTime: chosen.ArrivalTime,
            rideMinutes: chosenArr - depMins,
            waitMinutes: Math.max(0, diff),
          };
        }
      }
    }
    return best;
  } catch {
    return null;
  }
}

async function buildTraCandidate(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  mode: AccessibilityMode = "normal",
): Promise<AccessibleRoute | null> {
  const originCoords: [number, number] = [origin.lng, origin.lat];
  const destCoords: [number, number] = [destination.lng, destination.lat];

  const [originStations, destStations] = await Promise.all([
    TrainStationModel.find({
      ...nearQuery(originCoords, 1500),
      railSystem: "TRA",
    })
      .limit(3)
      .lean<ITdxTrainStation[]>(),
    TrainStationModel.find({
      ...nearQuery(destCoords, 1500),
      railSystem: "TRA",
    })
      .limit(3)
      .lean<ITdxTrainStation[]>(),
  ]);
  if (!originStations.length || !destStations.length) return null;

  const boardStation = originStations[0];
  const alightStation = destStations[0];
  if (boardStation.stationUID === alightStation.stationUID) return null;

  const trainInfo = await findNextTraTrain(
    boardStation.stationID,
    alightStation.stationID,
  );
  if (!trainInfo) return null;

  const boardCoords = boardStation.location.coordinates as [number, number];
  const alightCoords = alightStation.location.coordinates as [number, number];

  const [walkTo, walkFrom, boardA11y, alightA11y] = await Promise.all([
    orsWalkingRoute(originCoords, boardCoords, mode),
    orsWalkingRoute(alightCoords, destCoords, mode),
    OsmA11y.find(nearQuery(boardCoords, 300)).limit(5).lean(),
    OsmA11y.find(nearQuery(alightCoords, 300)).limit(5).lean(),
  ]);

  const waitInfo: WaitInfo = {
    time: trainInfo.departureTime,
    source: "schedule",
  };
  const totalMinutes = Math.round(
    walkTo.durationSec / 60 +
      trainInfo.waitMinutes +
      trainInfo.rideMinutes +
      walkFrom.durationSec / 60,
  );

  const osmTagVal = (nodes: IOsmA11y[], key: string, val: string) =>
    nodes.some((f) => f.tags?.[key] === val);

  const facilityHighlights: string[] = [`臺鐵${trainInfo.trainTypeName} 列車`];
  if (
    boardA11y.some((f: any) => f.category === "elevator") ||
    osmTagVal(boardA11y as IOsmA11y[], "elevator", "yes")
  )
    facilityHighlights.push("乘車站附近有電梯");
  if (
    alightA11y.some((f: any) => f.category === "elevator") ||
    osmTagVal(alightA11y as IOsmA11y[], "elevator", "yes")
  )
    facilityHighlights.push("下車站附近有電梯");
  if (
    osmTagVal(boardA11y as IOsmA11y[], "toilets:wheelchair", "yes") ||
    osmTagVal(alightA11y as IOsmA11y[], "toilets:wheelchair", "yes")
  )
    facilityHighlights.push("站點附近有無障礙廁所");
  if (
    osmTagVal(boardA11y as IOsmA11y[], "tactile_paving", "yes") ||
    osmTagVal(alightA11y as IOsmA11y[], "tactile_paving", "yes")
  )
    facilityHighlights.push("附近有導盲磚");
  if (osmTagVal(boardA11y as IOsmA11y[], "wheelchair", "yes"))
    facilityHighlights.push("乘車站設施完善");
  if (osmTagVal(alightA11y as IOsmA11y[], "wheelchair", "yes"))
    facilityHighlights.push("下車站設施完善");

  const traLeg: TraLeg = {
    type: "TRA",
    trainNo: trainInfo.trainNo,
    trainTypeName: trainInfo.trainTypeName,
    departureStation: boardStation.stationName.Zh_tw,
    arrivalStation: alightStation.stationName.Zh_tw,
    departureStationUID: boardStation.stationUID,
    arrivalStationUID: alightStation.stationUID,
    departureTime: trainInfo.departureTime,
    arrivalTime: trainInfo.arrivalTime,
    rideMinutes: trainInfo.rideMinutes,
    waitInfo,
    estimatedWaitMinutes: trainInfo.waitMinutes,
    polyline: [boardCoords, alightCoords],
    departureStationA11y: boardA11y as IOsmA11y[],
    arrivalStationA11y: alightA11y as IOsmA11y[],
    facilityHighlights,
  };

  return {
    routeId: `TRA-${boardStation.stationID}-${alightStation.stationID}`,
    routeName: `臺鐵${trainInfo.trainTypeName} ${boardStation.stationName.Zh_tw} → ${alightStation.stationName.Zh_tw}`,
    totalMinutes,
    transferCount: 0,
    legs: [
      {
        type: "WALK",
        from: "出發地",
        to: boardStation.stationName.Zh_tw,
        distanceM: Math.round(walkTo.distanceM),
        minutesEst: Math.round(walkTo.durationSec / 60),
        polyline: walkTo.polyline,
        a11yFacilities: boardA11y as IOsmA11y[],
      },
      traLeg,
      {
        type: "WALK",
        from: alightStation.stationName.Zh_tw,
        to: "目的地",
        distanceM: Math.round(walkFrom.distanceM),
        minutesEst: Math.round(walkFrom.durationSec / 60),
        polyline: walkFrom.polyline,
        a11yFacilities: alightA11y as IOsmA11y[],
      },
    ],
    accessibilityHighlights: facilityHighlights,
  };
}

function collectRouteFacilities(r: AccessibleRoute): IOsmA11y[] {
  return r.legs.flatMap((leg) => {
    if (leg.type === "WALK") return leg.a11yFacilities;
    if (leg.type === "BUS")
      return [...leg.departureStopA11y, ...leg.arrivalStopA11y];
    if (leg.type === "METRO")
      return [...leg.departureStationA11y, ...leg.arrivalStationA11y];
    if (leg.type === "THSR")
      return [...leg.departureStationA11y, ...leg.arrivalStationA11y];
    if (leg.type === "TRA")
      return [...leg.departureStationA11y, ...leg.arrivalStationA11y];
    return [];
  });
}

/**
 * Total walking distance across all WALK legs, in metres — drives the
 * walk-distance penalty in scoring/ranking and is surfaced on the route.
 *
 * @param r Route to measure.
 * @returns Total walk distance in metres.
 */
function totalWalkDistanceM(r: AccessibleRoute): number {
  return r.legs.reduce(
    (sum, leg) => (leg.type === "WALK" ? sum + leg.distanceM : sum),
    0,
  );
}

/**
 * Fraction of legs that carry ANY accessibility evidence (OSM a11y nodes or
 * facility highlights) — feeds dataConfidence so missing data is flagged as
 * uncertainty, not scored as bad.
 *
 * @param r Route to inspect.
 * @returns Coverage ratio in [0, 1].
 */
function legDataCoverageRatio(r: AccessibleRoute): number {
  if (!r.legs.length) return 1;
  let withData = 0;
  for (const leg of r.legs) {
    if (leg.type === "WALK") {
      if (leg.a11yFacilities.length) withData++;
    } else if (leg.type === "BUS") {
      if (leg.departureStopA11y.length || leg.arrivalStopA11y.length) withData++;
    } else if (
      leg.departureStationA11y.length ||
      leg.arrivalStationA11y.length ||
      leg.facilityHighlights.length
    ) {
      withData++;
    }
  }
  return withData / r.legs.length;
}

/**
 * Score every candidate route with the evidence-based scoring engine
 * (accessibility 65% / travel time 35%) and rank them by mode-aware route cost.
 *
 * @param routes Candidate routes to score and rank.
 * @param mode Accessibility mode driving the cost weights. Default "normal".
 * @returns The routes sorted by ascending cost (best first), with score
 *   metadata attached to each.
 */
export function scoreAndRank(
  routes: AccessibleRoute[],
  mode: AccessibilityMode = "normal",
): AccessibleRoute[] {
  const maxTime = Math.max(...routes.map((r) => r.totalMinutes), 1);
  const minTime = Math.min(...routes.map((r) => r.totalMinutes), maxTime);

  return routes
    .map((r) => {
      const facilities = collectRouteFacilities(r);
      const walkDistanceM = totalWalkDistanceM(r);
      const result = scoreRoute(
        facilities,
        r.totalMinutes,
        maxTime,
        minTime,
        r.accessibilityHighlights.length,
        mode,
        walkDistanceM,
        legDataCoverageRatio(r),
      );
      r.accessibilityScore = result.totalScore;
      r.accessibilityLabel = result.label;
      r.scoreComponents = result.components;
      r.dataConfidence = result.dataConfidence;
      r.scoreWarnings = result.warnings;
      r.totalWalkDistanceM = walkDistanceM;
      return {
        route: r,
        cost: routeCost(
          r.totalMinutes,
          r.transferCount,
          result.totalScore,
          mode,
          walkDistanceM,
        ),
      };
    })
    .sort((a, b) => a.cost - b.cost)
    .map((s) => s.route);
}

/**
 * Stage-1 pre-ranking for the two-stage pipeline: order candidates by a cheap,
 * accessibility-aware proxy (time + transfers + walk distance) that needs NO OSM
 * data, so the top-N can be enriched before the real scoreRoute runs. Without
 * this, scoring ran on the un-enriched candidate set (facility data still empty)
 * and the accessibility budget collapsed to pure travel time.
 *
 * @param routes Candidate routes.
 * @param mode Accessibility mode driving the proxy penalties.
 * @returns Routes sorted by ascending proxy cost (best first).
 */
function prerankByProxy(
  routes: AccessibleRoute[],
  mode: AccessibilityMode,
): AccessibleRoute[] {
  return routes
    .map((r) => ({
      route: r,
      cost: prerankCost(
        r.totalMinutes,
        r.transferCount,
        totalWalkDistanceM(r),
        mode,
      ),
    }))
    .sort((a, b) => a.cost - b.cost)
    .map((s) => s.route);
}

/**
 * True when a walk leg passes a confirmed stairs-only barrier.
 *
 * @param leg Walk leg to inspect.
 * @returns Whether the leg crosses a stairs-only barrier.
 */
function walkLegHasStairsBarrier(leg: WalkLeg): boolean {
  return leg.a11yFacilities.some(
    (f) =>
      f.tags?.["highway"] === "steps" &&
      f.tags?.["ramp:wheelchair"] !== "yes" &&
      f.tags?.["wheelchair"] !== "yes",
  );
}

/**
 * Tier-1 exclusion for wheelchair mode: a route is excluded when a rail leg has
 * facility data but no elevator mention, or a walk leg passes a stairs-only
 * barrier. Legs with NO facility data are tolerated (unknown ≠ inaccessible) —
 * over-excluding on missing data would 404 most queries.
 *
 * @param route Route to evaluate.
 * @param mode Accessibility mode; exclusion only applies when its profile
 *   requires Tier 1 features.
 * @returns Whether the route should be excluded.
 */
function isRouteExcluded(
  route: AccessibleRoute,
  mode: AccessibilityMode,
): boolean {
  if (!(MODE_PROFILES[mode] ?? MODE_PROFILES.normal).tier1Required)
    return false;

  for (const leg of route.legs) {
    if (leg.type === "WALK") {
      if (walkLegHasStairsBarrier(leg)) return true;
      continue;
    }
    if (leg.type === "BUS") continue;
    if (leg.facilityHighlights.length > 0) {
      const text = leg.facilityHighlights.join("|");
      if (!text.includes("電梯")) return true;
      if (/電梯[^|]*(維修|故障|暫停)/.test(text)) return true;
    }
  }
  return false;
}

/**
 * Apply wheelchair Tier-1 exclusion with a graceful fallback: when EVERY
 * candidate would be excluded, return the originals (a risky route beats a
 * 404) — the low accessibility score + warnings still signal the risk.
 *
 * @param routes Candidate routes to filter.
 * @param mode Accessibility mode driving the exclusion.
 * @returns The kept routes, or all originals when none survive.
 */
function applyModeExclusion(
  routes: AccessibleRoute[],
  mode: AccessibilityMode,
): AccessibleRoute[] {
  const kept = routes.filter((r) => !isRouteExcluded(r, mode));
  return kept.length ? kept : routes;
}

function transitLegKey(leg: BusLeg | MetroLeg | ThsrLeg | TraLeg): string {
  switch (leg.type) {
    case "BUS":
      return `BUS|${leg.routeName}|${leg.departureStop}|${leg.arrivalStop}|${leg.direction}`;
    case "METRO":
      return `METRO|${leg.railSystem}|${leg.departureStationUid}|${leg.arrivalStationUid}`;
    case "THSR":
      return `THSR|${leg.departureStationUID}|${leg.arrivalStationUID}`;
    case "TRA":
      return `TRA|${leg.departureStationUID}|${leg.arrivalStationUID}`;
  }
}

function buildRouteKey(r: AccessibleRoute): string {
  const transitLegs = r.legs.filter(
    (l): l is BusLeg | MetroLeg | ThsrLeg | TraLeg => l.type !== "WALK",
  );
  if (transitLegs.length === 0) return "";
  return transitLegs.map(transitLegKey).join("::");
}

function deduplicateRoutes(routes: AccessibleRoute[]): AccessibleRoute[] {
  const seen = new Set<string>();
  return routes.filter((r) => {
    const key = buildRouteKey(r);
    if (key === "") return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Cross-planner normalization key: the GTFS graph and the TDX hosted engine can
 * emit the SAME bus line snapped to different stop pairs, which survives the
 * stop-level dedup above as two near-identical candidates. Keys a bus leg at the
 * line level (routeName + direction); rail legs keep their stop-pair identity.
 *
 * @param leg Transit leg to derive a logical key for.
 * @returns The logical leg key.
 */
function logicalLegKey(leg: BusLeg | MetroLeg | ThsrLeg | TraLeg): string {
  return leg.type === "BUS"
    ? `BUS|${leg.routeName}|${leg.direction}`
    : transitLegKey(leg);
}

function collapseLogicalDuplicates(
  routes: AccessibleRoute[],
): AccessibleRoute[] {
  const best = new Map<string, AccessibleRoute>();
  const walkOnly: AccessibleRoute[] = [];
  for (const r of routes) {
    const transitLegs = r.legs.filter(
      (l): l is BusLeg | MetroLeg | ThsrLeg | TraLeg => l.type !== "WALK",
    );
    if (!transitLegs.length) {
      walkOnly.push(r);
      continue;
    }
    const key = transitLegs.map(logicalLegKey).join("::");
    const prev = best.get(key);
    if (!prev || r.totalMinutes < prev.totalMinutes) best.set(key, r);
  }
  return [...best.values(), ...walkOnly];
}

/**
 * Unified a11y enrichment over the FINAL top routes. Planners that skip internal
 * enrichment (OTP) get their transit legs' OsmA11y arrays, route highlights and
 * rail-leg indoor guidance filled here, so per-request Mongo work is top-3 ×
 * stops instead of every-candidate × stops. Legs already enriched by their
 * planner are left untouched. Best-effort and non-throwing.
 *
 * @param routes Top routes to enrich in place.
 * @param origin Journey origin coordinates.
 * @param destination Journey destination coordinates.
 * @param mode Accessibility mode used for indoor guidance.
 */
async function enrichTopRoutes(
  routes: AccessibleRoute[],
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  mode: AccessibilityMode,
): Promise<void> {
  const { nearbyA11y, attachA11yToLeg, deriveHighlights, enrichLegIndoor } =
    await import("./planners/route-a11y");

  const originCoords: [number, number] = [origin.lng, origin.lat];
  const destCoords: [number, number] = [destination.lng, destination.lat];

  const legA11y = (leg: BusLeg | MetroLeg | ThsrLeg | TraLeg) =>
    leg.type === "BUS"
      ? { board: leg.departureStopA11y, alight: leg.arrivalStopA11y }
      : { board: leg.departureStationA11y, alight: leg.arrivalStationA11y };

  await Promise.all(
    routes.map(async (route) => {
      const transitLegs = route.legs.filter(
        (l): l is BusLeg | MetroLeg | ThsrLeg | TraLeg => l.type !== "WALK",
      );
      if (!transitLegs.length) return;

      await Promise.all(
        transitLegs.map(async (leg) => {
          const { board, alight } = legA11y(leg);
          const boardCoords = leg.polyline[0];
          const alightCoords = leg.polyline[leg.polyline.length - 1];
          if (
            (!board.length || !alight.length) &&
            boardCoords &&
            alightCoords
          ) {
            const [boardA11y, alightA11y] = await Promise.all([
              board.length ? Promise.resolve(board) : nearbyA11y(boardCoords),
              alight.length
                ? Promise.resolve(alight)
                : nearbyA11y(alightCoords),
            ]);
            attachA11yToLeg(leg, boardA11y, alightA11y);
          }

          if (
            leg.type !== "BUS" &&
            leg.facilityHighlights.length === 0 &&
            boardCoords &&
            alightCoords
          ) {
            const legIdx = route.legs.indexOf(leg);
            const prev = route.legs[legIdx - 1];
            const next = route.legs[legIdx + 1];
            await enrichLegIndoor(
              leg,
              prev?.type === "WALK" ? prev : null,
              next?.type === "WALK" ? next : null,
              originCoords,
              destCoords,
              boardCoords,
              alightCoords,
              mode,
            );
          }
        }),
      );

      if (!route.accessibilityHighlights.length) {
        const { board } = legA11y(transitLegs[0]);
        const { alight } = legA11y(transitLegs[transitLegs.length - 1]);
        route.accessibilityHighlights = deriveHighlights(board, alight);
      }
    }),
  );
}

/**
 * Shared finalization: dedupe → cross-planner line-level collapse → mode
 * exclusion → mode-aware score + cost ranking → top 3 → unified a11y enrichment
 * (fail-soft) → realtime facility overlay (fail-soft) → realtime transit overlay
 * (bus ETA + TRA delays, fail-soft) → facility slimming (runs LAST so scoring
 * and the overlays see full documents).
 *
 * @param routes Candidate routes to finalize.
 * @param origin Journey origin coordinates.
 * @param destination Journey destination coordinates.
 * @param mode Accessibility mode for exclusion and scoring.
 * @param format Response shape; "compact" dedupes facilities route-level.
 * @param departureTime Departure time used by the realtime transit overlay.
 * @returns The top-3 finalized routes.
 */
async function finalizeRoutes(
  routes: AccessibleRoute[],
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  mode: AccessibilityMode,
  format: "standard" | "compact" = "standard",
  departureTime?: Date,
): Promise<AccessibleRoute[]> {
  const PRERANK_N = 8;
  const t: Record<string, number> = {};
  let t0 = Date.now();
  // Stage 1: cheap accessibility-aware proxy pre-rank (no OSM data) → top-N.
  const candidates = applyModeExclusion(
    collapseLogicalDuplicates(deduplicateRoutes(routes)),
    mode,
  );
  const topN = prerankByProxy(candidates, mode).slice(0, PRERANK_N);
  t.prerank = Date.now() - t0;
  t0 = Date.now();
  // Stage 2: a11y enrichment (Mongo) BEFORE scoring, so facility data is real
  // when scoreRoute runs — otherwise the accessibility budget collapses to 0.
  try {
    await enrichTopRoutes(topN, origin, destination, mode);
  } catch (err) {
    console.warn("[accessible-route] top-N a11y enrichment failed", err);
  }
  t.enrich = Date.now() - t0;
  t0 = Date.now();
  // Stage 3: score with the enriched facility data + rank → final top-3.
  const top = scoreAndRank(topN, mode).slice(0, 3);
  t.rank = Date.now() - t0;
  t0 = Date.now();
  try {
    const { overlayFacilityStatus } =
      await import("./planners/facility-status");
    await overlayFacilityStatus(top, mode);
  } catch (err) {
    console.warn("[accessible-route] facility status overlay failed", err);
  }
  t.facilityOverlay = Date.now() - t0;
  t0 = Date.now();
  try {
    const { overlayRealtimeTransit, recoverRailTrainNos, annotateBusTdxCity } =
      await import("./planners/realtime-transit");
    annotateBusTdxCity(top);
    await recoverRailTrainNos(top).catch(() => undefined);
    await overlayRealtimeTransit(top, { departureTime });
  } catch (err) {
    console.warn("[accessible-route] realtime transit overlay failed", err);
  }
  t.realtimeOverlay = Date.now() - t0;
  slimRoutes(top);
  if (format === "compact") compactRoutes(top);
  console.log("[route-timing] finalize", JSON.stringify(t));
  return top;
}

/**
 * Shadow-mode diff line: one parseable log entry per request comparing OTP's
 * candidates with the merged baseline (null baseline = legacy path, where only
 * OTP's side is known). grep "[otp-shadow]" to collect.
 *
 * @param otpRoutes Routes produced by the OTP planner.
 * @param baseline The merged baseline routes, or null on the legacy path.
 */
function logOtpShadowDiff(
  otpRoutes: AccessibleRoute[],
  baseline: AccessibleRoute[] | null,
): void {
  const summarize = (rs: AccessibleRoute[]) =>
    rs.map(
      (r) =>
        `${r.routeId}|${r.routeName}|${r.totalMinutes}m|x${r.transferCount}${r.departureDate ? `|${r.departureDate}` : ""}`,
    );
  console.log(
    "[otp-shadow]",
    JSON.stringify({
      otpCount: otpRoutes.length,
      baselineCount: baseline?.length ?? null,
      otp: summarize(otpRoutes),
      baseline: baseline ? summarize(baseline) : null,
    }),
  );
}

/**
 * City of a coordinate from the nearest imported bus stop (~10ms local Mongo
 * lookup) instead of Google reverse geocoding (~200–800ms external call).
 *
 * @param lat Latitude.
 * @param lng Longitude.
 * @returns The city name, or null when the DB has no stops (caller falls back
 *   to Google).
 */
export async function resolveCityFromStops(
  lat: number,
  lng: number,
): Promise<string | null> {
  try {
    const stop = await BusStopModel.findOne(nearQuery([lng, lat], 50_000))
      .select("city")
      .lean<{ city?: string }>();
    return stop?.city ?? null;
  } catch {
    return null;
  }
}

export async function planAccessibleRouteFromRequest(
  body: PlanRouteRequest,
): Promise<PlanRouteResult> {
  let { origin, destination } = body;
  const { query, userLocation, maxTransfers, departureTime, format } = body;
  let mode = body.mode;

  let intent: RouteIntent | null = null;
  if (query && (!origin || !destination)) {
    try {
      intent = await parseRouteIntent(query);
    } catch (err) {
      console.error("[accessible-route] intent parsing failed", err);
      return {
        ok: false,
        status: ResponseCode.INTERNAL_ERROR,
        error:
          "語意解析服務暫時無法使用，請稍後再試或直接提供 origin/destination",
      };
    }
    if (!intent) {
      return {
        ok: false,
        status: ResponseCode.INVALID_INPUT,
        error: ERROR_MESSAGE.INTENT_PARSE_FAILED,
      };
    }
    origin =
      intent.from === "current_location"
        ? userLocation ?? undefined
        : intent.from;
    destination = intent.to;
    mode = mode ?? intent.mode;
    if (!origin) {
      return {
        ok: false,
        status: ResponseCode.INVALID_INPUT,
        error: "查詢使用了『目前位置』，請一併提供 userLocation 座標",
      };
    }
  }

  if (!origin || !destination) {
    return {
      ok: false,
      status: ResponseCode.INVALID_INPUT,
      error: `${ERROR_MESSAGE.MISSING_PARAMS}：origin, destination`,
    };
  }

  const [originCoords, destCoords] = await Promise.all([
    typeof origin === "string"
      ? getCoordinates(origin)
      : Promise.resolve(origin as { latitude: number; longitude: number }),
    typeof destination === "string"
      ? getCoordinates(destination)
      : Promise.resolve(destination as { latitude: number; longitude: number }),
  ]);

  if (!originCoords || !destCoords) {
    return {
      ok: false,
      status: ResponseCode.INVALID_INPUT,
      error: "無法解析出發地或目的地座標",
    };
  }

  const lat = originCoords.latitude;
  const lng = originCoords.longitude;

  const city = ((await resolveCityFromStops(lat, lng)) ??
    (await getCity(lat, lng))) as TaiwanCityEn;

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
      format: format === "compact" ? "compact" : "standard",
    },
  );

  if (!routes.length) {
    return {
      ok: false,
      status: ResponseCode.NOT_FOUND,
      error:
        "找不到連通的公車或捷運路線，請嘗試擴大搜尋範圍或確認出發地/目的地",
    };
  }

  return {
    ok: true,
    data: {
      origin: { lat, lng },
      destination: { lat: destCoords.latitude, lng: destCoords.longitude },
      city,
      routes,
      ...(intent ? { intent } : {}),
    },
  };
}

export async function findAccessibleRoutes(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  city: TaiwanCityEn,
  opts: FindAccessibleRoutesOptions = {},
): Promise<AccessibleRoute[]> {
  const mode = opts.mode ?? "normal";
  const maxTransfers = opts.maxTransfers ?? 1;

  const geoQuery = (coord: { lat: number; lng: number }, dist: number) =>
    nearQuery([coord.lng, coord.lat], dist);

  const otpFlag = (process.env.USE_OTP_ROUTER ?? "false").toLowerCase();
  const otpMerged = otpFlag === "true";
  const otpShadow = otpFlag === "shadow";
  const otpPromise: Promise<AccessibleRoute[]> =
    otpMerged || otpShadow
      ? import("./planners/otp-routing")
          .then((m) =>
            m.planOtpRoute(origin, destination, {
              maxTransfers,
              mode,
              departureTime: opts.departureTime,
            }),
          )
          .catch((): AccessibleRoute[] => [])
      : Promise.resolve<AccessibleRoute[]>([]);

  if (otpMerged) {
    const planT: Record<string, number> = {};
    const timed = <T>(label: string, p: Promise<T>): Promise<T> => {
      const t0 = Date.now();
      return p.finally(() => {
        planT[label] = Date.now() - t0;
      });
    };
    const tdxRoutes =
      process.env.USE_TDX_ROUTING === "true"
        ? await timed(
            "tdx",
            import("./planners/tdx-routing")
              .then((m) =>
                m.planTdxRoute(origin, destination, {
                  departureTime: opts.departureTime,
                }),
              )
              .catch((): AccessibleRoute[] => []),
          )
        : [];
    const merged = [...tdxRoutes, ...(await timed("otp", otpPromise))];
    console.log("[route-timing] planners", JSON.stringify(planT));
    if (!merged.length) return [];
    return finalizeRoutes(
      merged,
      origin,
      destination,
      mode,
      opts.format,
      opts.departureTime,
    );
  }

  if (otpShadow) {
    otpPromise.then((otpRoutes) => logOtpShadowDiff(otpRoutes, null));
  }

  const busSearchPromise = (async (): Promise<AccessibleRoute[]> => {
    const [originStops, destStops] = await Promise.all([
      BusStopModel.find(geoQuery(origin, 400)).limit(20).lean<ITdxBusStop[]>(),
      BusStopModel.find(geoQuery(destination, 400))
        .limit(20)
        .lean<ITdxBusStop[]>(),
    ]);
    if (!originStops.length || !destStops.length) return [];

    const originRouteIds = new Set(originStops.flatMap((s) => s.subRouteIds));
    const destRouteIds = new Set(destStops.flatMap((s) => s.subRouteIds));
    const connecting = [...originRouteIds].filter((id) => destRouteIds.has(id));
    if (!connecting.length) return [];

    const candidates = await Promise.all(
      connecting.slice(0, 5).map((routeId) => {
        const originStop =
          originStops.find((s) => s.subRouteIds.includes(routeId)) ?? null;
        const destStop =
          destStops.find((s) => s.subRouteIds.includes(routeId)) ?? null;
        return buildCandidate(
          routeId,
          city,
          origin,
          destination,
          originStop,
          destStop,
          mode,
        );
      }),
    );
    return candidates.filter(Boolean) as AccessibleRoute[];
  })();

  const systems = CITY_METRO_SYSTEMS[city] ?? [];
  const metroPromises = systems.map((railSystem) =>
    buildMetroCandidate(railSystem, origin, destination, mode)
      .then((r): AccessibleRoute[] => (r ? [r] : []))
      .catch((): AccessibleRoute[] => []),
  );

  const thsrPromise = buildThsrCandidate(origin, destination, mode)
    .then((r): AccessibleRoute[] => (r ? [r] : []))
    .catch((): AccessibleRoute[] => []);

  const traPromise = buildTraCandidate(origin, destination, mode)
    .then((r): AccessibleRoute[] => (r ? [r] : []))
    .catch((): AccessibleRoute[] => []);

  const transferPromise = import("./transfer-finder")
    .then((m) => m.findTransferRoutes(origin, destination, city))
    .catch((): AccessibleRoute[] => []);

  const [busRoutes, ...allRailArrays] = await Promise.all([
    busSearchPromise,
    ...metroPromises,
    thsrPromise,
    traPromise,
  ]);
  const combined = [...busRoutes, ...allRailArrays.flat()];

  const transferRoutes = await transferPromise;
  const allRoutes = [...combined, ...transferRoutes];
  if (!allRoutes.length) return [];

  return finalizeRoutes(
    allRoutes,
    origin,
    destination,
    mode,
    opts.format,
    opts.departureTime,
  );
}
