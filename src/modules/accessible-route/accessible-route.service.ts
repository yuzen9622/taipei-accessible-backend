import { tdxFetch } from "../../config/fetch";
import { busUrl, metroUrl, thsrUrl, traUrl, CITY_METRO_SYSTEMS } from "../../config/transit";
import { getRouteDirectionImproved, equalStopName } from "../../config/lib";
import { orsWalkingRoute } from "../../config/ors";
import { scoreRoute } from "../../config/a11y-scoring";
import BusStopModel from "../../model/bus-stop.model";
import MetroStationModel from "../../model/metro-station.model";
import TrainStationModel from "../../model/train-station.model";
import OsmA11y from "../../model/osm-a11y.model";
import { IOsmA11y, ITdxBusStop, ITdxMetroStation, ITdxTrainStation } from "../../types";
import {
  BusRoute,
  BusRealTimeByFrequency,
  TdxMetroStationOfLine,
  TdxMetroS2STravelTimeRecord,
  TdxMetroFrequencyRecord,
  TdxMetroStationFacility,
  TdxThsrGeneralTimetableItem,
  TdxTraGeneralTimetableItem,
} from "../../types/transit";
import { TaiwanCityEn } from "../../types/transit";

// ─── Response types ──────────────────────────────────────────────────────────

export interface WaitInfo {
  minutes: number | null;
  source: "realtime" | "schedule" | "unavailable";
}

export interface NearestBus {
  plateNumb: string;
  position: [number, number];
  speed?: number;
  stopsAway?: number;
}

export interface WalkLeg {
  type: "WALK";
  from: string;
  to: string;
  distanceM: number;
  minutesEst: number;
  polyline: [number, number][]; // [[lng, lat], ...] GeoJSON order
  a11yFacilities: IOsmA11y[];
}

export interface BusLeg {
  type: "BUS";
  routeName: string;
  departureStop: string;
  arrivalStop: string;
  waitInfo: WaitInfo;
  estimatedWaitMinutes: number; // waitInfo.minutes ?? 0, kept for backwards compat
  direction: 0 | 1;
  polyline: [number, number][];
  departureStopA11y: IOsmA11y[];
  arrivalStopA11y: IOsmA11y[];
  nearestBus?: NearestBus;
}

export interface MetroLeg {
  type: "METRO";
  railSystem: string;
  lineName: string;
  lineUid: string;
  departureStation: string;
  arrivalStation: string;
  departureStationUid: string;
  arrivalStationUid: string;
  direction: 0 | 1;
  stopsCount: number;
  rideMinutes: number;
  waitInfo: WaitInfo;
  estimatedWaitMinutes: number;
  polyline: [number, number][];
  departureStationA11y: IOsmA11y[];
  arrivalStationA11y: IOsmA11y[];
  facilityHighlights: string[];
}

export interface ThsrLeg {
  type: "THSR";
  trainNo: string;
  departureStation: string;
  arrivalStation: string;
  departureStationUID: string;
  arrivalStationUID: string;
  departureTime: string;        // "HH:mm"
  arrivalTime: string;          // "HH:mm"
  rideMinutes: number;
  waitInfo: WaitInfo;
  estimatedWaitMinutes: number;
  polyline: [number, number][];
  departureStationA11y: IOsmA11y[];
  arrivalStationA11y: IOsmA11y[];
  facilityHighlights: string[];
}

export interface TraLeg {
  type: "TRA";
  trainNo: string;
  trainTypeName: string;        // e.g. "自強", "莒光", "區間車"
  departureStation: string;
  arrivalStation: string;
  departureStationUID: string;
  arrivalStationUID: string;
  departureTime: string;        // "HH:mm"
  arrivalTime: string;          // "HH:mm"
  rideMinutes: number;
  waitInfo: WaitInfo;
  estimatedWaitMinutes: number;
  polyline: [number, number][];
  departureStationA11y: IOsmA11y[];
  arrivalStationA11y: IOsmA11y[];
  facilityHighlights: string[];
}

