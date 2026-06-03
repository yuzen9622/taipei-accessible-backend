import { tdxFetch } from "../config/fetch";
import { busUrl } from "../config/transit";
import { getRouteDirectionImproved } from "../config/lib";
import { orsWalkingRoute } from "../config/ors";
import BusStopModel from "../model/bus-stop.model";
import OsmA11y from "../model/osm-a11y.model";
import { IOsmA11y, ITdxBusStop } from "../types";
import { BusRoute } from "../types/transit";

// ─── Response types ──────────────────────────────────────────────────────────

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
  estimatedWaitMinutes: number;
  direction: 0 | 1;
  polyline: [number, number][];
  departureStopA11y: IOsmA11y[];
  arrivalStopA11y: IOsmA11y[];
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

async function fetchTdxRoute(
  subRouteId: string,
  city: string
): Promise<BusRoute[]> {
  const url = `${busUrl.stopOfRouteUrl}/${city}?$format=JSON&$filter=SubRouteName/Zh_tw eq '${subRouteId}'`;
  const resp = await tdxFetch(url);
  if (!resp.ok) return [];
  return (await resp.json()) as BusRoute[];
}

async function fetchEtaMinutes(
  subRouteId: string,
  city: string,
  direction: number,
  stopName: string
): Promise<number> {
  try {
    const url =
      `${busUrl.cityEstimatedTimeOfArrivalUrl}/${city}/${subRouteId}` +
      `?$format=JSON&$filter=Direction eq ${direction} and contains(StopName/Zh_tw,'${encodeURIComponent(stopName)}')`;
    const resp = await tdxFetch(url);
    if (!resp.ok) return 10;
    const data = (await resp.json()) as any[];
    const first = data.find(
      (d) => d.EstimateTime != null && d.EstimateTime >= 0
    );
    return first ? Math.round(first.EstimateTime / 60) : 10;
  } catch (_) {
    return 10;
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
  const originIdx = dirStops.findIndex(
    (s) => s.StopUID === originStopDoc.stopUid
  );
  const destIdx = dirStops.findIndex((s) => s.StopUID === destStopDoc.stopUid);
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

  // 5. Parallel: walking routes + ETA + OsmA11y
  const [walkTo, walkFrom, waitMinutes, originA11y, destA11y] =
    await Promise.all([
      orsWalkingRoute(originCoords, originStopCoords),
      orsWalkingRoute(destStopCoords, destCoords),
      fetchEtaMinutes(
        subRouteId,
        city,
        direction,
        originStopDoc.stopName.Zh_tw
      ),
      OsmA11y.find(nearQuery(originStopCoords, 150)).limit(5).lean(),
      OsmA11y.find(nearQuery(destStopCoords, 150)).limit(5).lean(),
    ]);

  // 6. Transit time estimate: 2 min per stop
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
      {
        type: "BUS",
        routeName: subRouteId,
        departureStop: originStopDoc.stopName.Zh_tw,
        arrivalStop: destStopDoc.stopName.Zh_tw,
        estimatedWaitMinutes: waitMinutes,
        direction: direction as 0 | 1,
        polyline: busPolyline,
        departureStopA11y: originA11y as IOsmA11y[],
        arrivalStopA11y: destA11y as IOsmA11y[],
      },
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
  return scoreAndRank(valid).slice(0, 3);
}
