/**
 * Google Routes API planner — the non-transit path (drive / motorcycle / walk).
 * Maps directions/v2:computeRoutes itineraries to the shared AccessibleRoute
 * shape (DRIVE / MOTORCYCLE legs, or WALK legs for walking). Traffic-aware
 * durations come from routingPreference + departureTime. Motorcycle
 * (TWO_WHEELER) falls back to DRIVE where the region doesn't support it.
 */

import { decode } from "@googlemaps/polyline-codec";
import {
  computeGoogleRoutes,
  type GoogleLatLng,
  type GoogleRoute,
  type GoogleRouteLeg,
  type GoogleRouteStep,
  type GoogleTravelMode,
} from "../../../adapters/google.adapter";
import type {
  AccessibleRoute,
  DriveLeg,
  DriveStep,
  WalkLeg,
} from "../../../types/route";
import type {
  LatLng,
  PlanGoogleRouteOptions,
  RoadTravelMode,
} from "../accessible-route.types";
import { GoogleRoutingError } from "./google-routing.types";

export { GoogleRoutingError } from "./google-routing.types";

const GOOGLE_MODE: Record<RoadTravelMode, GoogleTravelMode> = {
  drive: "DRIVE",
  motorcycle: "TWO_WHEELER",
  walk: "WALK",
};

const ROUTE_LABEL: Record<RoadTravelMode, string> = {
  drive: "開車",
  motorcycle: "騎車",
  walk: "步行",
};

/**
 * Decode a Google-encoded polyline to [lng, lat] points (the codebase's leg
 * polyline convention). Precision 5 matches the Routes API and OTP.
 *
 * @param encoded Encoded polyline string.
 * @returns The decoded [lng, lat] points, or [] on missing/invalid input.
 */
function decodePolyline(encoded: string | undefined): [number, number][] {
  if (!encoded) return [];
  try {
    return decode(encoded, 5).map(
      ([lat, lng]) => [lng, lat] as [number, number],
    );
  } catch {
    return [];
  }
}

/**
 * Parse a Routes API duration string ("1234s") to whole minutes.
 *
 * @param s Duration string, e.g. "1234s".
 * @returns The duration in minutes (rounded), or 0 when absent/invalid.
 */
function durationToMinutes(s: string | undefined): number {
  if (!s) return 0;
  const sec = parseInt(s, 10);
  return Number.isFinite(sec) ? Math.round(sec / 60) : 0;
}

function coordOf(latLng: GoogleLatLng | undefined): LatLng | null {
  if (
    latLng &&
    typeof latLng.latitude === "number" &&
    typeof latLng.longitude === "number"
  ) {
    return { lat: latLng.latitude, lng: latLng.longitude };
  }
  return null;
}

