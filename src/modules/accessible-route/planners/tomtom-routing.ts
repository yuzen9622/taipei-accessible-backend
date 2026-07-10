/**
 * TomTom Routing API planner — the non-transit path (drive / motorcycle / walk).
 * Maps calculateRoute results to the shared AccessibleRoute shape (DRIVE /
 * MOTORCYCLE legs, or WALK legs for walking). Traffic-aware durations come from
 * `traffic` + `departAt`. Motorcycle (beta map data) falls back to DRIVE where a
 * route degrades to an unsupported travel mode. Leg polylines are TomTom's raw
 * `{latitude, longitude}` point arrays converted to [lng, lat].
 */

import {
  computeTomTomRoutes,
  type TomTomInstruction,
  type TomTomLeg,
  type TomTomRoute,
  type TomTomTravelMode,
} from "../../../adapters/tomtom.adapter";
import type {
  AccessibleRoute,
  DriveLeg,
  DriveStep,
  WalkLeg,
} from "../../../types/route";
import type {
  LatLng,
  PlanRoadRouteOptions,
  RoadTravelMode,
} from "../accessible-route.types";
import { TomTomRoutingError } from "./tomtom-routing.types";

export { TomTomRoutingError } from "./tomtom-routing.types";

const TOMTOM_MODE: Record<RoadTravelMode, TomTomTravelMode> = {
  drive: "car",
  motorcycle: "motorcycle",
  walk: "pedestrian",
};

const ROUTE_LABEL: Record<RoadTravelMode, string> = {
  drive: "開車",
  motorcycle: "騎車",
  walk: "步行",
};

const MANEUVER_MAP: Record<string, string> = {
  TURN_LEFT: "TURN_LEFT",
  TURN_RIGHT: "TURN_RIGHT",
  SHARP_LEFT: "TURN_SHARP_LEFT",
  SHARP_RIGHT: "TURN_SHARP_RIGHT",
  BEAR_LEFT: "TURN_SLIGHT_LEFT",
  BEAR_RIGHT: "TURN_SLIGHT_RIGHT",
  KEEP_LEFT: "KEEP_LEFT",
  KEEP_RIGHT: "KEEP_RIGHT",
  STRAIGHT: "STRAIGHT",
  MAKE_UTURN: "UTURN_LEFT",
  ROUNDABOUT_LEFT: "ROUNDABOUT_LEFT",
  ROUNDABOUT_RIGHT: "ROUNDABOUT_RIGHT",
  DEPART: "DEPART",
};

/**
 * Convert seconds to whole minutes, matching the codebase's leg-duration
 * convention (rounded integers).
 *
 * @param sec Duration in seconds.
 * @returns The duration in minutes (rounded), or 0 when absent/invalid.
 */
function secToMin(sec: number | undefined): number {
  if (typeof sec !== "number" || !Number.isFinite(sec)) return 0;
  return Math.round(sec / 60);
}

function toLngLat(p: { latitude: number; longitude: number }): [number, number] {
  return [p.longitude, p.latitude];
}

/**
 * Bucket a driving leg's traffic level from the traffic-aware vs free-flow
 * minute ratio. Undefined when there's no meaningful traffic-aware estimate.
 *
 * @param trafficMin Traffic-aware minutes.
 * @param staticMin Free-flow minutes.
 * @returns The traffic level, or undefined when not derivable.
 */
function trafficLevel(
  trafficMin: number,
  staticMin: number,
): DriveLeg["trafficLevel"] {
  if (!trafficMin || !staticMin || trafficMin < staticMin) return undefined;
  const ratio = trafficMin / staticMin;
  if (ratio < 1.15) return "light";
  if (ratio < 1.4) return "moderate";
  return "heavy";
}

function segmentLabels(idx: number, legCount: number): [string, string] {
  const from = idx === 0 ? "起點" : `中途點 ${idx}`;
  const to = idx === legCount - 1 ? "終點" : `中途點 ${idx + 1}`;
  return [from, to];
}

