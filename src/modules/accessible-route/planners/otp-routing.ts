/**
 * OTP2 transit planner client.
 *
 * Queries a sidecar OpenTripPlanner 2.x server (GTFS GraphQL API) and maps its
 * itineraries into AccessibleRoute so they enter the same finalizeRoutes()
 * pipeline as the GTFS graph and TDX MaaS planners. This planner does NO a11y
 * enrichment (the orchestrator enriches the final top-3) and never throws: any
 * failure returns [] so the other planners' results still serve.
 *
 * Endpoint: POST {OTP_BASE_URL}/otp/gtfs/v1  (GraphQL)
 */

import { decode } from "@googlemaps/polyline-codec";
import { GtfsTrip } from "../../../model/gtfs-trip.model";
import { haversineCoords } from "./ors";
import { taipeiHHmm, taipeiYmdDash } from "../../../config/taipei-time";
import { metroLineCode } from "../../../config/transit";
import { walkSpeedMps, type AccessibilityMode } from "../scoring";
import type {
  AccessibleRoute,
  WalkLeg,
  WalkStep,
  BusLeg,
  MetroLeg,
  ThsrLeg,
  TraLeg,
  WaitInfo,
} from "../../../types/route";

const OTP_TIMEOUT_MS = Number(process.env.OTP_TIMEOUT_MS ?? 30_000);
const OTP_NUM_ITINERARIES = 5;

const SNAP_RADIUS_M = 500;
const SNAP_CANDIDATES = 10;

const METRO_SYSTEMS = new Set([
  "TRTC",
  "KRTC",
  "TMRT",
  "NTMC",
  "KLRT",
  "TYMC",
]);

const SUPPORTED_TRANSIT_MODES = new Set([
  "BUS",
  "TROLLEYBUS",
  "RAIL",
  "SUBWAY",
  "TRAM",
  "MONORAIL",
]);

const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 60_000;
let consecutiveFailures = 0;
let circuitOpenUntil = 0;

function recordFailure(): void {
  consecutiveFailures++;
  if (consecutiveFailures >= BREAKER_THRESHOLD) {
    circuitOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
  }
}
function recordSuccess(): void {
  consecutiveFailures = 0;
  circuitOpenUntil = 0;
}

interface OtpStop {
  gtfsId: string;
  code?: string;
  lat?: number;
  lon?: number;
}
interface OtpPlace {
  name?: string;
  stop?: OtpStop | null;
}
interface OtpLeg {
  mode: string;
  startTime: number;
  endTime: number;
  duration?: number;
  distance?: number;
  from: OtpPlace;
  to: OtpPlace;
  route?: {
    gtfsId?: string;
    shortName?: string;
    longName?: string;
    type?: number;
    agency?: { gtfsId?: string };
  } | null;
  trip?: { gtfsId?: string; wheelchairAccessible?: string } | null;
  legGeometry?: { points?: string } | null;
  intermediatePlaces?: { stop?: OtpStop | null }[] | null;
  steps?: OtpStep[] | null;
}
interface OtpStep {
  distance?: number;
  lon?: number;
  lat?: number;
  relativeDirection?: string | null;
  absoluteDirection?: string | null;
  streetName?: string | null;
  area?: boolean | null;
  bogusName?: boolean | null;
}
interface OtpItinerary {
  duration: number;
  walkDistance?: number;
  legs: OtpLeg[];
}

export interface PlanOtpRouteOptions {
  departureTime?: Date;
  maxTransfers?: 0 | 1 | 2;
  mode?: AccessibilityMode;
  limit?: number;
}

function hhmm(epochMs: number): string {
  return taipeiHHmm(new Date(epochMs));
}
const ymdDash = taipeiYmdDash;

/**
 * "1:TXG123" → "TXG123" — restore the TDX id the overlay keys on.
 *
 * @param gtfsId The feed-prefixed GTFS id.
 * @returns The id with the feed prefix stripped.
 */
