/**
 * OTP2 transit planner client (Phase 16, spec: FUNCTIONAL_SPEC_OTP2_INTEGRATION.md).
 *
 * Queries a sidecar OpenTripPlanner 2.x server (GTFS GraphQL API) and maps its
 * itineraries into AccessibleRoute so they enter the same finalizeRoutes()
 * pipeline as the GTFS graph and TDX MaaS planners. This planner does NO a11y
 * enrichment (spec §8.1 — the orchestrator enriches the final top-3) and never
 * throws: any failure returns [] so the other planners' results still serve.
 *
 * Endpoint: POST {OTP_BASE_URL}/otp/gtfs/v1  (GraphQL)
 */

import { decode } from "@googlemaps/polyline-codec";
import { GtfsTrip } from "../model/gtfs-trip.model";
import { haversineCoords, WHEELCHAIR_SPEED_M_PER_MIN } from "./ors.service";
import { taipeiHHmm, taipeiYmdDash } from "../config/taipei-time";
import { metroLineCode } from "../config/transit";
import type { AccessibilityMode } from "../config/a11y-scoring";
import type {
  AccessibleRoute,
  WalkLeg,
  BusLeg,
  MetroLeg,
  ThsrLeg,
  TraLeg,
  WaitInfo,
} from "../types/route";

// The timeout guards against HUNG connections only — a dead OTP container
// rejects instantly (ECONNREFUSED) and trips the circuit breaker, so a
// generous ceiling costs nothing on the fail-soft path. It must absorb
// event-loop starvation too: when planGtfsRoute's CPU-heavy joins block the
// loop, an expired abort timer runs BEFORE the already-arrived response's
// I/O callback and would kill a successful query (observed with 12s).
const OTP_TIMEOUT_MS = Number(process.env.OTP_TIMEOUT_MS ?? 30_000);
const OTP_NUM_ITINERARIES = 5;

// Snap-to-stop fallback: when plan() returns no itineraries, the usual cause is
// the endpoint linking onto a disconnected street island (station plazas — the
// OSM footways around e.g. 台中車站 don't connect back to the road grid), so
// EVERY access leg dies. Retry once from the nearest stop that has at least one
// route serving it — stops without routes (orphaned station entities, platforms
// of feeds with no trips) often sit on the same island and can't board anyway.
const SNAP_RADIUS_M = 500;
const SNAP_CANDIDATES = 10;
const WALK_SPEED_M_PER_MIN = 75;

// Same set as gtfs-router.service.ts — OTP route gtfsIds carry the TDX system
// code as their leading segment once the feed prefix is stripped.
const METRO_SYSTEMS = new Set([
  "TRTC",
  "KRTC",
  "TMRT",
  "NTMC",
  "KLRT",
  "TYMC",
]);

// The national TDX feed also carries ferries (route_type 4) and domestic air
// (1102), which AccessibleRoute does not model (gtfs-router likewise drops
// ferry). Itineraries using any other mode are discarded whole.
const SUPPORTED_TRANSIT_MODES = new Set([
  "BUS",
  "TROLLEYBUS",
  "RAIL",
  "SUBWAY",
  "TRAM",
  "MONORAIL",
]);

// ── Circuit breaker (spec §9): after consecutive failures stop hitting OTP for
// a cooldown window so a dead container costs ~0ms instead of 3s per request.
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

// ── Raw response shapes (only fields we consume) ──
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
  mode: string; // WALK | BUS | RAIL | SUBWAY | TRAM | …
  startTime: number; // epoch ms
  endTime: number; // epoch ms
  duration?: number; // seconds
  distance?: number; // meters
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
}
interface OtpItinerary {
  duration: number; // seconds
  walkDistance?: number;
  legs: OtpLeg[];
}

export interface PlanOtpRouteOptions {
  /** Departure time; controller already clamps past times → undefined (= now). */
  departureTime?: Date;
  maxTransfers?: 0 | 1 | 2;
  mode?: AccessibilityMode;
  limit?: number;
}

// ── Time formatting: OTP returns epoch ms; the feed runs on Asia/Taipei ──

function hhmm(epochMs: number): string {
  return taipeiHHmm(new Date(epochMs));
}
const ymdDash = taipeiYmdDash;

/** "1:TXG123" → "TXG123" — restore the TDX id the Phase 15 overlay keys on. */
function stripFeedId(gtfsId: string | undefined): string {
  if (!gtfsId) return "";
  const idx = gtfsId.indexOf(":");
  return idx >= 0 ? gtfsId.slice(idx + 1) : gtfsId;
}

/** System code prefix of a stripped GTFS id, e.g. "TRTC_BL12" → "TRTC". */
function systemFromId(id: string): string {
  const idx = id.indexOf("_");
  return idx > 0 ? id.slice(0, idx) : id;
}