/**
 * Translate a TomTom maneuver code to the Google Routes maneuver vocabulary the
 * frontend already understands, passing unknown codes through unchanged.
 *
 * @param code TomTom maneuver code.
 * @returns The mapped maneuver, the original code, or undefined when absent.
 */
function mapManeuver(code: string | undefined): string | undefined {
  if (!code) return undefined;
  return MANEUVER_MAP[code] ?? code;
}

interface RouteGeometry {
  globalPoints: [number, number][];
  legStartIdx: number[];
  legEndIdx: number[];
  legStartOffset: number[];
  legEndOffset: number[];
  legStartTime: number[];
  legEndTime: number[];
}

/**
 * Concatenate the legs' point arrays into one route-global array (dropping the
 * duplicated waypoint junction point shared by adjacent legs) and derive each
 * leg's route-global index / distance-offset / time boundaries.
 *
 * @param legs The route legs, each with points and a summary.
 * @returns The global geometry and per-leg boundaries.
 */
function buildRouteGeometry(legs: TomTomLeg[]): RouteGeometry {
  const globalPoints: [number, number][] = [];
  const legStartIdx: number[] = [];
  const legEndIdx: number[] = [];
  const legStartOffset: number[] = [];
  const legEndOffset: number[] = [];
  const legStartTime: number[] = [];
  const legEndTime: number[] = [];
  let cumOffset = 0;
  let cumTime = 0;

  legs.forEach((leg, k) => {
    const pts = leg.points ?? [];
    if (globalPoints.length === 0) {
      legStartIdx[k] = 0;
      for (const p of pts) globalPoints.push(toLngLat(p));
    } else {
      const prev = globalPoints[globalPoints.length - 1];
      const first = pts[0];
      const dup =
        !!first && prev[0] === first.longitude && prev[1] === first.latitude;
      legStartIdx[k] = dup ? globalPoints.length - 1 : globalPoints.length;
      for (const p of dup ? pts.slice(1) : pts) globalPoints.push(toLngLat(p));
    }
    legEndIdx[k] = Math.max(legStartIdx[k], globalPoints.length - 1);

    const s = leg.summary ?? {};
    legStartOffset[k] = cumOffset;
    cumOffset += s.lengthInMeters ?? 0;
    legEndOffset[k] = cumOffset;
    legStartTime[k] = cumTime;
    cumTime += s.travelTimeInSeconds ?? 0;
    legEndTime[k] = cumTime;
  });

  return {
    globalPoints,
    legStartIdx,
    legEndIdx,
    legStartOffset,
    legEndOffset,
    legStartTime,
    legEndTime,
  };
}

/**
 * Assign a route-global instruction to a leg via the half-open offset interval
 * [legStartOffset, legEndOffset) — the last leg is right-closed, so junction
 * instructions fall to the next leg.
 *
 * @param offset The instruction's route-global offset in metres.
 * @param starts Per-leg start offsets.
 * @param ends Per-leg end offsets.
 * @returns The owning leg index.
 */
function dispatchLeg(
  offset: number,
  starts: number[],
  ends: number[],
): number {
  const last = starts.length - 1;
  for (let k = 0; k <= last; k++) {
    const withinEnd = k === last ? offset <= ends[k] : offset < ends[k];
    if (offset >= starts[k] && withinEnd) return k;
  }
  return offset < starts[0] ? 0 : last;
}

/**
 * Resolve an instruction's route-global point index, preferring TomTom's
 * `pointIndex` (clamped into the leg's range) and falling back to the nearest
 * global point to the instruction's coordinate when it is missing.
 *
 * @param inst The guidance instruction.
 * @param legStart The leg's first global point index.
 * @param legEnd The leg's last global point index.
 * @param globalPoints The route-global point array.
 * @returns The chosen global point index.
 */