function stripFeedId(gtfsId: string | undefined): string {
  if (!gtfsId) return "";
  const idx = gtfsId.indexOf(":");
  return idx >= 0 ? gtfsId.slice(idx + 1) : gtfsId;
}

/**
 * System code prefix of a stripped GTFS id, e.g. "TRTC_BL12" → "TRTC".
 *
 * @param id The stripped GTFS id.
 * @returns The system code prefix.
 */
function systemFromId(id: string): string {
  const idx = id.indexOf("_");
  return idx > 0 ? id.slice(0, idx) : id;
}

/**
 * Decode OTP's Google-encoded polyline into [lng, lat] pairs (GeoJSON order).
 *
 * @param points The Google-encoded polyline string.
 * @returns The decoded [lng, lat] coordinate pairs.
 */
export function decodeOtpPolyline(points: string | undefined): [number, number][] {
  if (!points) return [];
  try {
    return decode(points, 5).map(([lat, lng]) => [lng, lat] as [number, number]);
  } catch {
    return [];
  }
}

function isTransitLeg(leg: OtpLeg): boolean {
  return leg.mode !== "WALK";
}

/**
 * Train number from a stripped rail trip id ("TRA_1003_…" → "1003").
 *
 * @param tripId The stripped rail trip id.
 * @returns The train number, or null when not parseable.
 */
function trainNoFromTripId(tripId: string): string | null {
  return tripId.match(/^(?:TRA|THSR)_(\d+)/)?.[1] ?? null;
}

const PLAN_QUERY = `
query Plan(
  $fromLat: Float!, $fromLon: Float!,
  $toLat: Float!, $toLon: Float!,
  $date: String!, $time: String!,
  $wheelchair: Boolean!, $numItineraries: Int!, $walkSpeed: Float
) {
  plan(
    from: { lat: $fromLat, lon: $fromLon }
    to: { lat: $toLat, lon: $toLon }
    date: $date
    time: $time
    wheelchair: $wheelchair
    walkSpeed: $walkSpeed
    numItineraries: $numItineraries
    transportModes: [{ mode: WALK }, { mode: TRANSIT }]
    locale: "zh-TW"
  ) {
    itineraries {
      duration
      walkDistance
      legs {
        mode
        startTime
        endTime
        duration
        distance
        from { name stop { gtfsId code lat lon } }
        to { name stop { gtfsId code lat lon } }
        route { gtfsId shortName longName type agency { gtfsId } }
        trip { gtfsId wheelchairAccessible }
        legGeometry { points }
        intermediatePlaces { stop { gtfsId } }
        steps {
          distance
          lon
          lat
          relativeDirection
          absoluteDirection
          streetName
          area
          bogusName
        }
      }
    }
  }
}`;

async function queryOtpPlan(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  departure: Date,
  wheelchair: boolean,
  walkSpeed: number,
): Promise<OtpItinerary[]> {
  const baseUrl = process.env.OTP_BASE_URL ?? "http://localhost:8080";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/otp/gtfs/v1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        query: PLAN_QUERY,
        variables: {
          fromLat: origin.lat,
          fromLon: origin.lng,
          toLat: destination.lat,
          toLon: destination.lng,
          date: ymdDash(departure),
          time: hhmm(departure.getTime()),
          wheelchair,
          walkSpeed,
          numItineraries: OTP_NUM_ITINERARIES,
        },
      }),
    });
    if (!res.ok) throw new Error(`OTP HTTP ${res.status}`);
    const json = (await res.json()) as {
      data?: { plan?: { itineraries?: OtpItinerary[] } };
      errors?: { message?: string }[];
    };
    if (json.errors?.length) {
      throw new Error(`OTP GraphQL: ${json.errors[0]?.message ?? "unknown"}`);
    }
    return json.data?.plan?.itineraries ?? [];
  } finally {
    clearTimeout(timer);
  }
}

