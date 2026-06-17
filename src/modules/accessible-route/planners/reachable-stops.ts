/**
 * findReachableStops.
 *
 * Given an origin point, finds nearby bus stops and metro stations reachable
 * within a walking-time budget. Uses a geospatial $near query + straight-line
 * prefilter to build a candidate set, then a single ORS Matrix call to obtain
 * real walking durations. Opportunistically seeds the walk-time cache.
 *
 * All coordinates are [lng, lat] (GeoJSON / ORS convention).
 */
import BusStopModel from "../../../model/bus-stop.model";
import MetroStationModel from "../../../model/metro-station.model";
import { ITdxBusStop, ITdxMetroStation } from "../../../types";
import {
  orsWalkingMatrix,
  haversineCoords,
  WHEELCHAIR_SPEED_M_PER_MIN,
} from "./ors";
import { setWalkCache } from "./walk-cache";

const GEO_QUERY_RADIUS_M = 2000;

export interface ReachableStop {
  kind: "bus" | "metro";
  doc: ITdxBusStop | ITdxMetroStation;
  coords: [number, number];
  walkMinutes: number;
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

  const PREFILTER_RADIUS_M = maxWalkMin * WHEELCHAIR_SPEED_M_PER_MIN;

  const nearQuery = (maxDistM: number) => ({
    location: {
      $near: {
        $geometry: { type: "Point" as const, coordinates: origin },
        $maxDistance: maxDistM,
      },
    },
  });

  const [busRaw, metroRaw] = await Promise.all([
    BusStopModel.find(nearQuery(GEO_QUERY_RADIUS_M))
      .limit(50)
      .lean<ITdxBusStop[]>(),
    MetroStationModel.find(nearQuery(GEO_QUERY_RADIUS_M))
      .limit(50)
      .lean<ITdxMetroStation[]>(),
  ]);

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

  const destCoords = combined.map((s) => s.coords);
  const durations = await orsWalkingMatrix(origin, destCoords);

  const maxWalkSec = maxWalkMin * 60;
  const results: ReachableStop[] = [];
  for (let i = 0; i < combined.length; i++) {
    const sec = durations[i];
    if (sec === null) continue;
    if (sec > maxWalkSec) continue;
    results.push({
      kind: combined[i].kind,
      doc: combined[i].doc,
      coords: combined[i].coords,
      walkMinutes: Math.round(sec / 60),
    });
    const distM = haversineCoords(origin, combined[i].coords);
    void setWalkCache(origin, combined[i].coords, sec, distM).catch(() => {});
  }

  return results.sort((a, b) => a.walkMinutes - b.walkMinutes);
}
