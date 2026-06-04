import { tdxFetch } from "../../config/fetch";
import { busUrl } from "../../config/transit";
import { getRouteDirectionImproved, equalStopName } from "../../config/lib";
import { orsWalkingRoute } from "../../config/ors";
import BusStopModel from "../../model/bus-stop.model";
import OsmA11y from "../../model/osm-a11y.model";
import { IOsmA11y, ITdxBusStop } from "../../types";
import { BusRoute, BusRealTimeByFrequency } from "../../types/transit";

// ─── Response types ──────────────────────────────────────────────────────────

export interface WaitInfo {
  minutes: number | null;
  source: "realtime" | "schedule" | "unavailable";
}

interface NearestBus {
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

export interface AccessibleRoute {
  routeId: string;
  routeName: string;
  totalMinutes: number;
  legs: (WalkLeg | BusLeg)[];
  accessibilityHighlights: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function nearQuery(coords: [number, number], maxDistM: number) {
  return {
    location: {
      $near: {
        $geometry: { type: "Point", coordinates: coords },
        $maxDistance: maxDistM,
      },
    },
  };
}

function haversineM(a: [number, number], b: [number, number]): number {
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

async function fetchTdxRoute(
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

async function fetchWaitInfo(
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

async function fetchNearestBus(
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

async function buildCandidate(
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
  const highlights: string[] = [];
  if (originA11y.some((f) => f.category === "elevator"))
    highlights.push("上車站附近有電梯");
  if (destA11y.some((f) => f.category === "elevator"))
    highlights.push("下車站附近有電梯");
  if (originA11y.some((f) => f.category === "kerb_cut" || f.category === "ramp"))
    highlights.push("上車站附近有無障礙坡道");
  if (destA11y.some((f) => f.category === "kerb_cut" || f.category === "ramp"))
    highlights.push("下車站附近有無障礙坡道");

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

// ─── Scoring ─────────────────────────────────────────────────────────────────

function scoreAndRank(routes: AccessibleRoute[]): AccessibleRoute[] {
  const maxTime = Math.max(...routes.map((r) => r.totalMinutes), 1);
  return routes
    .map((r) => {
      const timeScore = 1 - r.totalMinutes / maxTime;
      const a11yScore = r.accessibilityHighlights.length / 4; // max 4 highlights
      return { route: r, score: a11yScore * 0.6 + timeScore * 0.4 };
    })
    .sort((a, b) => b.score - a.score)
    .map((s) => s.route);
}

function deduplicateRoutes(routes: AccessibleRoute[]): AccessibleRoute[] {
  const seen = new Set<string>();
  return routes.filter((r) => {
    const busLeg = r.legs.find((l): l is BusLeg => l.type === "BUS");
    if (!busLeg) return true;
    const key = `${busLeg.departureStop}|${busLeg.arrivalStop}|${busLeg.direction}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function findAccessibleRoutes(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  city: string
): Promise<AccessibleRoute[]> {
  // Step 1: Find nearby stops in MongoDB
  const geoQuery = (coord: { lat: number; lng: number }, dist: number) =>
    nearQuery([coord.lng, coord.lat], dist);

  const [originStops, destStops] = await Promise.all([
    BusStopModel.find(geoQuery(origin, 400)).limit(20).lean<ITdxBusStop[]>(),
    BusStopModel.find(geoQuery(destination, 400)).limit(20).lean<ITdxBusStop[]>(),
  ]);

  if (!originStops.length || !destStops.length) return [];

  // Step 2: Find routes serving stops near both ends
  const originRouteIds = new Set(originStops.flatMap((s) => s.subRouteIds));
  const destRouteIds = new Set(destStops.flatMap((s) => s.subRouteIds));
  const connecting = [...originRouteIds].filter((id) => destRouteIds.has(id));

  if (!connecting.length) return [];

  // Step 3: For each connecting route, pick the closest stops and build candidate
  const candidates = await Promise.all(
    connecting.slice(0, 5).map((routeId) => {
      const originStop =
        originStops.find((s) => s.subRouteIds.includes(routeId)) ?? null;
      const destStop =
        destStops.find((s) => s.subRouteIds.includes(routeId)) ?? null;
      return buildCandidate(routeId, city, origin, destination, originStop, destStop);
    })
  );

  const valid = candidates.filter(Boolean) as AccessibleRoute[];
  return scoreAndRank(deduplicateRoutes(valid)).slice(0, 3);
}