const RAIL_GEOMETRY_QUERY = `
query RailGeom(
  $fromLat: Float!, $fromLon: Float!,
  $toLat: Float!, $toLon: Float!,
  $date: String!, $time: String!
) {
  plan(
    from: { lat: $fromLat, lon: $fromLon }
    to: { lat: $toLat, lon: $toLon }
    date: $date
    time: $time
    numItineraries: 1
    transportModes: [{ mode: WALK }, { mode: RAIL }]
    locale: "zh-TW"
  ) {
    itineraries { legs { mode legGeometry { points } } }
  }
}`;

/**
 * Real track polyline ([lng,lat], GeoJSON order) for a rail OD via OTP. Transit
 * legs are concatenated and consecutive duplicate points dropped (OTP repeats a
 * point at stop joins).
 *
 * @param from The [lat, lng] origin.
 * @param to The [lat, lng] destination.
 * @param dateYmd The service date in YYYY-MM-DD form.
 * @param timeHHmm The departure time in "HH:mm" form.
 * @returns The track polyline, or null (OTP down / no itinerary / empty).
 */
export async function fetchRailLegGeometry(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  dateYmd: string,
  timeHHmm: string,
): Promise<[number, number][] | null> {
  if (Date.now() < circuitOpenUntil) return null;
  const baseUrl = process.env.OTP_BASE_URL ?? "http://localhost:8080";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/otp/gtfs/v1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        query: RAIL_GEOMETRY_QUERY,
        variables: {
          fromLat: from.lat,
          fromLon: from.lng,
          toLat: to.lat,
          toLon: to.lng,
          date: dateYmd,
          time: timeHHmm,
        },
      }),
    });
    if (!res.ok) throw new Error(`OTP HTTP ${res.status}`);
    const json = (await res.json()) as {
      data?: {
        plan?: {
          itineraries?: {
            legs?: { mode: string; legGeometry?: { points?: string } | null }[];
          }[];
        };
      };
    };
    recordSuccess();
    const legs = json.data?.plan?.itineraries?.[0]?.legs ?? [];
    const coords: [number, number][] = [];
    for (const leg of legs) {
      if (leg.mode === "WALK") continue;
      for (const pt of decodeOtpPolyline(leg.legGeometry?.points)) {
        const last = coords[coords.length - 1];
        if (!last || last[0] !== pt[0] || last[1] !== pt[1]) coords.push(pt);
      }
    }
    return coords.length >= 2 ? coords : null;
  } catch {
    recordFailure();
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const NEARBY_STOPS_QUERY = `
query NearbyStops($lat: Float!, $lon: Float!, $radius: Int!, $first: Int!) {
  stopsByRadius(lat: $lat, lon: $lon, radius: $radius, first: $first) {
    edges {
      node {
        distance
        stop { gtfsId name lat lon routes { gtfsId } }
      }
    }
  }
}`;

interface SnapStop {
  lat: number;
  lng: number;
  name: string;
}

/**
 * Nearest stop within SNAP_RADIUS_M that has ≥1 route serving it (results come
 * back distance-ascending). Fail-soft: null on any error or no candidate.
 *
 * @param point The [lat, lng] point to snap from.
 * @returns The nearest route-bearing stop, or null.
 */
async function findSnapStop(point: {
  lat: number;
  lng: number;
}): Promise<SnapStop | null> {
  const baseUrl = process.env.OTP_BASE_URL ?? "http://localhost:8080";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/otp/gtfs/v1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        query: NEARBY_STOPS_QUERY,
        variables: {
          lat: point.lat,
          lon: point.lng,
          radius: SNAP_RADIUS_M,
          first: SNAP_CANDIDATES,
        },
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: {
        stopsByRadius?: {
          edges?: {
            node?: {
              stop?: {
                name?: string;
                lat?: number;
                lon?: number;
                routes?: unknown[];
              } | null;
            } | null;
          }[];
        };
      };
    };
    for (const edge of json.data?.stopsByRadius?.edges ?? []) {
      const stop = edge?.node?.stop;
      if (!stop?.routes?.length) continue;
      if (typeof stop.lat !== "number" || typeof stop.lon !== "number") continue;
      return { lat: stop.lat, lng: stop.lon, name: stop.name ?? "鄰近站點" };
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Straight-line walk leg bridging a real endpoint to its snapped stop.
 *
 * @param from The origin point with name and coords.
 * @param to The destination point with name and coords.
 * @param mode Accessibility mode driving the walking speed.
 * @returns The bridging WalkLeg.
 */
function snapWalkLeg(
  from: { lng: number; lat: number; name: string },
  to: { lng: number; lat: number; name: string },
  mode: AccessibilityMode,
): WalkLeg {
  const distanceM = Math.round(
    haversineCoords([from.lng, from.lat], [to.lng, to.lat]),
  );
  const speed = walkSpeedMps(mode) * 60;
  return {
    type: "WALK",
    from: from.name,
    to: to.name,
    distanceM,
    minutesEst: Math.max(1, Math.round(distanceM / speed)),
    polyline: [
      [from.lng, from.lat],
      [to.lng, to.lat],
    ],
    a11yFacilities: [],
    exitInfo: null,
  };
}

/**
 * Batched direction lookup: OTP exposes no direction_id, but the Mongo GtfsTrip
 * collection has it. Fail-soft to {}.
 *
 * @param tripIds The trip ids to look up.
 * @returns A map of trip id to direction id.
 */
async function lookupDirections(
  tripIds: string[],
): Promise<Map<string, 0 | 1>> {
  const map = new Map<string, 0 | 1>();
  if (!tripIds.length) return map;
  try {
    const trips = await GtfsTrip.find({ tripId: { $in: tripIds } })
      .select("tripId directionId")
      .lean<{ tripId: string; directionId: 0 | 1 }[]>();
    for (const t of trips) map.set(t.tripId, t.directionId ?? 0);
  } catch {
  }
  return map;
}

function walkLegFrom(leg: OtpLeg, isFirst: boolean, isLast: boolean): WalkLeg {
  const fromName =
    isFirst || leg.from.name === "Origin" ? "出發地" : leg.from.name ?? "";
  const toName =
    isLast || leg.to.name === "Destination" ? "目的地" : leg.to.name ?? "";
  const durationSec =
    leg.duration ?? Math.round((leg.endTime - leg.startTime) / 1000);
  return {
    type: "WALK",
    from: fromName,
    to: toName,
    distanceM: Math.round(leg.distance ?? 0),
    minutesEst: Math.max(1, Math.round(durationSec / 60)),
    polyline: decodeOtpPolyline(leg.legGeometry?.points),
    a11yFacilities: [],
    exitInfo: null,
    steps: (leg.steps ?? []).map(
      (s): WalkStep => ({
        relativeDirection: s.relativeDirection ?? "CONTINUE",
        absoluteDirection: s.absoluteDirection ?? null,
        streetName: s.streetName ?? "",
        bogusName: s.bogusName ?? false,
        area: s.area ?? false,
        distanceM: Math.round(s.distance ?? 0),
        location: [s.lon ?? 0, s.lat ?? 0],
      }),
    ),
  };
}

function transitLegFrom(
  leg: OtpLeg,
  estimatedWaitMinutes: number,
  directions: Map<string, 0 | 1>,
): BusLeg | MetroLeg | ThsrLeg | TraLeg {
  const routeId = stripFeedId(leg.route?.gtfsId);
  const tripId = stripFeedId(leg.trip?.gtfsId);
  const agencyId = stripFeedId(leg.route?.agency?.gtfsId);
  const routeName =
    leg.route?.shortName || leg.route?.longName || routeId || leg.mode;
  const fromName = leg.from.name ?? "";
  const toName = leg.to.name ?? "";
  const fromStopId = stripFeedId(leg.from.stop?.gtfsId);
  const toStopId = stripFeedId(leg.to.stop?.gtfsId);
  const departureTime = hhmm(leg.startTime);
  const arrivalTime = hhmm(leg.endTime);
  const rideMinutes = Math.max(
    1,
    Math.round((leg.endTime - leg.startTime) / 60000),
  );
  const polyline = decodeOtpPolyline(leg.legGeometry?.points);
  const direction = directions.get(tripId) ?? 0;
  const waitInfo: WaitInfo = { time: departureTime, source: "schedule" };

  const system = systemFromId(routeId);
  const isMetro =
    leg.mode === "SUBWAY" || leg.mode === "TRAM" || METRO_SYSTEMS.has(system);
  const isThsr =
    agencyId === "THSR" || system === "THSR" || tripId.startsWith("THSR");
  const isRail = leg.mode === "RAIL" || isThsr || system === "TRA";

  if (isMetro) {
    return {
      type: "METRO",
      railSystem: system,
      lineId: metroLineCode(system, routeId),
      lineName: routeName,
      lineUid: routeId,
      departureStation: fromName,
      arrivalStation: toName,
      departureStationUid: fromStopId,
      arrivalStationUid: toStopId,
      direction,
      stopsCount: (leg.intermediatePlaces?.length ?? 0) + 1,
      rideMinutes,
      departureTime,
      arrivalTime,
      waitInfo,
      estimatedWaitMinutes,
      polyline,
      departureStationA11y: [],
      arrivalStationA11y: [],
      facilityHighlights: [],
    };
  }

  if (isRail) {
    const trainNo = trainNoFromTripId(tripId) ?? routeName;
    if (isThsr) {
      return {
        type: "THSR",
        trainNo,
        departureStation: fromName,
        arrivalStation: toName,
        departureStationUID: fromStopId,
        arrivalStationUID: toStopId,
        departureTime,
        arrivalTime,
        rideMinutes,
        waitInfo,
        estimatedWaitMinutes,
        polyline,
        departureStationA11y: [],
        arrivalStationA11y: [],
        facilityHighlights: [],
      };
    }
    return {
      type: "TRA",
      trainNo,
      trainTypeName: leg.route?.longName ?? "",
      departureStation: fromName,
      arrivalStation: toName,
      departureStationUID: fromStopId,
      arrivalStationUID: toStopId,
      departureTime,
      arrivalTime,
      rideMinutes,
      waitInfo,
      estimatedWaitMinutes,
      polyline,
      departureStationA11y: [],
      arrivalStationA11y: [],
      facilityHighlights: [],
    };
  }

  return {
    type: "BUS",
    routeName,
    departureStop: fromName,
    arrivalStop: toName,
    departureStopId: fromStopId || undefined,
    arrivalStopId: toStopId || undefined,
    departureTime,
    arrivalTime,
    waitInfo,
    estimatedWaitMinutes,
    direction,
    polyline,
    departureStopA11y: [],
    arrivalStopA11y: [],
  };
}

/**
 * Plan transit routes via the OTP2 sidecar. Output is AccessibleRoute-compatible
 * and un-enriched (no a11y arrays, no highlights) — finalizeRoutes() handles
 * scoring, enrichment and overlays downstream. Fail-soft: [] on any error.
 *
 * @param origin The [lat, lng] origin.
 * @param destination The [lat, lng] destination.
 * @param opts Planning options (departure time, transfer cap, mode, limit).
 * @returns The planned AccessibleRoute-compatible routes.
 */
export async function planOtpRoute(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  opts?: PlanOtpRouteOptions,
): Promise<AccessibleRoute[]> {
  if (Date.now() < circuitOpenUntil) return [];

  const departure = opts?.departureTime ?? new Date();
  const mode = opts?.mode ?? "normal";
  const wheelchair = mode === "wheelchair";
  const walkSpeed = walkSpeedMps(mode);

  let itineraries: OtpItinerary[];
  try {
    itineraries = await queryOtpPlan(
      origin,
      destination,
      departure,
      wheelchair,
      walkSpeed,
    );
    recordSuccess();
  } catch (err) {
    recordFailure();
    console.warn("[otp-routing] plan query failed (fail-soft to [])", err);
    return [];
  }

  let snapPre: WalkLeg | null = null;
  let snapPost: WalkLeg | null = null;
  if (!itineraries.length) {
    const [originSnap, destSnap] = await Promise.all([
      findSnapStop(origin),
      findSnapStop(destination),
    ]);
    if (originSnap || destSnap) {
      try {
        itineraries = await queryOtpPlan(
          originSnap ?? origin,
          destSnap ?? destination,
          departure,
          wheelchair,
          walkSpeed,
        );
      } catch (err) {
        recordFailure();
        console.warn("[otp-routing] snap retry failed (fail-soft to [])", err);
        return [];
      }
      if (itineraries.length) {
        console.info(
          `[otp-routing] empty plan recovered by stop snap` +
            (originSnap ? ` origin→${originSnap.name}` : "") +
            (destSnap ? ` dest→${destSnap.name}` : ""),
        );
        if (originSnap) {
          snapPre = snapWalkLeg(
            { ...origin, name: "出發地" },
            originSnap,
            mode,
          );
        }
        if (destSnap) {
          snapPost = snapWalkLeg(
            destSnap,
            { ...destination, name: "目的地" },
            mode,
          );
        }
      }
    }
  }

  const maxTransfers = opts?.maxTransfers;
  const queryDate = ymdDash(departure);
  const allTripIds = [
    ...new Set(
      itineraries.flatMap((it) =>
        it.legs
          .filter(isTransitLeg)
          .map((l) => stripFeedId(l.trip?.gtfsId))
          .filter(Boolean),
      ),
    ),
  ];
  const directions = await lookupDirections(allTripIds);

  const out: AccessibleRoute[] = [];
  for (const [i, it] of itineraries.entries()) {
    const transitOtpLegs = it.legs.filter(isTransitLeg);
    if (!transitOtpLegs.length) continue;
    if (transitOtpLegs.some((l) => !SUPPORTED_TRANSIT_MODES.has(l.mode)))
      continue;
    if (
      maxTransfers !== undefined &&
      transitOtpLegs.length - 1 > maxTransfers
    )
      continue;

    const legs: (WalkLeg | BusLeg | MetroLeg | ThsrLeg | TraLeg)[] = [];
    const transitLegs: (BusLeg | MetroLeg | ThsrLeg | TraLeg)[] = [];
    let clockMs = departure.getTime();
    for (const [j, leg] of it.legs.entries()) {
      if (!isTransitLeg(leg)) {
        if ((leg.distance ?? 0) > 0) {
          const wl = walkLegFrom(leg, j === 0, j === it.legs.length - 1);
          if (j === 0 && snapPre) wl.from = snapPre.to;
          if (j === it.legs.length - 1 && snapPost) wl.to = snapPost.from;
          legs.push(wl);
        }
        clockMs = leg.endTime;
        continue;
      }
      const waitMinutes = Math.max(
        0,
        Math.round((leg.startTime - clockMs) / 60000),
      );
      const mapped = transitLegFrom(leg, waitMinutes, directions);
      clockMs = leg.endTime;
      legs.push(mapped);
      transitLegs.push(mapped);
    }

    const routeName = transitLegs
      .map((l) =>
        l.type === "BUS"
          ? l.routeName
          : l.type === "METRO"
            ? l.lineName
            : l.trainNo,
      )
      .join(" → ");

    const firstDepDate = ymdDash(new Date(transitOtpLegs[0].startTime));

    if (snapPre) legs.unshift({ ...snapPre });
    if (snapPost) legs.push({ ...snapPost });
    const snapMinutes =
      (snapPre?.minutesEst ?? 0) + (snapPost?.minutesEst ?? 0);

    out.push({
      routeId: `otp-${i}-${stripFeedId(transitOtpLegs[0].trip?.gtfsId) || "unknown"}`,
      routeName: routeName || "OTP Route",
      totalMinutes: Math.max(1, Math.round(it.duration / 60)) + snapMinutes,
      transferCount: transitLegs.length - 1,
      legs,
      accessibilityHighlights: [],
      ...(firstDepDate !== queryDate ? { departureDate: firstDepDate } : {}),
    });
  }

  return out.slice(0, opts?.limit ?? OTP_NUM_ITINERARIES);
}