function resolvePointIndex(
  inst: TomTomInstruction,
  legStart: number,
  legEnd: number,
  globalPoints: [number, number][],
): number {
  const pi = inst.pointIndex;
  if (typeof pi === "number" && Number.isFinite(pi)) {
    return Math.min(Math.max(pi, legStart), legEnd);
  }
  const p = inst.point;
  if (!p) return legStart;
  let best = legStart;
  let bestDist = Infinity;
  for (let i = legStart; i <= legEnd; i++) {
    const [lng, lat] = globalPoints[i];
    const d = (lng - p.longitude) ** 2 + (lat - p.latitude) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/**
 * Derive a leg's DriveSteps from its route-global guidance instructions. Each
 * step spans one instruction to the next in-leg instruction; the final step
 * closes at the leg's route-global end boundary. All distances/durations clamp
 * to ≥0.
 *
 * @param k The leg index.
 * @param legInstrs The instructions dispatched to this leg (in route order).
 * @param geo The route geometry and per-leg boundaries.
 * @returns The mapped steps, or undefined when the leg has no instructions.
 */
function buildSteps(
  k: number,
  legInstrs: TomTomInstruction[],
  geo: RouteGeometry,
): DriveStep[] | undefined {
  if (!legInstrs.length) return undefined;
  const legStart = geo.legStartIdx[k];
  const legEnd = geo.legEndIdx[k];
  const steps: DriveStep[] = [];

  for (let j = 0; j < legInstrs.length; j++) {
    const cur = legInstrs[j];
    const curIdx = resolvePointIndex(cur, legStart, legEnd, geo.globalPoints);
    const curOffset = cur.routeOffsetInMeters ?? geo.legStartOffset[k];
    const curTime = cur.travelTimeInSeconds ?? geo.legStartTime[k];

    let nextOffset: number;
    let nextTime: number;
    let endIdx: number;
    if (j < legInstrs.length - 1) {
      const nxt = legInstrs[j + 1];
      nextOffset = nxt.routeOffsetInMeters ?? curOffset;
      nextTime = nxt.travelTimeInSeconds ?? curTime;
      endIdx = resolvePointIndex(nxt, legStart, legEnd, geo.globalPoints);
    } else {
      nextOffset = geo.legEndOffset[k];
      nextTime = geo.legEndTime[k];
      endIdx = legEnd;
    }

    const sliceStart = Math.min(curIdx, endIdx);
    const sliceEnd = Math.max(curIdx, endIdx);
    const step: DriveStep = {
      instruction: cur.message ?? "",
      distanceM: Math.max(0, nextOffset - curOffset),
      durationMin: Math.max(0, secToMin(nextTime - curTime)),
      polyline: geo.globalPoints.slice(sliceStart, sliceEnd + 1),
    };
    const maneuver = mapManeuver(cur.maneuver);
    if (maneuver) step.maneuver = maneuver;
    steps.push(step);
  }
  return steps;
}

function coordOf(leg: TomTomLeg, first: boolean): LatLng {
  const pts = leg.points ?? [];
  const p = first ? pts[0] : pts[pts.length - 1];
  return p ? { lat: p.latitude, lng: p.longitude } : { lat: 0, lng: 0 };
}

function mapWalkLeg(leg: TomTomLeg, idx: number, legCount: number): WalkLeg {
  const [from, to] = segmentLabels(idx, legCount);
  const s = leg.summary ?? {};
  return {
    type: "WALK",
    from,
    to,
    distanceM: s.lengthInMeters ?? 0,
    minutesEst: secToMin(s.travelTimeInSeconds),
    polyline: (leg.points ?? []).map(toLngLat),
    a11yFacilities: [],
  };
}

function mapDriveLeg(
  leg: TomTomLeg,
  travelMode: RoadTravelMode,
  fellBack: boolean,
  trafficAware: boolean,
  steps: DriveStep[] | undefined,
): DriveLeg {
  const s = leg.summary ?? {};
  const staticMin = secToMin(s.noTrafficTravelTimeInSeconds);
  const trafficMin = secToMin(s.travelTimeInSeconds);

  const driveLeg: DriveLeg = {
    type: travelMode === "motorcycle" ? "MOTORCYCLE" : "DRIVE",
    from: coordOf(leg, true),
    to: coordOf(leg, false),
    distanceM: s.lengthInMeters ?? 0,
    durationMin: staticMin || trafficMin,
    polyline: (leg.points ?? []).map(toLngLat),
    steps,
  };
  if (trafficAware) {
    driveLeg.durationInTrafficMin = trafficMin;
    const level = trafficLevel(trafficMin, staticMin);
    if (level) driveLeg.trafficLevel = level;
  }
  if (fellBack) driveLeg.modeFallback = "DRIVE";
  return driveLeg;
}

function mapRoute(
  route: TomTomRoute,
  travelMode: RoadTravelMode,
  fellBack: boolean,
  trafficAware: boolean,
  idx: number,
): AccessibleRoute {
  const legs = route.legs ?? [];
  const legCount = legs.length;

  let mapped: (DriveLeg | WalkLeg)[];
  if (travelMode === "walk") {
    mapped = legs.map((leg, i) => mapWalkLeg(leg, i, legCount));
  } else {
    const geo = buildRouteGeometry(legs);
    const perLeg: TomTomInstruction[][] = legs.map(() => []);
    for (const inst of route.guidance?.instructions ?? []) {
      const k = dispatchLeg(
        inst.routeOffsetInMeters ?? 0,
        geo.legStartOffset,
        geo.legEndOffset,
      );
      if (k >= 0 && k < legCount) perLeg[k].push(inst);
    }
    mapped = legs.map((leg, k) =>
      mapDriveLeg(
        leg,
        travelMode,
        fellBack,
        trafficAware,
        buildSteps(k, perLeg[k], geo),
      ),
    );
  }

  const rs = route.summary ?? {};
  const trafficMin = secToMin(rs.travelTimeInSeconds);
  const staticMin = secToMin(rs.noTrafficTravelTimeInSeconds);

  return {
    routeId: `${travelMode}-${idx}`,
    routeName: ROUTE_LABEL[travelMode],
    totalMinutes: trafficMin || staticMin || 0,
    transferCount: 0,
    legs: mapped,
    accessibilityHighlights: [],
    totalWalkDistanceM:
      travelMode === "walk"
        ? mapped.reduce(
            (sum, l) => (l.type === "WALK" ? sum + l.distanceM : sum),
            0,
          )
        : 0,
  };
}

/**
 * Plan a driving / motorcycle / walking route via the TomTom Routing API.
 * Traffic-aware for motorized modes. Motorcycle falls back to DRIVE where the
 * beta map data degrades a route, flagging each leg with `modeFallback`.
 * Returns [] when no route exists; throws TomTomRoutingError on upstream
 * failure so the caller can answer 503.
 *
 * @param origin Journey origin.
 * @param destination Journey destination.
 * @param opts Travel mode, optional ordered waypoints, optional departure time.
 * @returns The mapped candidate routes (empty when none found).
 */
export async function planTomTomRoute(
  origin: LatLng,
  destination: LatLng,
  opts: PlanRoadRouteOptions,
): Promise<AccessibleRoute[]> {
  const mode = TOMTOM_MODE[opts.travelMode];
  const trafficAware = opts.travelMode !== "walk";
  const departureTime =
    trafficAware && opts.departureTime
      ? opts.departureTime.toISOString()
      : undefined;

  const params = {
    origin,
    destination,
    waypoints: opts.waypoints,
    departureTime,
    trafficAware,
    computeAlternatives: true,
  };

  let result = await computeTomTomRoutes({ ...params, travelMode: mode });
  let fellBack = false;

  if (
    mode === "motorcycle" &&
    (result.status === "UNSUPPORTED_MODE" || result.status === "NO_ROUTE")
  ) {
    const driveResult = await computeTomTomRoutes({ ...params, travelMode: "car" });
    if (driveResult.status === "OK") {
      result = driveResult;
      fellBack = true;
    } else if (driveResult.status === "UPSTREAM_ERROR") {
      throw new TomTomRoutingError(
        "TomTom Routing API upstream error",
        driveResult.httpStatus,
      );
    } else {
      result = driveResult;
    }
  }

  if (result.status === "UPSTREAM_ERROR") {
    throw new TomTomRoutingError(
      "TomTom Routing API upstream error",
      result.httpStatus,
    );
  }
  if (result.status !== "OK") return [];

  return result.routes.map((r, i) =>
    mapRoute(r, opts.travelMode, fellBack, trafficAware, i),
  );
}