/**
 * Bucket a driving leg's traffic level from the traffic-aware vs free-flow
 * duration ratio. Undefined when there's no meaningful traffic-aware estimate.
 *
 * @param trafficMin Traffic-aware minutes (Routes API duration).
 * @param staticMin Free-flow minutes (Routes API staticDuration).
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

function mapSteps(steps: GoogleRouteStep[] | undefined): DriveStep[] | undefined {
  if (!steps?.length) return undefined;
  return steps.map((s) => {
    const step: DriveStep = {
      instruction: s.navigationInstruction?.instructions ?? "",
      distanceM: s.distanceMeters ?? 0,
      durationMin: durationToMinutes(s.staticDuration),
      polyline: decodePolyline(s.polyline?.encodedPolyline),
    };
    if (s.navigationInstruction?.maneuver) {
      step.maneuver = s.navigationInstruction.maneuver;
    }
    return step;
  });
}

function mapWalkLeg(
  leg: GoogleRouteLeg,
  idx: number,
  legCount: number,
): WalkLeg {
  const [from, to] = segmentLabels(idx, legCount);
  return {
    type: "WALK",
    from,
    to,
    distanceM: leg.distanceMeters ?? 0,
    minutesEst: durationToMinutes(leg.staticDuration ?? leg.duration),
    polyline: decodePolyline(leg.polyline?.encodedPolyline),
    a11yFacilities: [],
  };
}

function mapDriveLeg(
  leg: GoogleRouteLeg,
  travelMode: RoadTravelMode,
  fellBack: boolean,
): DriveLeg {
  const polyline = decodePolyline(leg.polyline?.encodedPolyline);
  const firstPt = polyline[0];
  const lastPt = polyline[polyline.length - 1];
  const from =
    coordOf(leg.startLocation?.latLng) ??
    (firstPt ? { lat: firstPt[1], lng: firstPt[0] } : { lat: 0, lng: 0 });
  const to =
    coordOf(leg.endLocation?.latLng) ??
    (lastPt ? { lat: lastPt[1], lng: lastPt[0] } : { lat: 0, lng: 0 });

  const staticMin = durationToMinutes(leg.staticDuration);
  const trafficMin = durationToMinutes(leg.duration);

  const driveLeg: DriveLeg = {
    type: travelMode === "motorcycle" ? "MOTORCYCLE" : "DRIVE",
    from,
    to,
    distanceM: leg.distanceMeters ?? 0,
    durationMin: staticMin || trafficMin,
    polyline,
    steps: mapSteps(leg.steps),
  };
  if (trafficMin) {
    driveLeg.durationInTrafficMin = trafficMin;
    const level = trafficLevel(trafficMin, staticMin);
    if (level) driveLeg.trafficLevel = level;
  }
  if (fellBack) driveLeg.modeFallback = "DRIVE";
  return driveLeg;
}

function mapRoute(
  route: GoogleRoute,
  travelMode: RoadTravelMode,
  fellBack: boolean,
  idx: number,
): AccessibleRoute {
  const rawLegs = route.legs ?? [];
  const legCount = rawLegs.length;
  const legs =
    travelMode === "walk"
      ? rawLegs.map((leg, i) => mapWalkLeg(leg, i, legCount))
      : rawLegs.map((leg) => mapDriveLeg(leg, travelMode, fellBack));

  const trafficMin = durationToMinutes(route.duration);
  const staticMin = durationToMinutes(route.staticDuration);
  const totalMinutes = trafficMin || staticMin || 0;

  const label = ROUTE_LABEL[travelMode];
  const routeName = route.description
    ? `${label}（經 ${route.description}）`
    : label;

  return {
    routeId: `${travelMode}-${idx}`,
    routeName,
    totalMinutes,
    transferCount: 0,
    legs,
    accessibilityHighlights: [],
    totalWalkDistanceM:
      travelMode === "walk"
        ? legs.reduce(
            (sum, l) => (l.type === "WALK" ? sum + l.distanceM : sum),
            0,
          )
        : 0,
  };
}

/**
 * Plan a driving / motorcycle / walking route via the Google Routes API.
 * Traffic-aware for motorized modes when a future departure time is given.
 * Motorcycle (TWO_WHEELER) falls back to DRIVE where unavailable, flagging each
 * leg with `modeFallback`. Returns [] when no route exists; throws
 * GoogleRoutingError on upstream failure so the caller can answer 503.
 *
 * @param origin Journey origin.
 * @param destination Journey destination.
 * @param opts Travel mode, optional ordered waypoints, optional departure time.
 * @returns The mapped candidate routes (empty when none found).
 */
export async function planGoogleRoute(
  origin: LatLng,
  destination: LatLng,
  opts: PlanGoogleRouteOptions,
): Promise<AccessibleRoute[]> {
  const googleMode = GOOGLE_MODE[opts.travelMode];
  const trafficAware = opts.travelMode !== "walk";
  const departureTime =
    trafficAware && opts.departureTime
      ? opts.departureTime.toISOString()
      : undefined;

  const params = {
    origin,
    destination,
    intermediates: opts.waypoints,
    departureTime,
    trafficAware,
    computeAlternatives: true,
  };

  let result = await computeGoogleRoutes({ ...params, travelMode: googleMode });
  let fellBack = false;

  if (
    googleMode === "TWO_WHEELER" &&
    (result.status === "UNSUPPORTED_MODE" || result.status === "NO_ROUTE")
  ) {
    const driveResult = await computeGoogleRoutes({
      ...params,
      travelMode: "DRIVE",
    });
    if (driveResult.status === "OK") {
      result = driveResult;
      fellBack = true;
    } else if (driveResult.status === "UPSTREAM_ERROR") {
      throw new GoogleRoutingError(
        "Google Routes API upstream error",
        driveResult.httpStatus,
      );
    } else {
      result = driveResult;
    }
  }

  if (result.status === "UPSTREAM_ERROR") {
    throw new GoogleRoutingError(
      "Google Routes API upstream error",
      result.httpStatus,
    );
  }
  if (result.status !== "OK") return [];

  return result.routes.map((r, i) => mapRoute(r, opts.travelMode, fellBack, i));
}