/** Decode OTP's Google-encoded polyline into [lng, lat] pairs (GeoJSON order). */
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

/** Train number from a stripped rail trip id ("TRA_1003_…" → "1003"). */
function trainNoFromTripId(tripId: string): string | null {
  return tripId.match(/^(?:TRA|THSR)_(\d+)/)?.[1] ?? null;
}

// ── GraphQL ──

const PLAN_QUERY = `
query Plan(
  $fromLat: Float!, $fromLon: Float!,
  $toLat: Float!, $toLon: Float!,
  $date: String!, $time: String!,
  $wheelchair: Boolean!, $numItineraries: Int!
) {
  plan(
    from: { lat: $fromLat, lon: $fromLon }
    to: { lat: $toLat, lon: $toLon }
    date: $date
    time: $time
    wheelchair: $wheelchair
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
      }
    }
  }
}`;

async function queryOtpPlan(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  departure: Date,
  wheelchair: boolean,
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

// ── Snap-to-stop fallback ──

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

/** Straight-line walk leg bridging a real endpoint to its snapped stop. */
function snapWalkLeg(
  from: { lng: number; lat: number; name: string },
  to: { lng: number; lat: number; name: string },
  wheelchair: boolean,
): WalkLeg {
  const distanceM = Math.round(
    haversineCoords([from.lng, from.lat], [to.lng, to.lat]),
  );
  const speed = wheelchair ? WHEELCHAIR_SPEED_M_PER_MIN : WALK_SPEED_M_PER_MIN;
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

// ── Leg mapping (spec §7) ──

/**
 * Batched direction lookup: OTP exposes no direction_id, but the Mongo GtfsTrip
 * collection (kept for stop geo / overlay, spec §5) has it. Fail-soft to {}.
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
    /* direction degrades to 0 — collapse key falls back to routeName */
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
  // WaitInfo contract: schedule source carries the "HH:mm" departure clock.
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

  // default: bus (mode BUS / route type 3)
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

// ── Public API ──

/**
 * Plan transit routes via the OTP2 sidecar. Output is AccessibleRoute-compatible
 * and un-enriched (no a11y arrays, no highlights) — finalizeRoutes() handles
 * scoring, enrichment and overlays downstream. Fail-soft: [] on any error.
 */
export async function planOtpRoute(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  opts?: PlanOtpRouteOptions,
): Promise<AccessibleRoute[]> {
  if (Date.now() < circuitOpenUntil) return [];

  const departure = opts?.departureTime ?? new Date();
  const wheelchair = opts?.mode === "wheelchair";

  let itineraries: OtpItinerary[];
  try {
    itineraries = await queryOtpPlan(origin, destination, departure, wheelchair);
    recordSuccess();
  } catch (err) {
    recordFailure();
    console.warn("[otp-routing] plan query failed (fail-soft to [])", err);
    return [];
  }

  // Empty plan → snap endpoints to the nearest route-bearing stop and retry
  // once (street-island linking failure; see SNAP_RADIUS_M comment).
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
            wheelchair,
          );
        }
        if (destSnap) {
          snapPost = snapWalkLeg(
            destSnap,
            { ...destination, name: "目的地" },
            wheelchair,
          );
        }
      }
    }
  }

  // OTP has no transfer cap — filter in Node (spec §6.2).
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
    if (!transitOtpLegs.length) continue; // walk-only: not a transit route
    if (transitOtpLegs.some((l) => !SUPPORTED_TRANSIT_MODES.has(l.mode)))
      continue; // ferry / air / other unmodelled modes
    if (
      maxTransfers !== undefined &&
      transitOtpLegs.length - 1 > maxTransfers
    )
      continue;

    const legs: (WalkLeg | BusLeg | MetroLeg | ThsrLeg | TraLeg)[] = [];
    const transitLegs: (BusLeg | MetroLeg | ThsrLeg | TraLeg)[] = [];
    // Wait baseline: query time for the first leg, then each leg's endTime.
    let clockMs = departure.getTime();
    for (const [j, leg] of it.legs.entries()) {
      if (!isTransitLeg(leg)) {
        // Drop zero-length transfer connectors, keep real walks.
        if ((leg.distance ?? 0) > 0) {
          const wl = walkLegFrom(leg, j === 0, j === it.legs.length - 1);
          // Snapped endpoints: the itinerary starts/ends at the snap stop, not
          // the user's true origin/destination — those are covered by the
          // synthetic legs added below.
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

    // Cross-midnight itineraries carry the service date (departureDate 慣例).
    const firstDepDate = ymdDash(new Date(transitOtpLegs[0].startTime));

    // Bridge legs for snapped endpoints (cloned — enrichment mutates legs).
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
