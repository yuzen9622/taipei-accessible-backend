/**
 * Phase 2 — findReachableStops.
 *
 * Given an origin point, finds nearby bus stops and metro stations reachable
 * within a walking-time budget. Uses a geospatial $near query + straight-line
 * prefilter to build a candidate set, then a single ORS Matrix call to obtain
 * real walking durations. Opportunistically seeds the walk-time cache.
 *
 * All coordinates are [lng, lat] (GeoJSON / ORS convention).
 *
 * This service is NOT wired into findAccessibleRoutes — that is Phase 4.
 */
import BusStopModel from "../model/bus-stop.model";
import MetroStationModel from "../model/metro-station.model";
import { ITdxBusStop, ITdxMetroStation } from "../types";
import {
  orsWalkingMatrix,
  haversineCoords,
  WHEELCHAIR_SPEED_M_PER_MIN,
} from "./ors.service";
import { setWalkCache } from "./walk-cache.service";

const GEO_QUERY_RADIUS_M = 2000;

export interface ReachableStop {
  kind: "bus" | "metro";
  doc: ITdxBusStop | ITdxMetroStation;
  coords: [number, number]; // [lng, lat]
  walkMinutes: number; // ORS-computed (or fallback-estimated), always >= 0
}

type RawStop =
  | { kind: "bus"; doc: ITdxBusStop; coords: [number, number] }
  | { kind: "metro"; doc: ITdxMetroStation; coords: [number, number] };

export async function findReachableStops(
  point: { lat: number; lng: number },
  opts?: { maxWalkMin?: number },
): Promise<ReachableStop[]> {
  const maxWalkMin = opts?.maxWalkMin ?? 20;
  const origin: [number, number] = [point.lng, point.lat];

  // Theoretical max straight-line walk at wheelchair speed within the budget.
  // (= 1200 m at the default 20 min / 60 m·min⁻¹.) Stops beyond this can never
  // be reachable in time, so they are dropped before the ORS Matrix call.
  const PREFILTER_RADIUS_M = maxWalkMin * WHEELCHAIR_SPEED_M_PER_MIN;

  const nearQuery = (maxDistM: number) => ({
    location: {
      $near: {
        $geometry: { type: "Point" as const, coordinates: origin },
        $maxDistance: maxDistM,
      },
    },
  });

  // Step 1: parallel index-backed $near queries on both models.
  const [busRaw, metroRaw] = await Promise.all([
    BusStopModel.find(nearQuery(GEO_QUERY_RADIUS_M))
      .limit(50)
      .lean<ITdxBusStop[]>(),
    MetroStationModel.find(nearQuery(GEO_QUERY_RADIUS_M))
      .limit(50)
      .lean<ITdxMetroStation[]>(),
  ]);

  // Step 2: straight-line prefilter.
  const combined: RawStop[] = [
    ...busRaw.map(
      (d): RawStop => ({
        kind: "bus",
        doc: d,
        coords: d.location.coordinates as [number, number],
      }),
    ),
    ...metroRaw.map(
      (d): RawStop => ({
        kind: "metro",
        doc: d,
        coords: d.location.coordinates as [number, number],
      }),
    ),
  ].filter((s) => haversineCoords(origin, s.coords) <= PREFILTER_RADIUS_M);

  if (combined.length === 0) return [];

  // Step 3: single ORS Matrix call (one-to-many durations in seconds).
  const destCoords = combined.map((s) => s.coords);
  const durations = await orsWalkingMatrix(origin, destCoords);

  // Step 4: filter by reachability and the time budget, seeding the walk-time
  // cache opportunistically (fire-and-forget). The cache stores the raw ORS
  // duration in seconds — not the rounded walkMinutes — to preserve sub-minute
  // precision and stay consistent with how orsWalkingRoute seeds the cache.
  // distanceM is approximated by the straight-line distance (the matrix
  // response carries no distance), matching the straight-line fallback shape.
  const maxWalkSec = maxWalkMin * 60;
  const results: ReachableStop[] = [];
  for (let i = 0; i < combined.length; i++) {
    const sec = durations[i];
    if (sec === null) continue; // ORS says unreachable
    if (sec > maxWalkSec) continue; // exceeds time budget
    results.push({
      kind: combined[i].kind,
      doc: combined[i].doc,
      coords: combined[i].coords,
      walkMinutes: Math.round(sec / 60),
    });
    const distM = haversineCoords(origin, combined[i].coords);
    void setWalkCache(origin, combined[i].coords, sec, distM).catch(() => {});
  }

  // Step 5: sort ascending by walk time and return.
  return results.sort((a, b) => a.walkMinutes - b.walkMinutes);
}