export interface AccessibleRoute {
  routeId: string;
  routeName: string;
  totalMinutes: number;
  /** 0 = direct, 1 = one transfer */
  transferCount: number;
  legs: (WalkLeg | BusLeg | MetroLeg | ThsrLeg | TraLeg)[];
  accessibilityHighlights: string[];
  /** 0–100 evidence-based accessibility score. Set by scoreAndRank(). */
  accessibilityScore?: number;
  /** Semantic label for the score. Set by scoreAndRank(). */
  accessibilityLabel?: "excellent" | "good" | "fair" | "poor" | "critical";
  /** Score sub-components for debugging. Set by scoreAndRank(). */
  scoreComponents?: {
    facilityScore: number;
    timeScore: number;
    criticalFeatureScore: number;
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
  city: string
): Promise<BusRoute[]> {
  const url = `${busUrl.stopOfRouteUrl}/${city}?$format=JSON&$filter=SubRouteName/Zh_tw eq '${subRouteId}'`;
  const resp = await tdxFetch(url);
  if (!resp.ok) return [];
  return (await resp.json()) as BusRoute[];
}

// ─── ETA / Schedule ──────────────────────────────────────────────────────────

async function fetchScheduledWait(
  subRouteId: string,
  city: string,
  direction: number
): Promise<number | null> {
  try {
    const url = `${busUrl.cityScheduleUrl}/${city}/${subRouteId}?$format=JSON`;
    const resp = await tdxFetch(url);
    if (!resp.ok) return null;
    const data = (await resp.json()) as any[];
    if (!Array.isArray(data) || !data.length) return null;

    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    let nearest: number | null = null;

    for (const entry of data) {
      if (entry.Direction !== direction) continue;
      for (const timetable of entry.Timetables ?? []) {
        for (const trip of timetable.Trips ?? []) {
          const firstStop = trip.StopTimes?.[0];
          if (!firstStop?.DepartureTime) continue;
          const [h, m] = (firstStop.DepartureTime as string).split(":").map(Number);
          if (isNaN(h) || isNaN(m)) continue;
          const depMinutes = h * 60 + m;
          const diff = depMinutes - nowMinutes;
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
  stopName: string
): Promise<WaitInfo> {
  try {
    // Note: stopName must NOT be encodeURIComponent'd — TDX OData filter expects raw UTF-8
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
          return { minutes: Math.round(estimateTime / 60), source: "realtime" };
        }
        // StopStatus 3 = 末班車已過, 4 = 今日未營運
        if (stopStatus === 3 || stopStatus === 4) {
          return { minutes: null, source: "unavailable" };
        }
        // StopStatus 1 = 尚未發車, or other null → fall through to schedule
      }
    }
  } catch {
    // fall through to schedule lookup
  }

  const scheduled = await fetchScheduledWait(subRouteId, city, direction);
  if (scheduled !== null) {
    return { minutes: scheduled, source: "schedule" };
  }
  return { minutes: null, source: "unavailable" };
}

// ─── Real-time bus position ───────────────────────────────────────────────────

export async function fetchNearestBus(
  subRouteId: string,
  city: string,
  direction: number,
  departureStopCoords: [number, number],
  departureStopIdx: number,
  dirStops: BusRoute["Stops"]
): Promise<NearestBus | null> {
  try {
    const url =
      `${busUrl.cityRealtimeByFrequencyUrl}/${city}/${subRouteId}` +
      `?$format=JSON&$filter=Direction eq ${direction}`;
    const resp = await tdxFetch(url);
    if (!resp.ok) return null;
    const buses = (await resp.json()) as BusRealTimeByFrequency[];
    if (!Array.isArray(buses) || !buses.length) return null;

    const active = buses.filter(
      (b) => b.DutyStatus === 1 && b.BusStatus === 0 && b.BusPosition
    );
    if (!active.length) return null;

    let best: NearestBus | null = null;
    let bestDist = Infinity;

    for (const bus of active) {
      const busCoords: [number, number] = [
        bus.BusPosition.PositionLon,
        bus.BusPosition.PositionLat,
      ];

      // Find which stop in the sequence this bus is closest to
      let nearestStopIdx = 0;
      let nearestStopDist = Infinity;
      for (let i = 0; i < dirStops.length; i++) {
        const stopCoords: [number, number] = [
          dirStops[i].StopPosition.PositionLon,
          dirStops[i].StopPosition.PositionLat,
        ];
        const d = haversineM(busCoords, stopCoords);
        if (d < nearestStopDist) {
          nearestStopDist = d;
          nearestStopIdx = i;
        }
      }

      // Only buses that haven't passed the departure stop yet
      if (nearestStopIdx > departureStopIdx) continue;

      const distToDeparture = haversineM(busCoords, departureStopCoords);
      if (distToDeparture < bestDist) {
        bestDist = distToDeparture;
        best = {
          plateNumb: bus.PlateNumb,
          position: busCoords,
          speed: bus.Speed,
          stopsAway: departureStopIdx - nearestStopIdx,
        };
      }
    }

    return best;
  } catch {
    return null;
  }
}

// ─── Candidate builder ───────────────────────────────────────────────────────

export async function buildCandidate(
  subRouteId: string,
  city: string,
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  originStopDoc: ITdxBusStop | null,
  destStopDoc: ITdxBusStop | null
): Promise<AccessibleRoute | null> {
  if (!originStopDoc || !destStopDoc) return null;

  // 1. Fetch route stop sequence from TDX
  const routes = await fetchTdxRoute(subRouteId, city);
  if (!routes.length) return null;

  const byDir: Record<number, BusRoute["Stops"]> = {};
  for (const r of routes) byDir[r.Direction] = r.Stops;

  // 2. Determine travel direction
  const direction = getRouteDirectionImproved(
    byDir,
    originStopDoc.stopName.Zh_tw,
    destStopDoc.stopName.Zh_tw,
    "Zh_tw"
  );
  if (direction === -1) return null;

  const dirStops = byDir[direction] ?? [];
  // TDX assigns different StopUIDs per direction for the same physical stop,
  // so match by name (same logic as getRouteDirectionImproved) not by UID.
  const originIdx = dirStops.findIndex((s) =>
    equalStopName(s.StopName?.Zh_tw, originStopDoc.stopName.Zh_tw)
  );
  const destIdx = dirStops.findIndex((s) =>
    equalStopName(s.StopName?.Zh_tw, destStopDoc.stopName.Zh_tw)
  );
  if (originIdx === -1 || destIdx === -1 || originIdx >= destIdx) return null;

  // 3. Bus polyline from stop coordinate sequence
  const busPolyline: [number, number][] = dirStops
    .slice(originIdx, destIdx + 1)
    .map((s) => [s.StopPosition.PositionLon, s.StopPosition.PositionLat]);

  // 4. Coordinates in [lng, lat] order for ORS / $near
  const originCoords: [number, number] = [origin.lng, origin.lat];
  const destCoords: [number, number] = [destination.lng, destination.lat];
  const originStopCoords = originStopDoc.location.coordinates as [number, number];
  const destStopCoords = destStopDoc.location.coordinates as [number, number];

  // 5. Parallel: walking routes + wait info + OsmA11y + nearest bus
  const [walkTo, walkFrom, waitInfo, originA11y, destA11y, nearestBus] =
    await Promise.all([
      orsWalkingRoute(originCoords, originStopCoords),
      orsWalkingRoute(destStopCoords, destCoords),
      fetchWaitInfo(subRouteId, city, direction, originStopDoc.stopName.Zh_tw),
      OsmA11y.find(nearQuery(originStopCoords, 150)).limit(5).lean(),
      OsmA11y.find(nearQuery(destStopCoords, 150)).limit(5).lean(),
      fetchNearestBus(subRouteId, city, direction, originStopCoords, originIdx, dirStops),
    ]);

  // 6. Transit time estimate: 2 min per stop
  const waitMinutes = waitInfo.minutes ?? 0;
  const transitMinutes = (destIdx - originIdx) * 2;
  const totalMinutes = Math.round(
    walkTo.durationSec / 60 + waitMinutes + transitMinutes + walkFrom.durationSec / 60
  );

  // 7. Accessibility highlights
  const tagVal = (nodes: IOsmA11y[], key: string, val: string) =>
    nodes.some((f) => f.tags?.[key] === val);

  const highlights: string[] = [];
  if (originA11y.some((f) => f.category === "elevator") || tagVal(originA11y, "elevator", "yes"))
    highlights.push("上車站附近有電梯");
  if (destA11y.some((f) => f.category === "elevator") || tagVal(destA11y, "elevator", "yes"))
    highlights.push("下車站附近有電梯");
  if (originA11y.some((f) => f.category === "kerb_cut" || f.category === "ramp"))
    highlights.push("上車站附近有無障礙坡道");
  if (destA11y.some((f) => f.category === "kerb_cut" || f.category === "ramp"))
    highlights.push("下車站附近有無障礙坡道");
  if (tagVal(originA11y, "toilets:wheelchair", "yes") || tagVal(destA11y, "toilets:wheelchair", "yes"))
    highlights.push("站點附近有無障礙廁所");
  if (tagVal(originA11y, "tactile_paving", "yes") || tagVal(destA11y, "tactile_paving", "yes"))
    highlights.push("附近有導盲磚");
  if (tagVal(originA11y, "traffic_signals:sound", "yes") || tagVal(destA11y, "traffic_signals:sound", "yes"))
    highlights.push("附近有音響號誌");
  if (tagVal(originA11y, "wheelchair", "yes"))
    highlights.push("上車站設施完善");
  if (tagVal(destA11y, "wheelchair", "yes"))
    highlights.push("下車站設施完善");

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
    ...(nearestBus ? { nearestBus } : {}),
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

// ─── Metro helpers ───────────────────────────────────────────────────────────

export const FACILITY_LABELS: Record<number, string> = {
  1: "有電梯",
  2: "有電扶梯",
  3: "有無障礙廁所",
  4: "有無障礙停車位",
  5: "有導盲磚",
};

export async function fetchMetroStationOfLine(
  railSystem: string
): Promise<TdxMetroStationOfLine[]> {
  const resp = await tdxFetch(`${metroUrl.stationOfLineUrl(railSystem)}?$format=JSON`);
  if (!resp.ok) return [];
  return (await resp.json()) as TdxMetroStationOfLine[];
}

export async function fetchMetroTravelTimes(
  railSystem: string
): Promise<Map<string, number>> {
  const travelMap = new Map<string, number>();
  try {
    const resp = await tdxFetch(`${metroUrl.s2sTravelTimeUrl(railSystem)}?$format=JSON`);
    if (!resp.ok) return travelMap;
    const records = (await resp.json()) as TdxMetroS2STravelTimeRecord[];
    // TDX nests travel times under TravelTimes[] with bare StationIDs and RunTime in seconds
    for (const record of records) {
      for (const tt of record.TravelTimes ?? []) {
        const fromUid = `${railSystem}-${tt.FromStationID}`;
        const toUid   = `${railSystem}-${tt.ToStationID}`;
        travelMap.set(`${fromUid}|${toUid}`, Math.round(tt.RunTime / 60));
      }
    }
  } catch { /* return empty map */ }
  return travelMap;
}

export async function fetchMetroHeadway(
  railSystem: string,
  lineUid: string
): Promise<number> {
  try {
    // lineUid is e.g. "TMRT-G"; TDX filters by bare LineID e.g. "G"
    const lineId = lineUid.startsWith(`${railSystem}-`) ? lineUid.slice(railSystem.length + 1) : lineUid;
    const resp = await tdxFetch(
      `${metroUrl.frequencyUrl(railSystem)}?$format=JSON&$filter=LineID eq '${lineId}'`
    );
    if (!resp.ok) return 6;
    const records = (await resp.json()) as TdxMetroFrequencyRecord[];
    if (!Array.isArray(records) || !records.length) return 6;

    const now = new Date();
    const nowMins = now.getHours() * 60 + now.getMinutes();

    // Collect all headway entries across records, find current time window
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
  stationUid: string
): Promise<TdxMetroStationFacility | null> {
  try {
    const resp = await tdxFetch(
      `${metroUrl.stationFacilityUrl(railSystem)}?$format=JSON&$filter=StationUID eq '${stationUid}'`
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as TdxMetroStationFacility[];
    return data[0] ?? null;
  } catch {
    return null;
  }
}

// ─── Metro candidate builder ──────────────────────────────────────────────────

export async function buildMetroCandidate(
  railSystem: string,
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number }
): Promise<AccessibleRoute | null> {
  const originCoords: [number, number] = [origin.lng, origin.lat];
  const destCoords: [number, number] = [destination.lng, destination.lat];

  const [originStations, destStations] = await Promise.all([
    MetroStationModel.find({
      ...nearQuery(originCoords, 800),
      railSystem,
    }).limit(5).lean<ITdxMetroStation[]>(),
    MetroStationModel.find({
      ...nearQuery(destCoords, 800),
      railSystem,
    }).limit(5).lean<ITdxMetroStation[]>(),
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

  // Find direction where boardStation appears before alightStation
  let direction: 0 | 1 | null = null;
  let orderedSeq: TdxMetroStationOfLine["Stations"] = [];
  let lineUid = "";
  let boardStation: ITdxMetroStation | null = null;
  let alightStation: ITdxMetroStation | null = null;

  // TDX StationOfLine uses bare StationID (e.g. "G0"); stationUid is prefixed ("TMRT-G0").
  // lineUid stored in MongoDB is "TMRT-G"; TDX LineID is "G".
  outer: for (const lid of commonLines) {
    const bareLineId = lid.startsWith(`${railSystem}-`) ? lid.slice(railSystem.length + 1) : lid;
    for (const sol of stationOfLines) {
      if (sol.LineID !== bareLineId) continue;
      for (const os of originStations.filter((s) => s.lineIds.includes(lid))) {
        for (const ds of destStations.filter((s) => s.lineIds.includes(lid))) {
          const bareBoard  = os.stationUid.startsWith(`${railSystem}-`) ? os.stationUid.slice(railSystem.length + 1) : os.stationUid;
          const bareAlight = ds.stationUid.startsWith(`${railSystem}-`) ? ds.stationUid.slice(railSystem.length + 1) : ds.stationUid;
          const seqBoard  = sol.Stations.findIndex((s) => s.StationID === bareBoard);
          const seqAlight = sol.Stations.findIndex((s) => s.StationID === bareAlight);
          if (seqBoard !== -1 && seqAlight !== -1 && seqBoard < seqAlight) {
            direction = 0; // TDX TMRT StationOfLine has no Direction field; 0 = forward along sequence
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

  // Travel time: direct OD pair first, else sum consecutive segments
  let rideMinutes = travelMap.get(`${boardStation.stationUid}|${alightStation.stationUid}`) ?? null;
  if (rideMinutes === null) {
    let sum = 0;
    for (let i = 0; i < orderedSeq.length - 1; i++) {
      const fromUid = `${railSystem}-${orderedSeq[i].StationID}`;
      const toUid   = `${railSystem}-${orderedSeq[i + 1].StationID}`;
      sum += travelMap.get(`${fromUid}|${toUid}`) ?? 2;
    }
    rideMinutes = sum;
  }

  const avgHeadway = await fetchMetroHeadway(railSystem, lineUid);
  const waitMinutes = Math.round(avgHeadway / 2);
  const waitInfo: WaitInfo = { minutes: waitMinutes, source: "schedule" };

  const boardCoords  = boardStation.location.coordinates  as [number, number];
  const alightCoords = alightStation.location.coordinates as [number, number];

  const [walkTo, walkFrom, boardFacility, alightFacility, boardA11y, alightA11y] =
    await Promise.all([
      orsWalkingRoute(originCoords, boardCoords),
      orsWalkingRoute(alightCoords, destCoords),
      fetchMetroFacilities(railSystem, boardStation.stationUid),
      fetchMetroFacilities(railSystem, alightStation.stationUid),
      OsmA11y.find(nearQuery(boardCoords, 200)).limit(5).lean(),
      OsmA11y.find(nearQuery(alightCoords, 200)).limit(5).lean(),
    ]);

  const facilityHighlights: string[] = [];
  for (const [facility, prefix] of [
    [boardFacility,  "乘車站"],
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
  if (boardA11y.some((f: any) => f.category === "elevator") || osmTagVal(boardA11y as IOsmA11y[], "elevator", "yes"))
    highlights.push("乘車站附近有電梯");
  if (alightA11y.some((f: any) => f.category === "elevator") || osmTagVal(alightA11y as IOsmA11y[], "elevator", "yes"))
    highlights.push("下車站附近有電梯");
  if (osmTagVal(boardA11y as IOsmA11y[], "toilets:wheelchair", "yes") || osmTagVal(alightA11y as IOsmA11y[], "toilets:wheelchair", "yes"))
    highlights.push("站點附近有無障礙廁所");
  if (osmTagVal(boardA11y as IOsmA11y[], "tactile_paving", "yes") || osmTagVal(alightA11y as IOsmA11y[], "tactile_paving", "yes"))
    highlights.push("附近有導盲磚");
  if (osmTagVal(boardA11y as IOsmA11y[], "traffic_signals:sound", "yes") || osmTagVal(alightA11y as IOsmA11y[], "traffic_signals:sound", "yes"))
    highlights.push("附近有音響號誌");
  if (osmTagVal(boardA11y as IOsmA11y[], "wheelchair", "yes"))
    highlights.push("乘車站設施完善");
  if (osmTagVal(alightA11y as IOsmA11y[], "wheelchair", "yes"))
    highlights.push("下車站設施完善");

  const metroPolyline: [number, number][] = orderedSeq
    .map((s) => {
      const doc = [...originStations, ...destStations].find(
        (d) => d.stationUid === `${railSystem}-${s.StationID}`
      );
      return doc?.location.coordinates as [number, number] | undefined;
    })
    .filter((c): c is [number, number] => !!c);

  const totalMinutes = Math.round(
    walkTo.durationSec / 60 + waitMinutes + rideMinutes + walkFrom.durationSec / 60
  );

  const metroLeg: MetroLeg = {
    type: "METRO",
    railSystem,
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

// ─── Train (THSR / TRA) helpers ──────────────────────────────────────────────

const timetableCache = new Map<string, { data: any; expiresAt: number }>();

function getCachedTimetable<T>(key: string): T | null {
  const entry = timetableCache.get(key);
  if (!entry || Date.now() > entry.expiresAt) { timetableCache.delete(key); return null; }
  return entry.data as T;
}
function setCachedTimetable(key: string, data: any): void {
  timetableCache.set(key, { data, expiresAt: Date.now() + 2 * 60 * 60 * 1000 });
}

async function fetchWithCache<T>(url: string, cacheKey: string): Promise<T | null> {
  const cached = getCachedTimetable<T>(cacheKey);
  if (cached) return cached;
  const resp = await tdxFetch(url);
  if (resp.status === 429) {
    await new Promise((r) => setTimeout(r, 1500));
    const retry = await tdxFetch(url);
    if (!retry.ok) return null;
    const data = (await retry.json()) as T;
    setCachedTimetable(cacheKey, data);
    return data;
  }
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
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
] as const;

async function findNextThsrTrain(
  originStationID: string,
  destStationID: string
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
    const raw = await fetchWithCache<TdxThsrGeneralTimetableItem[]>(url, cacheKey);
    if (!Array.isArray(raw) || !raw.length) return null;
    const data = raw.filter((item) =>
      item.GeneralTimetable.StopTimes.some((s) => s.StationID === destStationID)
    );
    if (!data.length) return null;

    const now = new Date();
    const todayKey = DOW_KEYS[now.getDay()];
    const nowMins  = now.getHours() * 60 + now.getMinutes();

    let best: {
      trainNo: string; departureTime: string; arrivalTime: string;
      rideMinutes: number; waitMinutes: number;
    } | null = null;
    let bestWait = Infinity;

    for (const item of data) {
      const gt = item.GeneralTimetable;
      if (gt.ServiceDay && !gt.ServiceDay[todayKey]) continue;

      const originStop = gt.StopTimes.find((s) => s.StationID === originStationID);
      const destStop   = gt.StopTimes.find((s) => s.StationID === destStationID);
      if (!originStop || !destStop) continue;
      if (originStop.Sequence >= destStop.Sequence) continue;

      const depMins = timeToMins(originStop.DepartureTime);
      const diff    = depMins - nowMins;
      // Accept trains departing up to 30 min ago (may still be catchable) and strictly next
      if (diff < -30 || diff >= bestWait) continue;

      const arrMins = timeToMins(destStop.ArrivalTime);
      bestWait = diff;
      best = {
        trainNo:       gt.GeneralTrainInfo.TrainNo,
        departureTime: originStop.DepartureTime,
        arrivalTime:   destStop.ArrivalTime,
        rideMinutes:   Math.max(1, arrMins - depMins),
        waitMinutes:   Math.max(0, diff),
      };
    }
    return best;
  } catch {
    return null;
  }
}

async function buildThsrCandidate(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number }
): Promise<AccessibleRoute | null> {
  const originCoords: [number, number] = [origin.lng, origin.lat];
  const destCoords:   [number, number] = [destination.lng, destination.lat];

  const [originStations, destStations] = await Promise.all([
    TrainStationModel.find({ ...nearQuery(originCoords, 3000), railSystem: "THSR" })
      .limit(3).lean<ITdxTrainStation[]>(),
    TrainStationModel.find({ ...nearQuery(destCoords, 3000), railSystem: "THSR" })
      .limit(3).lean<ITdxTrainStation[]>(),
  ]);
  if (!originStations.length || !destStations.length) return null;

  const boardStation  = originStations[0];
  const alightStation = destStations[0];
  if (boardStation.stationUID === alightStation.stationUID) return null;

  const trainInfo = await findNextThsrTrain(boardStation.stationID, alightStation.stationID);
  if (!trainInfo) return null;

  const boardCoords  = boardStation.location.coordinates as [number, number];
  const alightCoords = alightStation.location.coordinates as [number, number];

  const [walkTo, walkFrom, boardA11y, alightA11y] = await Promise.all([
    orsWalkingRoute(originCoords, boardCoords),
    orsWalkingRoute(alightCoords, destCoords),
    OsmA11y.find(nearQuery(boardCoords, 300)).limit(5).lean(),
    OsmA11y.find(nearQuery(alightCoords, 300)).limit(5).lean(),
  ]);

  const waitInfo: WaitInfo = { minutes: trainInfo.waitMinutes, source: "schedule" };
  const totalMinutes = Math.round(
    walkTo.durationSec / 60 + trainInfo.waitMinutes + trainInfo.rideMinutes + walkFrom.durationSec / 60
  );

  const osmTagVal = (nodes: IOsmA11y[], key: string, val: string) =>
    nodes.some((f) => f.tags?.[key] === val);

  const facilityHighlights: string[] = [
    "高鐵站設有無障礙設施",
    "列車備有無障礙座位及輪椅空間",
  ];
  if (boardA11y.some((f: any) => f.category === "elevator") || osmTagVal(boardA11y as IOsmA11y[], "elevator", "yes"))
    facilityHighlights.push("乘車站附近有電梯");
  if (alightA11y.some((f: any) => f.category === "elevator") || osmTagVal(alightA11y as IOsmA11y[], "elevator", "yes"))
    facilityHighlights.push("下車站附近有電梯");
  if (osmTagVal(boardA11y as IOsmA11y[], "toilets:wheelchair", "yes") || osmTagVal(alightA11y as IOsmA11y[], "toilets:wheelchair", "yes"))
    facilityHighlights.push("站點附近有無障礙廁所");
  if (osmTagVal(boardA11y as IOsmA11y[], "tactile_paving", "yes") || osmTagVal(alightA11y as IOsmA11y[], "tactile_paving", "yes"))
    facilityHighlights.push("附近有導盲磚");
  if (osmTagVal(boardA11y as IOsmA11y[], "wheelchair", "yes"))
    facilityHighlights.push("乘車站設施完善");
  if (osmTagVal(alightA11y as IOsmA11y[], "wheelchair", "yes"))
    facilityHighlights.push("下車站設施完善");

  const thsrLeg: ThsrLeg = {
    type:                 "THSR",
    trainNo:              trainInfo.trainNo,
    departureStation:     boardStation.stationName.Zh_tw,
    arrivalStation:       alightStation.stationName.Zh_tw,
    departureStationUID:  boardStation.stationUID,
    arrivalStationUID:    alightStation.stationUID,
    departureTime:        trainInfo.departureTime,
    arrivalTime:          trainInfo.arrivalTime,
    rideMinutes:          trainInfo.rideMinutes,
    waitInfo,
    estimatedWaitMinutes: trainInfo.waitMinutes,
    polyline:             [boardCoords, alightCoords],
    departureStationA11y: boardA11y  as IOsmA11y[],
    arrivalStationA11y:   alightA11y as IOsmA11y[],
    facilityHighlights,
  };

  return {
    routeId:   `THSR-${boardStation.stationID}-${alightStation.stationID}`,
    routeName: `高鐵 ${boardStation.stationName.Zh_tw} → ${alightStation.stationName.Zh_tw}`,
    totalMinutes,
    transferCount: 0,
    legs: [
      {
        type:           "WALK",
        from:           "出發地",
        to:             boardStation.stationName.Zh_tw,
        distanceM:      Math.round(walkTo.distanceM),
        minutesEst:     Math.round(walkTo.durationSec / 60),
        polyline:       walkTo.polyline,
        a11yFacilities: boardA11y as IOsmA11y[],
      },
      thsrLeg,
      {
        type:           "WALK",
        from:           alightStation.stationName.Zh_tw,
        to:             "目的地",
        distanceM:      Math.round(walkFrom.distanceM),
        minutesEst:     Math.round(walkFrom.durationSec / 60),
        polyline:       walkFrom.polyline,
        a11yFacilities: alightA11y as IOsmA11y[],
      },
    ],
    accessibilityHighlights: facilityHighlights,
  };
}

// ─── TRA candidate builder ────────────────────────────────────────────────────

async function findNextTraTrain(
  originStationID: string,
  destStationID: string
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
    const raw = await fetchWithCache<TdxTraGeneralTimetableItem[]>(url, cacheKey);
    if (!Array.isArray(raw) || !raw.length) return null;
    const data = raw.filter((item) =>
      item.GeneralTimetable.StopTimes.some((s) => s.StationID === destStationID)
    );
    if (!data.length) return null;

    const now = new Date();
    const todayKey = DOW_KEYS[now.getDay()];
    const nowMins = now.getHours() * 60 + now.getMinutes();

    let best: {
      trainNo: string; trainTypeName: string; departureTime: string;
      arrivalTime: string; rideMinutes: number; waitMinutes: number;
    } | null = null;
    let bestWait = Infinity;

    for (const item of data) {
      const gt = item.GeneralTimetable;
      if (gt.ServiceDay && !gt.ServiceDay[todayKey]) continue;
      const originStop = gt.StopTimes.find((s) => s.StationID === originStationID);
      const destStop   = gt.StopTimes.find((s) => s.StationID === destStationID);
      if (!originStop || !destStop) continue;
      if (originStop.Sequence >= destStop.Sequence) continue;

      const depMins = timeToMins(originStop.DepartureTime);
      const diff    = depMins - nowMins;
      if (diff < -30 || diff >= bestWait) continue;

      const arrMins = timeToMins(destStop.ArrivalTime);
      bestWait = diff;
      best = {
        trainNo:       gt.GeneralTrainInfo.TrainNo,
        trainTypeName: gt.GeneralTrainInfo.TrainTypeName?.Zh_tw ?? "列車",
        departureTime: originStop.DepartureTime,
        arrivalTime:   destStop.ArrivalTime,
        rideMinutes:   Math.max(1, arrMins - depMins),
        waitMinutes:   Math.max(0, diff),
      };
    }
    return best;
  } catch {
    return null;
  }
}

async function buildTraCandidate(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number }
): Promise<AccessibleRoute | null> {
  const originCoords: [number, number] = [origin.lng, origin.lat];
  const destCoords:   [number, number] = [destination.lng, destination.lat];

  const [originStations, destStations] = await Promise.all([
    TrainStationModel.find({ ...nearQuery(originCoords, 1500), railSystem: "TRA" })
      .limit(3).lean<ITdxTrainStation[]>(),
    TrainStationModel.find({ ...nearQuery(destCoords, 1500), railSystem: "TRA" })
      .limit(3).lean<ITdxTrainStation[]>(),
  ]);
  if (!originStations.length || !destStations.length) return null;

  const boardStation  = originStations[0];
  const alightStation = destStations[0];
  if (boardStation.stationUID === alightStation.stationUID) return null;

  const trainInfo = await findNextTraTrain(boardStation.stationID, alightStation.stationID);
  if (!trainInfo) return null;

  const boardCoords  = boardStation.location.coordinates as [number, number];
  const alightCoords = alightStation.location.coordinates as [number, number];

  const [walkTo, walkFrom, boardA11y, alightA11y] = await Promise.all([
    orsWalkingRoute(originCoords, boardCoords),
    orsWalkingRoute(alightCoords, destCoords),
    OsmA11y.find(nearQuery(boardCoords, 300)).limit(5).lean(),
    OsmA11y.find(nearQuery(alightCoords, 300)).limit(5).lean(),
  ]);

  const waitInfo: WaitInfo = { minutes: trainInfo.waitMinutes, source: "schedule" };
  const totalMinutes = Math.round(
    walkTo.durationSec / 60 + trainInfo.waitMinutes + trainInfo.rideMinutes + walkFrom.durationSec / 60
  );

  const osmTagVal = (nodes: IOsmA11y[], key: string, val: string) =>
    nodes.some((f) => f.tags?.[key] === val);

  const facilityHighlights: string[] = [
    `臺鐵${trainInfo.trainTypeName} 列車`,
  ];
  if (boardA11y.some((f: any) => f.category === "elevator") || osmTagVal(boardA11y as IOsmA11y[], "elevator", "yes"))
    facilityHighlights.push("乘車站附近有電梯");
  if (alightA11y.some((f: any) => f.category === "elevator") || osmTagVal(alightA11y as IOsmA11y[], "elevator", "yes"))
    facilityHighlights.push("下車站附近有電梯");
  if (osmTagVal(boardA11y as IOsmA11y[], "toilets:wheelchair", "yes") || osmTagVal(alightA11y as IOsmA11y[], "toilets:wheelchair", "yes"))
    facilityHighlights.push("站點附近有無障礙廁所");
  if (osmTagVal(boardA11y as IOsmA11y[], "tactile_paving", "yes") || osmTagVal(alightA11y as IOsmA11y[], "tactile_paving", "yes"))
    facilityHighlights.push("附近有導盲磚");
  if (osmTagVal(boardA11y as IOsmA11y[], "wheelchair", "yes"))
    facilityHighlights.push("乘車站設施完善");
  if (osmTagVal(alightA11y as IOsmA11y[], "wheelchair", "yes"))
    facilityHighlights.push("下車站設施完善");

  const traLeg: TraLeg = {
    type:                 "TRA",
    trainNo:              trainInfo.trainNo,
    trainTypeName:        trainInfo.trainTypeName,
    departureStation:     boardStation.stationName.Zh_tw,
    arrivalStation:       alightStation.stationName.Zh_tw,
    departureStationUID:  boardStation.stationUID,
    arrivalStationUID:    alightStation.stationUID,
    departureTime:        trainInfo.departureTime,
    arrivalTime:          trainInfo.arrivalTime,
    rideMinutes:          trainInfo.rideMinutes,
    waitInfo,
    estimatedWaitMinutes: trainInfo.waitMinutes,
    polyline:             [boardCoords, alightCoords],
    departureStationA11y: boardA11y  as IOsmA11y[],
    arrivalStationA11y:   alightA11y as IOsmA11y[],
    facilityHighlights,
  };

  return {
    routeId:   `TRA-${boardStation.stationID}-${alightStation.stationID}`,
    routeName: `臺鐵${trainInfo.trainTypeName} ${boardStation.stationName.Zh_tw} → ${alightStation.stationName.Zh_tw}`,
    totalMinutes,
    transferCount: 0,
    legs: [
      {
        type:           "WALK",
        from:           "出發地",
        to:             boardStation.stationName.Zh_tw,
        distanceM:      Math.round(walkTo.distanceM),
        minutesEst:     Math.round(walkTo.durationSec / 60),
        polyline:       walkTo.polyline,
        a11yFacilities: boardA11y as IOsmA11y[],
      },
      traLeg,
      {
        type:           "WALK",
        from:           alightStation.stationName.Zh_tw,
        to:             "目的地",
        distanceM:      Math.round(walkFrom.distanceM),
        minutesEst:     Math.round(walkFrom.durationSec / 60),
        polyline:       walkFrom.polyline,
        a11yFacilities: alightA11y as IOsmA11y[],
      },
    ],
    accessibilityHighlights: facilityHighlights,
  };
}

// ─── Route facility collector ─────────────────────────────────────────────────

function collectRouteFacilities(r: AccessibleRoute): IOsmA11y[] {
  return r.legs.flatMap((leg) => {
    if (leg.type === "WALK") return leg.a11yFacilities;
    if (leg.type === "BUS") return [...leg.departureStopA11y, ...leg.arrivalStopA11y];
    if (leg.type === "METRO") return [...leg.departureStationA11y, ...leg.arrivalStationA11y];
    if (leg.type === "THSR") return [...leg.departureStationA11y, ...leg.arrivalStationA11y];
    if (leg.type === "TRA")  return [...leg.departureStationA11y, ...leg.arrivalStationA11y];
    return [];
  });
}

// ─── Scoring ─────────────────────────────────────────────────────────────────
//
// Uses the evidence-based scoring engine from src/config/a11y-scoring.ts.
// See that module for full citation list and weight rationale.
//
// Summary of key design choices:
//   • Accessibility / time split: 65% / 35%
//     Rationale: wheelchair users accept 14–74% longer routes to avoid barriers
//     (Karimi 2016; Shanghai transit study 2025). Time matters but is secondary.
//   • Facility scoring uses scoreFacilitySet() which applies tier-weighted tag
//     contributions + category-level bonuses from Huang et al. 2025.
//   • Critical feature bonuses (elevator, flush kerb, ramp) apply independently
//     of continuous tag scores to ensure Tier 1 barriers are never diluted.
//   • Time normalization: linear across candidates — fastest = 100, slowest = 0.

export function scoreAndRank(routes: AccessibleRoute[]): AccessibleRoute[] {
  const maxTime = Math.max(...routes.map((r) => r.totalMinutes), 1);

  return routes
    .map((r) => {
      const facilities = collectRouteFacilities(r);
      const result = scoreRoute(
        facilities,
        r.totalMinutes,
        maxTime,
        r.accessibilityHighlights.length
      );
      // Attach score metadata to route for client consumption.
      r.accessibilityScore = result.totalScore;
      r.accessibilityLabel = result.label;
      r.scoreComponents = result.components;
      return { route: r, score: result.totalScore };
    })
    .sort((a, b) => b.score - a.score)
    .map((s) => s.route);
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
    (l): l is BusLeg | MetroLeg | ThsrLeg | TraLeg => l.type !== "WALK"
  );
  if (transitLegs.length === 0) return ""; // walk-only: never deduplicate
  return transitLegs.map(transitLegKey).join("::");
}

function deduplicateRoutes(routes: AccessibleRoute[]): AccessibleRoute[] {
  const seen = new Set<string>();
  return routes.filter((r) => {
    const key = buildRouteKey(r);
    if (key === "") return true; // walk-only route: always keep
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function findAccessibleRoutes(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  city: TaiwanCityEn
): Promise<AccessibleRoute[]> {
  const geoQuery = (coord: { lat: number; lng: number }, dist: number) =>
    nearQuery([coord.lng, coord.lat], dist);

  // Bus search
  const busSearchPromise = (async (): Promise<AccessibleRoute[]> => {
    const [originStops, destStops] = await Promise.all([
      BusStopModel.find(geoQuery(origin, 400)).limit(20).lean<ITdxBusStop[]>(),
      BusStopModel.find(geoQuery(destination, 400)).limit(20).lean<ITdxBusStop[]>(),
    ]);
    if (!originStops.length || !destStops.length) return [];

    const originRouteIds = new Set(originStops.flatMap((s) => s.subRouteIds));
    const destRouteIds   = new Set(destStops.flatMap((s) => s.subRouteIds));
    const connecting     = [...originRouteIds].filter((id) => destRouteIds.has(id));
    if (!connecting.length) return [];

    const candidates = await Promise.all(
      connecting.slice(0, 5).map((routeId) => {
        const originStop = originStops.find((s) => s.subRouteIds.includes(routeId)) ?? null;
        const destStop   = destStops.find((s) => s.subRouteIds.includes(routeId)) ?? null;
        return buildCandidate(routeId, city, origin, destination, originStop, destStop);
      })
    );
    return candidates.filter(Boolean) as AccessibleRoute[];
  })();

  // Metro search — one promise per rail system serving this city
  const systems = CITY_METRO_SYSTEMS[city] ?? [];
  const metroPromises = systems.map((railSystem) =>
    buildMetroCandidate(railSystem, origin, destination)
      .then((r): AccessibleRoute[] => (r ? [r] : []))
      .catch((): AccessibleRoute[] => [])
  );

  const thsrPromise = buildThsrCandidate(origin, destination)
    .then((r): AccessibleRoute[] => (r ? [r] : []))
    .catch((): AccessibleRoute[] => []);

  const traPromise = buildTraCandidate(origin, destination)
    .then((r): AccessibleRoute[] => (r ? [r] : []))
    .catch((): AccessibleRoute[] => []);

  // Phase 3: one-transfer routes run concurrently with the direct search.
  // Lazy import avoids a circular dependency at module-eval time (transfer-finder
  // imports many helpers from this file); starting it here rather than after the
  // direct Promise.all keeps transfer latency off the critical path.
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

  return scoreAndRank(deduplicateRoutes(allRoutes)).slice(0, 3);
}
