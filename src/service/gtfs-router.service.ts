/**
 * GTFS-based transit router (Functional Spec Phase 7).
 *
 * Replaces the query-time TDX route/timetable calls in accessible-route.service.ts
 * with a pre-imported GTFS graph in MongoDB. Provides:
 *
 *   - Calendar resolution (which service_ids run on a given date)
 *   - Nearest route-network stop lookup (location_type 0/2)
 *   - Direct connection finding (one trip serving boardStop → alightStop in order)
 *   - One-transfer connection finding via same-station transfer hubs
 *   - Shape-derived polylines for transit legs
 *   - Mapping GTFS connections → AccessibleRoute legs
 *
 * ── Data-model notes (verified against data/gtfs/) ──
 *  • This feed has TWO disjoint stop namespaces:
 *      1. Route-network stops (used in stop_times): e.g. "TRTC_BL12", location_type=0,
 *         NO parent_station. Same physical station across lines is identified by an
 *         identical stop_name (+ proximity), NOT parent_station.
 *      2. Indoor/pathway stops (used in pathways): numeric ids, location_type 1/2/3,
 *         linked by parent_station. Not referenced by stop_times — handled by the
 *         Indoor Graph layer, not here.
 *  • Metro/rail trips are schedule-based (absolute stop_times). Buses may be
 *    headway-based (frequencies.txt). Both paths are supported.
 *  • No transfers.txt: transfer hubs are derived from matching stop_name + distance.
 */

import { GtfsStop } from "../model/gtfs-stop.model";
import { GtfsStopTime } from "../model/gtfs-stop-time.model";
import { GtfsTrip } from "../model/gtfs-trip.model";
import { GtfsRoute } from "../model/gtfs-route.model";
import { GtfsCalendar } from "../model/gtfs-calendar.model";
import { GtfsFrequency } from "../model/gtfs-frequency.model";
import { GtfsShape } from "../model/gtfs-shape.model";
import { StationCluster } from "../model/station-cluster.model";
import OsmA11y from "../model/osm-a11y.model";
import {
  orsWalkingRoute,
  haversineCoords,
  WHEELCHAIR_SPEED_M_PER_MIN,
} from "../config/ors";
import {
  taipeiYmd,
  taipeiYmdDash,
  taipeiWeekday,
  taipeiSecondsOfDay,
  addTaipeiDays,
} from "../config/taipei-time";
import { getStationAccess, AccessibilityMode } from "./indoor-graph.service";
import type { IOsmA11y } from "../types";

// Leg/route types live in the accessible-route module. Import as TYPES only so
// this service does not create a runtime circular dependency with the orchestrator.
import type {
  AccessibleRoute,
  WalkLeg,
  BusLeg,
  MetroLeg,
  ThsrLeg,
  TraLeg,
  WaitInfo,
} from "../modules/accessible-route/accessible-route.service";

// ─────────────────────────────────────────────────────────────────────────────
// Tunables
// ─────────────────────────────────────────────────────────────────────────────

const NEAR_RADIUS_M = 2000; // bus boarding/alighting radius
const RAIL_NEAR_RADIUS_M = 10000; // rail/metro radius — stations are sparse and
// users travel to them (esp. intercity HSR, whose stations sit far from the
// city-centre TRA station a place name often geocodes to, e.g. 台中車站 vs 烏日高鐵)
const MAX_NEAR_STOPS = 12; // bus boarding/alighting stops considered per endpoint
const MAX_NEAR_RAIL_STOPS = 25; // rail/metro stops considered per endpoint (kept separate
// so dense bus stops never crowd out the sparse-but-important rail network).
// Generous because some nearby rail stations carry no schedule in the feed
// (e.g. TRA/TMRT have stops but no stop_times) and would otherwise fill the
// slots, crowding out a scheduled-but-distant station (e.g. intercity HSR).
// Schedule-less stops self-eliminate in findDirectConnections (no trips found).

/** Metro / HSR / TRA route-network stopId prefixes (all use "<SYSTEM>_…"). */
const RAIL_STOP_ID_REGEX = /^(TRTC|KRTC|KLRT|TYMC|TMRT|NTMC|THSR|TRA)_/;
const TRANSFER_SAME_STATION_M = 200; // two route-network stops = same station if within this
const CLUSTER_TRANSFER_MAX_M = 600; // looser bound for stops in the SAME StationCluster
// (bus↔rail members can sit ~300-500m apart; the transfer walk time is still
// computed from the actual distance, so the bound only gates feasibility)
const MAX_DIRECT_RESULTS = 10; // direct connections returned before scoring
const MAX_TRANSFER_HUB_TRIPS = 40; // cap origin/dest trips scanned for transfer hubs
const MIN_TRANSFER_WALK_SEC = 90; // floor for in-station transfer walk
const MAX_TRANSFER_WAIT_SEC = 30 * 60; // discard leg2 departing > 30 min after leg1 arrival
const SECONDS_PER_DAY = 24 * 3600;

// ─────────────────────────────────────────────────────────────────────────────
// Time helpers
// ─────────────────────────────────────────────────────────────────────────────

/** "HH:MM:SS" (may exceed "24:00:00" for after-midnight trips) → seconds since service-day midnight. */
export function gtfsTimeToSeconds(t: string): number {
  const parts = t.split(":");
  if (parts.length < 2) return NaN;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  const s = parts[2] ? parseInt(parts[2], 10) : 0;
  if (isNaN(h) || isNaN(m) || isNaN(s)) return NaN;
  return h * 3600 + m * 60 + s;
}

/** Seconds since midnight → "HH:mm" (wraps past 24h for display). */
export function secondsToHHmm(sec: number): string {
  const wrapped = ((sec % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY;
  const h = Math.floor(wrapped / 3600);
  const m = Math.floor((wrapped % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Taipei-date "YYYYMMDD" for calendar comparison. */
const toYmd = taipeiYmd;

/** Taipei-date "YYYY-MM-DD" for display / AccessibleRoute.departureDate. */
const ymdDash = taipeiYmdDash;

/** A new Date n calendar days after the given date. */
const addDays = addTaipeiDays;

const WEEKDAY_FIELDS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Calendar resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the set of service_ids active on the given date, applying calendar.txt
 * weekday/range plus calendar_dates.txt exceptions (type 1 = added, type 2 = removed).
 */
export async function getActiveServiceIds(date: Date): Promise<Set<string>> {
  const ymd = toYmd(date);
  const weekdayField = WEEKDAY_FIELDS[taipeiWeekday(date)];

  // Candidate docs: either the date is in [start,end] range, OR an exception names it.
  const docs = await GtfsCalendar.find({
    $or: [
      { startDate: { $lte: ymd }, endDate: { $gte: ymd } },
      { "exceptions.date": ymd },
    ],
  }).lean();

  const active = new Set<string>();
  for (const doc of docs) {
    const inRange = doc.startDate <= ymd && doc.endDate >= ymd;
    const runsWeekday = inRange && Boolean((doc as any)[weekdayField]);

    let isActive = runsWeekday;
    const exception = doc.exceptions?.find((e) => e.date === ymd);
    if (exception) {
      if (exception.exceptionType === 1) isActive = true; // service added
      else if (exception.exceptionType === 2) isActive = false; // service removed
    }
    if (isActive) active.add(doc.serviceId);
  }
  return active;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stop lookup
// ─────────────────────────────────────────────────────────────────────────────

export interface GtfsStopNear {
  stopId: string;
  stopName: string;
  coords: [number, number]; // [lng, lat]
  distanceM: number;
  locationType: 0 | 1 | 2 | 3;
}

/** Nearest route-network stops (location_type 0/2) to a point, ascending by distance. */
export async function findNearestGtfsStops(
  point: { lat: number; lng: number },
  opts?: { radiusM?: number; limit?: number }
): Promise<GtfsStopNear[]> {
  const busRadiusM = opts?.radiusM ?? NEAR_RADIUS_M;
  const railRadiusM = opts?.radiusM ?? RAIL_NEAR_RADIUS_M;
  const busLimit = opts?.limit ?? MAX_NEAR_STOPS;

  // Route-network stops only: location_type=0 AND no parent_station.
  // (Indoor-pathway nodes — entrances, platform sub-nodes — also use
  // location_type 0/2 but carry a parent_station and are NOT in stop_times.)
  //
  // Query rail/metro and bus separately, with different radii: there are ~154k
  // route-network stops, overwhelmingly bus, so a single nearest-N query buries
  // the sparse rail/metro stations — which for intercity rail may sit several km
  // from the geocoded point.
  const near = (radiusM: number) => ({
    locationType: 0 as const,
    parentStation: null,
    location: {
      $near: {
        $geometry: { type: "Point", coordinates: [point.lng, point.lat] },
        $maxDistance: radiusM,
      },
    },
  });

  const [railCandidates, busCandidates] = await Promise.all([
    // Over-fetch rail candidates, then keep only those actually served by a trip.
    // Many nearby rail stops carry no schedule in the feed (TRA/TMRT/NTMC have
    // stops but no stop_times) and would otherwise crowd out a scheduled-but-
    // distant station (intercity HSR). Data-driven: future TRA schedules just work.
    GtfsStop.find({ ...near(railRadiusM), stopId: { $regex: RAIL_STOP_ID_REGEX } })
      .limit(MAX_NEAR_RAIL_STOPS * 4)
      .lean(),
    GtfsStop.find(near(busRadiusM))
      .limit(busLimit * 6)
      .lean(),
  ]);

  // The bus limit counts DISTINCT stop names, keeping every same-named
  // duplicate (TPE/NWT dual registrations, opposite bays — they serve
  // different routes). Without this, six copies of one stop exhaust the
  // slots and the actually-useful stop across the street never makes it.
  const busDocs: typeof busCandidates = [];
  const busNames = new Set<string>();
  for (const d of busCandidates) {
    if (!busNames.has(d.stopName)) {
      if (busNames.size >= busLimit) continue;
      busNames.add(d.stopName);
    }
    busDocs.push(d);
  }

  const railIds = railCandidates.map((s) => s.stopId);
  const servedRailIds = new Set<string>(
    railIds.length
      ? ((await GtfsStopTime.find({ stopId: { $in: railIds } }).distinct(
          "stopId"
        )) as string[])
      : []
  );
  const railDocs = railCandidates
    .filter((s) => servedRailIds.has(s.stopId))
    .slice(0, MAX_NEAR_RAIL_STOPS);

  const seen = new Set<string>();
  const out: GtfsStopNear[] = [];
  for (const d of [...railDocs, ...busDocs]) {
    if (seen.has(d.stopId)) continue;
    seen.add(d.stopId);
    const coords: [number, number] = [d.stopLon, d.stopLat];
    out.push({
      stopId: d.stopId,
      stopName: d.stopName,
      coords,
      distanceM: Math.round(haversineCoords([point.lng, point.lat], coords)),
      locationType: d.locationType,
    });
  }
  return out.sort((a, b) => a.distanceM - b.distanceM);
}

/**
 * stopId → clusterId for the given stops (single indexed query against the
 * offline-built StationCluster collection). Stops outside any cluster are
 * absent from the map — callers fall back to exact stop_name matching.
 */
async function getClusterKeys(stopIds: string[]): Promise<Map<string, string>> {
  if (!stopIds.length) return new Map();
  const map = new Map<string, string>();
  try {
    const docs = await StationCluster.find({
      memberStopIds: { $in: stopIds },
    })
      .select("clusterId memberStopIds")
      .lean();
    const wanted = new Set(stopIds);
    for (const d of docs) {
      for (const id of d.memberStopIds) {
        if (wanted.has(id)) map.set(id, d.clusterId);
      }
    }
  } catch {
    /* collection missing → name matching only */
  }
  return map;
}

/**
 * Route-network stops representing the SAME physical station as `stopId`
 * (identical stop_name within TRANSFER_SAME_STATION_M). Used as transfer hubs —
 * parent_station is NOT used here (it only links indoor-pathway nodes).
 */
export async function findSameStationStops(
  stopId: string
): Promise<GtfsStopNear[]> {
  const anchor = await GtfsStop.findOne({ stopId }).lean();
  if (!anchor) return [];
  const anchorCoords: [number, number] = [anchor.stopLon, anchor.stopLat];

  const sameName = await GtfsStop.find({
    stopName: anchor.stopName,
    locationType: 0,
    parentStation: null,
  }).lean();

  const out: GtfsStopNear[] = [];
  for (const d of sameName) {
    const coords: [number, number] = [d.stopLon, d.stopLat];
    const dist = haversineCoords(anchorCoords, coords);
    if (dist <= TRANSFER_SAME_STATION_M) {
      out.push({
        stopId: d.stopId,
        stopName: d.stopName,
        coords,
        distanceM: Math.round(dist),
        locationType: d.locationType,
      });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shape polyline
// ─────────────────────────────────────────────────────────────────────────────

/** Index of the shape coordinate nearest to `target`. */
function nearestCoordIndex(
  coords: [number, number][],
  target: [number, number]
): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const d = haversineCoords(coords[i], target);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Polyline for the segment of a shape between the board and alight coordinates.
 * Falls back to a straight [from, to] line if the shape is missing.
 */
export async function getShapePolyline(
  shapeId: string | undefined,
  fromCoord: [number, number],
  toCoord: [number, number]
): Promise<[number, number][]> {
  if (!shapeId) return [fromCoord, toCoord];
  const shape = await GtfsShape.findOne({ shapeId }).lean();
  const coords = shape?.geometry?.coordinates as [number, number][] | undefined;
  if (!coords || coords.length < 2) return [fromCoord, toCoord];

  let i = nearestCoordIndex(coords, fromCoord);
  let j = nearestCoordIndex(coords, toCoord);
  if (i > j) [i, j] = [j, i];
  const slice = coords.slice(i, j + 1);
  return slice.length >= 2 ? slice : [fromCoord, toCoord];
}

// ─────────────────────────────────────────────────────────────────────────────
// Direct connection finding (core)
// ─────────────────────────────────────────────────────────────────────────────

export interface GtfsConnection {
  tripId: string;
  routeId: string;
  routeShortName: string;
  routeLongName: string;
  routeType: 1 | 2 | 3 | 4;
  agencyId: string;
  direction: 0 | 1;
  shapeId?: string;
  fromStopId: string;
  fromStopName: string;
  fromCoords: [number, number];
  toStopId: string;
  toStopName: string;
  toCoords: [number, number];
  departureSec: number;
  arrivalSec: number;
  departureTime: string; // "HH:mm"
  arrivalTime: string; // "HH:mm"
  rideMinutes: number;
  stopsCount: number;
  isFrequency: boolean;
  headwaySecs?: number;
}

type StopEvent = { tripId: string; seq: number; sec: number };

/** Next absolute departure of a headway-based trip at a stop, given the trip's anchor. */
function nextFrequencyDeparture(
  freqRows: { startTime: string; endTime: string; headwaySecs: number }[],
  offsetSec: number,
  afterSec: number
): { departureSec: number; headwaySecs: number } | null {
  let best: { departureSec: number; headwaySecs: number } | null = null;
  for (const f of freqRows) {
    const start = gtfsTimeToSeconds(f.startTime);
    const end = gtfsTimeToSeconds(f.endTime);
    if (isNaN(start) || isNaN(end) || f.headwaySecs <= 0) continue;

    // Earliest instance start so that (instanceStart + offset) >= afterSec.
    const minStart = Math.max(start, afterSec - offsetSec);
    const k = Math.max(0, Math.ceil((minStart - start) / f.headwaySecs));
    const instanceStart = start + k * f.headwaySecs;
    if (instanceStart > end) continue; // window exhausted

    const dep = instanceStart + offsetSec;
    if (!best || dep < best.departureSec) {
      best = { departureSec: dep, headwaySecs: f.headwaySecs };
    }
  }
  return best;
}

/**
 * Direct connections: a single trip that serves some boardStop BEFORE some
 * alightStop (stop_sequence order), on a service active today, departing at/after
 * `afterSec`. Deduped to the earliest departure per (routeId, direction).
 */
export async function findDirectConnections(
  fromStopIds: string[],
  toStopIds: string[],
  afterSec: number,
  activeServiceIds: Set<string>,
  opts?: { limit?: number; routeTypes?: Array<1 | 2 | 3 | 4> }
): Promise<GtfsConnection[]> {
  const limit = opts?.limit ?? MAX_DIRECT_RESULTS;
  if (!fromStopIds.length || !toStopIds.length) return [];

  // Board / alight stop_time events keyed by tripId.
  const [fromRows, toRows] = await Promise.all([
    GtfsStopTime.find({ stopId: { $in: fromStopIds } })
      .select("tripId stopId stopSequence departureTime")
      .lean(),
    GtfsStopTime.find({ stopId: { $in: toStopIds } })
      .select("tripId stopId stopSequence arrivalTime")
      .lean(),
  ]);

  const boardByTrip = new Map<string, StopEvent & { stopId: string }>();
  for (const r of fromRows) {
    const sec = gtfsTimeToSeconds(r.departureTime);
    const prev = boardByTrip.get(r.tripId);
    // keep the earliest-sequence board event for the trip
    if (!prev || r.stopSequence < prev.seq) {
      boardByTrip.set(r.tripId, {
        tripId: r.tripId,
        seq: r.stopSequence,
        sec,
        stopId: r.stopId,
      });
    }
  }

  const alightByTrip = new Map<string, StopEvent & { stopId: string }>();
  for (const r of toRows) {
    const sec = gtfsTimeToSeconds(r.arrivalTime);
    const prev = alightByTrip.get(r.tripId);
    // keep the latest-sequence alight event for the trip
    if (!prev || r.stopSequence > prev.seq) {
      alightByTrip.set(r.tripId, {
        tripId: r.tripId,
        seq: r.stopSequence,
        sec,
        stopId: r.stopId,
      });
    }
  }

  // Candidate trips serve both, board before alight.
  const candidateTripIds: string[] = [];
  for (const [tripId, board] of boardByTrip) {
    const alight = alightByTrip.get(tripId);
    if (alight && board.seq < alight.seq) candidateTripIds.push(tripId);
  }
  if (!candidateTripIds.length) return [];

  // Resolve trips → active services only.
  const trips = await GtfsTrip.find({
    tripId: { $in: candidateTripIds },
  }).lean();
  const activeTrips = trips.filter((t) => activeServiceIds.has(t.serviceId));
  if (!activeTrips.length) return [];

  // Route metadata.
  const routeIds = [...new Set(activeTrips.map((t) => t.routeId))];
  const routes = await GtfsRoute.find({ routeId: { $in: routeIds } }).lean();
  const routeById = new Map(routes.map((r) => [r.routeId, r]));

  // Frequency rows + anchors for headway-based trips.
  const activeTripIds = activeTrips.map((t) => t.tripId);
  const freqRows = await GtfsFrequency.find({
    tripId: { $in: activeTripIds },
  }).lean();
  const freqByTrip = new Map<string, typeof freqRows>();
  for (const f of freqRows) {
    const arr = freqByTrip.get(f.tripId) ?? [];
    arr.push(f);
    freqByTrip.set(f.tripId, arr);
  }
  // Trip anchor (first stop departure) needed to offset headway departures.
  const anchorByTrip = new Map<string, number>();
  if (freqByTrip.size) {
    const anchors = await Promise.all(
      [...freqByTrip.keys()].map((tripId) =>
        GtfsStopTime.findOne({ tripId })
          .sort({ stopSequence: 1 })
          .select("departureTime")
          .lean()
          .then((d) => ({ tripId, sec: d ? gtfsTimeToSeconds(d.departureTime) : 0 }))
      )
    );
    for (const a of anchors) anchorByTrip.set(a.tripId, a.sec);
  }

  // Stop coords/names for the board & alight nodes we actually used.
  const usedStopIds = new Set<string>();
  for (const t of activeTrips) {
    const b = boardByTrip.get(t.tripId);
    const a = alightByTrip.get(t.tripId);
    if (b) usedStopIds.add(b.stopId);
    if (a) usedStopIds.add(a.stopId);
  }
  const stopDocs = await GtfsStop.find({
    stopId: { $in: [...usedStopIds] },
  })
    .select("stopId stopName stopLat stopLon")
    .lean();
  const stopById = new Map(stopDocs.map((s) => [s.stopId, s]));

  const connections: GtfsConnection[] = [];
  for (const trip of activeTrips) {
    const route = routeById.get(trip.routeId);
    if (!route) continue;
    if (opts?.routeTypes && !opts.routeTypes.includes(route.routeType)) continue;

    const board = boardByTrip.get(trip.tripId)!;
    const alight = alightByTrip.get(trip.tripId)!;
    const fromStop = stopById.get(board.stopId);
    const toStop = stopById.get(alight.stopId);
    if (!fromStop || !toStop) continue;

    let departureSec = board.sec;
    let arrivalSec = alight.sec;
    let headwaySecs: number | undefined;
    const isFrequency = freqByTrip.has(trip.tripId);

    if (isFrequency) {
      const anchor = anchorByTrip.get(trip.tripId) ?? board.sec;
      const offset = board.sec - anchor;
      const next = nextFrequencyDeparture(
        freqByTrip.get(trip.tripId)!,
        offset,
        afterSec
      );
      if (!next) continue; // no service in remaining windows
      const rideSec = alight.sec - board.sec;
      departureSec = next.departureSec;
      arrivalSec = departureSec + rideSec;
      headwaySecs = next.headwaySecs;
    } else {
      if (isNaN(departureSec) || departureSec < afterSec) continue;
    }

    connections.push({
      tripId: trip.tripId,
      routeId: route.routeId,
      routeShortName: route.routeShortName,
      routeLongName: route.routeLongName,
      routeType: route.routeType,
      agencyId: route.agencyId,
      direction: (trip.directionId ?? 0) as 0 | 1,
      shapeId: trip.shapeId,
      fromStopId: fromStop.stopId,
      fromStopName: fromStop.stopName,
      fromCoords: [fromStop.stopLon, fromStop.stopLat],
      toStopId: toStop.stopId,
      toStopName: toStop.stopName,
      toCoords: [toStop.stopLon, toStop.stopLat],
      departureSec,
      arrivalSec,
      departureTime: secondsToHHmm(departureSec),
      arrivalTime: secondsToHHmm(arrivalSec),
      rideMinutes: Math.max(1, Math.round((arrivalSec - departureSec) / 60)),
      stopsCount: alight.seq - board.seq,
      isFrequency,
      headwaySecs,
    });
  }

  // Dedupe to earliest departure per (route, direction); sort by departure.
  const bestByRoute = new Map<string, GtfsConnection>();
  for (const c of connections) {
    const key = `${c.routeId}|${c.direction}`;
    const prev = bestByRoute.get(key);
    if (!prev || c.departureSec < prev.departureSec) bestByRoute.set(key, c);
  }
  return [...bestByRoute.values()]
    .sort((a, b) => a.departureSec - b.departureSec)
    .slice(0, limit);
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection → AccessibleRoute leg
// ─────────────────────────────────────────────────────────────────────────────

const METRO_SYSTEMS = new Set([
  "TRTC",
  "KRTC",
  "TMRT",
  "NTMC",
  "KLRT",
  "TYMC",
]);

/** System code prefix of a GTFS id, e.g. "TRTC_BL12" → "TRTC". */
function systemFromId(id: string): string {
  const idx = id.indexOf("_");
  return idx > 0 ? id.slice(0, idx) : id;
}

/** Line identity ignoring direction — metro naming is "A－B" / "B－A". */
function lineKey(c: GtfsConnection): string {
  return (c.routeShortName || c.routeLongName).split("－").sort().join("－");
}

/**
 * Re-boarding the same line (same route, or the reverse-direction variant) is
 * never a sensible transfer: same direction should be a direct route, reverse
 * is backtracking.
 */
function sameLine(a: GtfsConnection, b: GtfsConnection): boolean {
  return a.routeId === b.routeId || lineKey(a) === lineKey(b);
}

function waitFromConnection(
  conn: GtfsConnection,
  afterSec: number
): { waitInfo: WaitInfo; estimatedWaitMinutes: number } {
  // Both fixed and headway trips derive the wait from the schedule clock:
  // conn.departureSec is already the next departure at/after `afterSec`
  // (nextFrequencyDeparture resolves headway trips), so the displayed
  // departureTime and the numeric estimate can never disagree.
  const minutes = Math.max(0, Math.round((conn.departureSec - afterSec) / 60));
  return {
    waitInfo: { time: conn.departureTime, source: "schedule" },
    estimatedWaitMinutes: minutes,
  };
}

/**
 * Map a GTFS connection to the matching AccessibleRoute leg variant.
 * A11y facility arrays and TDX-specific UIDs are left empty/best-effort here;
 * the orchestrator enriches them. Returns null for unsupported route types (ferry).
 */
export async function connectionToLeg(
  conn: GtfsConnection,
  afterSec: number
): Promise<BusLeg | MetroLeg | ThsrLeg | TraLeg | null> {
  const polyline = await getShapePolyline(
    conn.shapeId,
    conn.fromCoords,
    conn.toCoords
  );
  const { waitInfo, estimatedWaitMinutes } = waitFromConnection(conn, afterSec);

  // Bus
  if (conn.routeType === 3) {
    const leg: BusLeg = {
      type: "BUS",
      routeName: conn.routeShortName || conn.routeLongName,
      departureStop: conn.fromStopName,
      arrivalStop: conn.toStopName,
      departureStopId: conn.fromStopId,
      arrivalStopId: conn.toStopId,
      departureTime: conn.departureTime,
      arrivalTime: conn.arrivalTime,
      waitInfo,
      estimatedWaitMinutes,
      direction: conn.direction,
      polyline,
      departureStopA11y: [],
      arrivalStopA11y: [],
    };
    return leg;
  }

  // Metro
  if (conn.routeType === 1 || METRO_SYSTEMS.has(systemFromId(conn.routeId))) {
    const leg: MetroLeg = {
      type: "METRO",
      railSystem: systemFromId(conn.routeId),
      lineName: conn.routeShortName || conn.routeLongName,
      lineUid: conn.routeId,
      departureStation: conn.fromStopName,
      arrivalStation: conn.toStopName,
      departureStationUid: conn.fromStopId,
      arrivalStationUid: conn.toStopId,
      direction: conn.direction,
      stopsCount: conn.stopsCount,
      rideMinutes: conn.rideMinutes,
      departureTime: conn.departureTime,
      arrivalTime: conn.arrivalTime,
      waitInfo,
      estimatedWaitMinutes,
      polyline,
      departureStationA11y: [],
      arrivalStationA11y: [],
      facilityHighlights: [],
    };
    return leg;
  }

  // Rail: distinguish THSR from TRA by agency / id prefix.
  if (conn.routeType === 2) {
    // Rail tripIds embed the actual train number ("TRA_1003",
    // "THSR_0108_1_…") — routeShortName is only the line description
    // (e.g. "潮州-七堵"), useless as a TrainLiveBoard key (Phase 15).
    const tripTrainNo = conn.tripId.match(/^(?:TRA|THSR)_(\d+)/)?.[1];
    const isThsr =
      conn.agencyId === "THSR" || conn.routeId.startsWith("THSR");
    if (isThsr) {
      const leg: ThsrLeg = {
        type: "THSR",
        trainNo: tripTrainNo || conn.routeShortName || conn.tripId,
        departureStation: conn.fromStopName,
        arrivalStation: conn.toStopName,
        departureStationUID: conn.fromStopId,
        arrivalStationUID: conn.toStopId,
        departureTime: conn.departureTime,
        arrivalTime: conn.arrivalTime,
        rideMinutes: conn.rideMinutes,
        waitInfo,
        estimatedWaitMinutes,
        polyline,
        departureStationA11y: [],
        arrivalStationA11y: [],
        facilityHighlights: [],
      };
      return leg;
    }
    const leg: TraLeg = {
      type: "TRA",
      trainNo: tripTrainNo || conn.routeShortName || conn.tripId,
      trainTypeName: conn.routeLongName,
      departureStation: conn.fromStopName,
      arrivalStation: conn.toStopName,
      departureStationUID: conn.fromStopId,
      arrivalStationUID: conn.toStopId,
      departureTime: conn.departureTime,
      arrivalTime: conn.arrivalTime,
      rideMinutes: conn.rideMinutes,
      waitInfo,
      estimatedWaitMinutes,
      polyline,
      departureStationA11y: [],
      arrivalStationA11y: [],
      facilityHighlights: [],
    };
    return leg;
  }

  return null; // ferry / unsupported
}

// ─────────────────────────────────────────────────────────────────────────────
// Accessibility enrichment (OsmA11y) — mirrors the TDX path so GTFS routes
// score comparably and surface in the final top-3.
// ─────────────────────────────────────────────────────────────────────────────

const A11Y_RADIUS_M = 200;
const A11Y_LIMIT = 5;

/** Nearby OSM accessibility facilities around a stop coordinate. */
export async function nearbyA11y(coords: [number, number]): Promise<IOsmA11y[]> {
  return OsmA11y.find({
    location: {
      $near: {
        $geometry: { type: "Point", coordinates: coords },
        $maxDistance: A11Y_RADIUS_M,
      },
    },
  })
    .limit(A11Y_LIMIT)
    .lean() as Promise<IOsmA11y[]>;
}

/** Derive route-level accessibility highlights (same rules as the TDX path). */
export function deriveHighlights(
  boardA11y: IOsmA11y[],
  alightA11y: IOsmA11y[]
): string[] {
  const tagVal = (nodes: IOsmA11y[], key: string, val: string) =>
    nodes.some((f) => f.tags?.[key] === val);
  const hasCat = (nodes: IOsmA11y[], ...cats: string[]) =>
    nodes.some((f) => cats.includes(f.category));

  const h: string[] = [];
  if (hasCat(boardA11y, "elevator") || tagVal(boardA11y, "elevator", "yes"))
    h.push("乘車站附近有電梯");
  if (hasCat(alightA11y, "elevator") || tagVal(alightA11y, "elevator", "yes"))
    h.push("下車站附近有電梯");
  if (hasCat(boardA11y, "kerb_cut", "ramp")) h.push("乘車站附近有無障礙坡道");
  if (hasCat(alightA11y, "kerb_cut", "ramp")) h.push("下車站附近有無障礙坡道");
  if (
    tagVal(boardA11y, "toilets:wheelchair", "yes") ||
    tagVal(alightA11y, "toilets:wheelchair", "yes")
  )
    h.push("站點附近有無障礙廁所");
  if (
    tagVal(boardA11y, "tactile_paving", "yes") ||
    tagVal(alightA11y, "tactile_paving", "yes")
  )
    h.push("附近有導盲磚");
  if (
    tagVal(boardA11y, "traffic_signals:sound", "yes") ||
    tagVal(alightA11y, "traffic_signals:sound", "yes")
  )
    h.push("附近有音響號誌");
  if (tagVal(boardA11y, "wheelchair", "yes")) h.push("乘車站設施完善");
  if (tagVal(alightA11y, "wheelchair", "yes")) h.push("下車站設施完善");
  return h;
}

/** Attach board/alight a11y arrays to a transit leg (field name varies by type). */
export function attachA11yToLeg(
  leg: BusLeg | MetroLeg | ThsrLeg | TraLeg,
  boardA11y: IOsmA11y[],
  alightA11y: IOsmA11y[]
): void {
  if (leg.type === "BUS") {
    leg.departureStopA11y = boardA11y;
    leg.arrivalStopA11y = alightA11y;
  } else {
    leg.departureStationA11y = boardA11y;
    leg.arrivalStationA11y = alightA11y;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Indoor Graph enrichment (Phase 8) — step-free exit/elevator guidance per
// rail station, derived from GTFS pathways. System-agnostic: works for any
// station with indoor data (TRTC/NTMC/KLRT/TMRT/KRTC/TYMC/THSR/TRA).
// ─────────────────────────────────────────────────────────────────────────────

/** Rail leg types that carry station-level indoor data worth enriching. */
type RailLeg = MetroLeg | ThsrLeg | TraLeg;

function isRailLeg(leg: BusLeg | MetroLeg | ThsrLeg | TraLeg): leg is RailLeg {
  return leg.type === "METRO" || leg.type === "THSR" || leg.type === "TRA";
}

/**
 * Enrich a rail leg + its adjacent walk legs with indoor-graph guidance:
 *  • the in-station walk to the boarding station gets `exitInfo` (nearest
 *    step-free entrance + elevator info), and likewise the walk OUT of the
 *    alighting station;
 *  • the rail leg's `facilityHighlights` gains step-free / elevator notes.
 *
 * Best-effort and non-throwing: stations without indoor data are left untouched.
 * Gated by env so the extra DB work can be disabled (USE_INDOOR_GRAPH=false).
 */
export async function enrichLegIndoor(
  leg: RailLeg,
  walkIn: WalkLeg | null,
  walkOut: WalkLeg | null,
  originCoords: [number, number],
  destCoords: [number, number],
  boardCoords: [number, number],
  alightCoords: [number, number],
  mode: AccessibilityMode = "wheelchair"
): Promise<void> {
  if (process.env.USE_INDOOR_GRAPH === "false") return;

  const boardName = leg.departureStation;
  const alightName = leg.arrivalStation;

  const [board, alight] = await Promise.all([
    getStationAccess({ name: boardName, coords: boardCoords }, originCoords, mode),
    getStationAccess({ name: alightName, coords: alightCoords }, destCoords, mode),
  ]);

  const exitTypeFor = (a: NonNullable<typeof board>) =>
    (a.usesElevator ? "elevator" : "ramp") as "elevator" | "ramp";

  if (board?.entrance) {
    // Only advertise a specific exit when it is a PROVEN step-free entrance —
    // otherwise the nearest entrance may be stairs-only, which would mislead.
    if (walkIn && board.stepFree) {
      walkIn.exitInfo = {
        exitName: board.entrance.name,
        exitNumber: board.entrance.exitNumber,
        type: exitTypeFor(board),
        coords: board.entrance.coords,
      };
    }
    if (board.stepFree && board.usesElevator) {
      leg.facilityHighlights.push(
        `乘車站「${board.stationName}」可由${board.entrance.name}電梯無障礙進站` +
          (board.elevatorLevelName ? `（${board.elevatorLevelName}）` : "")
      );
    } else if (board.stepFree) {
      leg.facilityHighlights.push(
        `乘車站「${board.stationName}」${board.entrance.name}為無障礙平面進站`
      );
    } else if (board.hasElevator) {
      leg.facilityHighlights.push(`乘車站「${board.stationName}」設有電梯`);
    }
  }

  if (alight?.entrance) {
    if (walkOut && alight.stepFree) {
      walkOut.exitInfo = {
        exitName: alight.entrance.name,
        exitNumber: alight.entrance.exitNumber,
        type: exitTypeFor(alight),
        coords: alight.entrance.coords,
      };
    }
    if (alight.stepFree && alight.usesElevator) {
      leg.facilityHighlights.push(
        `下車站「${alight.stationName}」可由${alight.entrance.name}電梯無障礙出站` +
          (alight.elevatorLevelName ? `（${alight.elevatorLevelName}）` : "")
      );
    } else if (alight.stepFree) {
      leg.facilityHighlights.push(
        `下車站「${alight.stationName}」${alight.entrance.name}為無障礙平面出站`
      );
    } else if (alight.hasElevator) {
      leg.facilityHighlights.push(`下車站「${alight.stationName}」設有電梯`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// First/last-mile walk legs (ORS)
// ─────────────────────────────────────────────────────────────────────────────

async function buildWalkLeg(
  from: { coords: [number, number]; label: string },
  to: { coords: [number, number]; label: string },
  wheelchair = true
): Promise<WalkLeg> {
  // Same-point transfer (e.g. boarding the next trip at the very same platform
  // stop): skip ORS entirely — a zero-length request yields NaN summaries.
  const directM = haversineCoords(from.coords, to.coords);
  if (directM < 5) {
    return {
      type: "WALK",
      from: from.label,
      to: to.label,
      distanceM: 0,
      minutesEst: 0,
      polyline: [from.coords, to.coords],
      a11yFacilities: [],
      exitInfo: null,
    };
  }

  const route = await orsWalkingRoute(from.coords, to.coords, wheelchair);
  const distanceM = Number.isFinite(route.distanceM)
    ? Math.round(route.distanceM)
    : Math.round(directM);
  const minutesEst = Number.isFinite(route.durationSec)
    ? Math.max(1, Math.round(route.durationSec / 60))
    : Math.max(1, Math.round(distanceM / WHEELCHAIR_SPEED_M_PER_MIN));
  return {
    type: "WALK",
    from: from.label,
    to: to.label,
    distanceM,
    minutesEst,
    polyline: route.polyline?.length >= 2 ? route.polyline : [from.coords, to.coords],
    a11yFacilities: [],
    exitInfo: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// High-level route planning
// ─────────────────────────────────────────────────────────────────────────────

const PROGRESS_MARGIN_M = 150; // minimum geographic progress a ride must make
const AT_ENDPOINT_M = 400; // board/alight within this of an endpoint is "at" it
const MIN_ACCESS_WALK_BUDGET_M = 2500; // walk budget floor for short journeys

/**
 * Cap on walkIn + walkOut per route: walking farther than the entire
 * origin→destination crow-flies distance to reach transit is never sensible
 * (the rider should just walk). Catches the 10 km rail-radius pathology where
 * a route walks 7 km to a TRA station and 11 km out the other end while the
 * ride itself is directionally "fine".
 */
function accessWalkBudgetM(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number }
): number {
  const direct = haversineCoords(
    [origin.lng, origin.lat],
    [destination.lng, destination.lat]
  );
  return Math.max(MIN_ACCESS_WALK_BUDGET_M, direct);
}

/**
 * Geographic sanity check for a journey's (first board, last alight) pair.
 * The origin and destination candidate sets overlap (the rail search radius is
 * 10 km), so the trip join can pair a board stop NEAR THE DESTINATION with an
 * alight stop far from it — e.g. walk past the school to 台中車站, ride to
 * 新烏日, walk all the way back. Two rejections:
 *  1. the ride ends no closer to the destination than it began;
 *  2. boarding farther from the origin than the alight stop is (the rider
 *     walked past the goal and is riding backwards).
 * Both are waived when the stop in question sits practically AT the endpoint.
 */
function ridesToward(
  boardCoords: [number, number],
  alightCoords: [number, number],
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number }
): boolean {
  const o: [number, number] = [origin.lng, origin.lat];
  const d: [number, number] = [destination.lng, destination.lat];
  const alightToDest = haversineCoords(alightCoords, d);
  if (
    alightToDest > AT_ENDPOINT_M &&
    alightToDest > haversineCoords(boardCoords, d) - PROGRESS_MARGIN_M
  )
    return false;
  const boardToOrigin = haversineCoords(boardCoords, o);
  if (
    boardToOrigin > AT_ENDPOINT_M &&
    boardToOrigin > haversineCoords(alightCoords, o) + PROGRESS_MARGIN_M
  )
    return false;
  return true;
}

export interface PlanGtfsRouteOptions {
  departureTime?: Date;
  /** 0–2 transfers (Phase 12). Two-transfer search only runs when direct +
   *  one-transfer yield fewer than 3 routes. */
  maxTransfers?: 0 | 1 | 2;
  routeTypes?: Array<1 | 2 | 3 | 4>;
  limit?: number;
  /** Accessibility mode (Phase 11): selects the ORS walking profile
   *  (wheelchair vs foot-walking) and the indoor-graph traversal rules.
   *  Defaults to "wheelchair" to preserve the original conservative behaviour. */
  mode?: AccessibilityMode;
}

/**
 * Plan accessible transit routes between two points using the GTFS graph.
 * Produces complete AccessibleRoute objects: ORS walk leg → transit leg(s) →
 * ORS walk leg. A11y enrichment and scoring are applied downstream by the
 * accessible-route orchestrator.
 */
export async function planGtfsRoute(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  opts?: PlanGtfsRouteOptions
): Promise<AccessibleRoute[]> {
  const now = opts?.departureTime ?? new Date();
  const nowSec = taipeiSecondsOfDay(now);
  const maxTransfers = opts?.maxTransfers ?? 0;
  const mode = opts?.mode ?? "wheelchair";
  const wheelchairWalk = mode === "wheelchair";
  const walkBudgetM = accessWalkBudgetM(origin, destination);

  // Boarding/alighting candidate stops are day-independent — resolve once.
  const [originStops, destStops] = await Promise.all([
    findNearestGtfsStops(origin),
    findNearestGtfsStops(destination),
  ]);
  if (!originStops.length || !destStops.length) return [];

  // Search a single service day. afterSec filters departures; isNextDay tags the
  // route (and stamps departureDate) when we've rolled past today.
  const searchDay = async (
    serviceDate: Date,
    afterSec: number,
    isNextDay: boolean
  ): Promise<AccessibleRoute[]> => {
    const activeServiceIds = await getActiveServiceIds(serviceDate);
    if (!activeServiceIds.size) return [];
    const dateStr = ymdDash(serviceDate);
    const routes: AccessibleRoute[] = [];

    const direct = await findDirectConnections(
      originStops.map((s) => s.stopId),
      destStops.map((s) => s.stopId),
      afterSec,
      activeServiceIds,
      { routeTypes: opts?.routeTypes, limit: opts?.limit ?? MAX_DIRECT_RESULTS }
    );

    for (const conn of direct) {
      if (!ridesToward(conn.fromCoords, conn.toCoords, origin, destination))
        continue;
      const transitLeg = await connectionToLeg(conn, afterSec);
      if (!transitLeg) continue;
      const [walkIn, walkOut, boardA11y, alightA11y] = await Promise.all([
        buildWalkLeg(
          { coords: [origin.lng, origin.lat], label: "出發地" },
          { coords: conn.fromCoords, label: conn.fromStopName },
          wheelchairWalk
        ),
        buildWalkLeg(
          { coords: conn.toCoords, label: conn.toStopName },
          { coords: [destination.lng, destination.lat], label: "目的地" },
          wheelchairWalk
        ),
        nearbyA11y(conn.fromCoords),
        nearbyA11y(conn.toCoords),
      ]);
      if (walkIn.distanceM + walkOut.distanceM > walkBudgetM) continue;
      attachA11yToLeg(transitLeg, boardA11y, alightA11y);
      walkIn.a11yFacilities = boardA11y;
      walkOut.a11yFacilities = alightA11y;
      if (isRailLeg(transitLeg)) {
        await enrichLegIndoor(
          transitLeg,
          walkIn,
          walkOut,
          [origin.lng, origin.lat],
          [destination.lng, destination.lat],
          conn.fromCoords,
          conn.toCoords,
          mode
        );
      }
      const legs = [walkIn, transitLeg, walkOut];
      const transitMinutes = transitLeg.estimatedWaitMinutes + conn.rideMinutes;
      const totalMinutes =
        walkIn.minutesEst + transitMinutes + walkOut.minutesEst;
      const highlights = deriveHighlights(boardA11y, alightA11y);
      if (isNextDay) highlights.unshift(`🕒 今日班次已過，顯示 ${dateStr} 最早班次`);
      const route = assembleRoute(
        `gtfs-direct-${conn.tripId}`,
        conn.routeShortName || conn.routeLongName,
        legs,
        0,
        totalMinutes,
        highlights
      );
      if (isNextDay) route.departureDate = dateStr;
      routes.push(route);
    }

    if (maxTransfers >= 1) {
      const transferRoutes = await findOneTransferRoutes(
        origin,
        destination,
        originStops,
        destStops,
        afterSec,
        activeServiceIds,
        opts
      );
      for (const r of transferRoutes) {
        if (isNextDay) {
          r.departureDate = dateStr;
          r.accessibilityHighlights.unshift(
            `🕒 今日班次已過，顯示 ${dateStr} 最早班次`
          );
        }
      }
      routes.push(...transferRoutes);
    }

    // Phase 12: two-transfer search is a fallback — only when simpler options
    // leave the top-3 unfilled (it is the most expensive query path).
    if (maxTransfers >= 2 && routes.length < 3) {
      const twoTransferRoutes = await findTwoTransferRoutes(
        origin,
        destination,
        originStops,
        destStops,
        afterSec,
        activeServiceIds,
        opts
      );
      for (const r of twoTransferRoutes) {
        if (isNextDay) {
          r.departureDate = dateStr;
          r.accessibilityHighlights.unshift(
            `🕒 今日班次已過，顯示 ${dateStr} 最早班次`
          );
        }
      }
      routes.push(...twoTransferRoutes);
    }
    return routes;
  };

  // Today from now; if nothing left today, roll forward to the next service day
  // (earliest departures) instead of returning empty.
  const todayRoutes = await searchDay(now, nowSec, false);
  if (todayRoutes.length) return todayRoutes;

  const tomorrow = addDays(now, 1);
  return searchDay(tomorrow, 0, true);
}

/** Assemble an AccessibleRoute from legs and a precomputed total duration. */
function assembleRoute(
  routeId: string,
  routeName: string,
  legs: (WalkLeg | BusLeg | MetroLeg | ThsrLeg | TraLeg)[],
  transferCount: number,
  totalMinutes: number,
  accessibilityHighlights: string[] = []
): AccessibleRoute {
  return {
    routeId,
    routeName: routeName || "GTFS Route",
    totalMinutes: Math.max(1, Math.round(totalMinutes)),
    transferCount,
    legs,
    accessibilityHighlights,
  };
}

/**
 * One-transfer routes via same-station transfer hubs.
 *
 * Strategy (bounded): take the best few direct-reachable stops from the origin
 * side and the best few that reach the destination, find hubs where an origin
 * trip's alight stop and a destination trip's board stop are the SAME physical
 * station (matching stop_name within distance), then keep combos where the
 * second leg departs after the first arrives (+ transfer walk).
 */
async function findOneTransferRoutes(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  originStops: GtfsStopNear[],
  destStops: GtfsStopNear[],
  afterSec: number,
  activeServiceIds: Set<string>,
  opts?: PlanGtfsRouteOptions
): Promise<AccessibleRoute[]> {
  const originStopIds = originStops.map((s) => s.stopId);
  const destStopIds = destStops.map((s) => s.stopId);

  // Trips boardable from origin, and the downstream stops they reach (transfer candidates).
  const originBoard = await GtfsStopTime.find({
    stopId: { $in: originStopIds },
  })
    .select("tripId stopId stopSequence departureTime")
    .lean();

  // Trips that serve the destination, and their upstream stops.
  const destAlight = await GtfsStopTime.find({
    stopId: { $in: destStopIds },
  })
    .select("tripId stopId stopSequence arrivalTime")
    .lean();

  // Resolve which of these trips run today.
  const tripIds = [
    ...new Set([
      ...originBoard.map((r) => r.tripId),
      ...destAlight.map((r) => r.tripId),
    ]),
  ];
  const trips = await GtfsTrip.find({ tripId: { $in: tripIds } }).lean();
  const activeTripSet = new Set(
    trips.filter((t) => activeServiceIds.has(t.serviceId)).map((t) => t.tripId)
  );
  // Headway-based trips carry anchor times, not actual departures — relax
  // their transfer time-window checks (build re-resolves real times).
  const activeArr = [...activeTripSet];
  const flexTripIds = new Set<string>(
    activeArr.length
      ? ((await GtfsFrequency.find({ tripId: { $in: activeArr } }).distinct(
          "tripId"
        )) as string[])
      : []
  );

  // ONE representative trip per (route, direction): hub coverage comes from
  // route DIVERSITY, not from many same-route trips — a global "soonest N
  // trips" cap fills up with one busy line's departures and (worse) only the
  // first hour of service, so a later-arriving first leg never matches. The
  // representative's times are for hub discovery only; buildTransferRoute
  // re-resolves the actual catchable departures with chained afterSec.
  const routeDirByTrip = new Map(
    trips.map((t) => [t.tripId, `${t.routeId}|${t.directionId ?? 0}`])
  );

  // Board/alight stop choice is by PROXIMITY to the endpoint (not stop
  // sequence): keeping the latest-sequence alight rides past the destination
  // station and walks back (e.g. alighting at 東門 for a 台北車站 query).
  const originDistById = new Map(originStops.map((s) => [s.stopId, s.distanceM]));
  const destDistById = new Map(destStops.map((s) => [s.stopId, s.distanceM]));

  const originBoardByTrip = new Map<string, StopEvent & { stopId: string }>();
  for (const r of originBoard) {
    if (!activeTripSet.has(r.tripId)) continue;
    const sec = gtfsTimeToSeconds(r.departureTime);
    if (isNaN(sec)) continue;
    if (!flexTripIds.has(r.tripId) && sec < afterSec) continue;
    const prev = originBoardByTrip.get(r.tripId);
    if (
      !prev ||
      (originDistById.get(r.stopId) ?? Infinity) <
        (originDistById.get(prev.stopId) ?? Infinity)
    ) {
      originBoardByTrip.set(r.tripId, {
        tripId: r.tripId,
        seq: r.stopSequence,
        sec,
        stopId: r.stopId,
      });
    }
  }
  const bestOriginByRouteDir = new Map<string, { tripId: string; sec: number }>();
  for (const [tripId, ev] of originBoardByTrip) {
    const rd = routeDirByTrip.get(tripId);
    if (!rd) continue;
    const prev = bestOriginByRouteDir.get(rd);
    if (!prev || ev.sec < prev.sec) bestOriginByRouteDir.set(rd, { tripId, sec: ev.sec });
  }
  const originTripIds = [...bestOriginByRouteDir.values()]
    .sort((a, b) => a.sec - b.sec)
    .slice(0, MAX_TWO_TRANSFER_SIDE_TRIPS)
    .map((v) => v.tripId);

  // Dest trips → alight event (nearest to destination), one rep per route|dir.
  const destAlightByTrip = new Map<string, StopEvent & { stopId: string }>();
  for (const r of destAlight) {
    if (!activeTripSet.has(r.tripId)) continue;
    const sec = gtfsTimeToSeconds(r.arrivalTime);
    if (isNaN(sec)) continue;
    if (!flexTripIds.has(r.tripId) && sec < afterSec) continue;
    const prev = destAlightByTrip.get(r.tripId);
    if (
      !prev ||
      (destDistById.get(r.stopId) ?? Infinity) <
        (destDistById.get(prev.stopId) ?? Infinity)
    ) {
      destAlightByTrip.set(r.tripId, {
        tripId: r.tripId,
        seq: r.stopSequence,
        sec,
        stopId: r.stopId,
      });
    }
  }
  const bestDestByRouteDir = new Map<string, { tripId: string; sec: number }>();
  for (const [tripId, ev] of destAlightByTrip) {
    const rd = routeDirByTrip.get(tripId);
    if (!rd) continue;
    const prev = bestDestByRouteDir.get(rd);
    if (!prev || ev.sec < prev.sec) bestDestByRouteDir.set(rd, { tripId, sec: ev.sec });
  }
  const destTripIds = [...bestDestByRouteDir.values()]
    .sort((a, b) => a.sec - b.sec)
    .slice(0, MAX_TWO_TRANSFER_SIDE_TRIPS * 2)
    .map((v) => v.tripId);

  // Downstream stops of origin trips (potential transfer hubs).
  const originDownstream = await GtfsStopTime.find({
    tripId: { $in: originTripIds },
  })
    .select("tripId stopId stopSequence arrivalTime")
    .lean();
  // Upstream stops of dest trips.
  const destUpstream = await GtfsStopTime.find({
    tripId: { $in: destTripIds },
  })
    .select("tripId stopId stopSequence departureTime")
    .lean();

  // Resolve stop names/coords for all involved stops to match hubs.
  const hubStopIds = new Set<string>();
  for (const r of originDownstream) hubStopIds.add(r.stopId);
  for (const r of destUpstream) hubStopIds.add(r.stopId);
  const [hubStops, clusterByStop] = await Promise.all([
    GtfsStop.find({ stopId: { $in: [...hubStopIds] } })
      .select("stopId stopName stopLat stopLon")
      .lean(),
    getClusterKeys([...hubStopIds]),
  ]);
  const hubById = new Map(hubStops.map((s) => [s.stopId, s]));
  // Hub key: StationCluster id when the stop belongs to one (connects
  // bus「捷運淡水站」↔ metro「淡水」), exact stop_name otherwise.
  const hubKey = (stopId: string, stopName: string) =>
    clusterByStop.get(stopId) ?? stopName;

  // Index dest upstream board events by hub key.
  const destBoardByKey = new Map<
    string,
    { tripId: string; stopId: string; seq: number; sec: number }[]
  >();
  for (const r of destUpstream) {
    const s = hubById.get(r.stopId);
    if (!s) continue;
    const key = hubKey(s.stopId, s.stopName);
    const arr = destBoardByKey.get(key) ?? [];
    arr.push({
      tripId: r.tripId,
      stopId: r.stopId,
      seq: r.stopSequence,
      sec: gtfsTimeToSeconds(r.departureTime),
    });
    destBoardByKey.set(key, arr);
  }

  const routes: AccessibleRoute[] = [];
  const usedRouteKeys = new Set<string>();
  let candPairs = 0;
  let buildAttempts = 0;
  if (process.env.GTFS_DEBUG) {
    const originKeys = new Set<string>();
    for (const r of originDownstream) {
      const s = hubById.get(r.stopId);
      if (s) originKeys.add(hubKey(s.stopId, s.stopName));
    }
    const destKeys = new Set(destBoardByKey.keys());
    const common = [...originKeys].filter((k) => destKeys.has(k));
    debugLog(
      "[1T] originTrips:", originTripIds.length,
      "destTrips:", destTripIds.length,
      "originKeys:", originKeys.size,
      "destKeys:", destKeys.size,
      "common:", common.length,
      "| commonSample:", common.slice(0, 6).join(",")
    );
    debugLog(
      "[1T] originClusterKeys:",
      [...originKeys].filter((k) => k.startsWith("SC_")).slice(0, 8).join(",")
    );
    debugLog(
      "[1T] destClusterKeys:",
      [...destKeys].filter((k) => k.startsWith("SC_")).slice(0, 8).join(",")
    );
  }

  for (const origTripId of originTripIds) {
    const board = originBoardByTrip.get(origTripId)!;
    // first-leg arrival candidates = downstream stops of this origin trip
    const downstream = originDownstream.filter(
      (r) => r.tripId === origTripId && r.stopSequence > board.seq
    );
    for (const hub of downstream) {
      const hubStop = hubById.get(hub.stopId);
      if (!hubStop) continue;
      const leg1ArriveSec = gtfsTimeToSeconds(hub.arrivalTime);

      const secondLegs = destBoardByKey.get(
        hubKey(hubStop.stopId, hubStop.stopName)
      );
      if (!secondLegs) continue;
      candPairs++;

      for (const sl of secondLegs) {
        const slStop = hubById.get(sl.stopId);
        if (!slStop) continue;
        // A line serving both origin and destination sits in BOTH trip pools;
        // pairing it with itself yields "alight, wait, board the same line's
        // next bus" — skip before spending the build budget.
        const origRoute = routeDirByTrip.get(origTripId)?.split("|")[0];
        const slRoute = routeDirByTrip.get(sl.tripId)?.split("|")[0];
        if (origRoute && origRoute === slRoute) continue;
        // same physical station: key already matched, verify proximity —
        // looser bound for cluster members (bus↔rail can sit a few hundred
        // metres apart; walk time is computed from the actual distance).
        const sameCluster =
          clusterByStop.get(hub.stopId) !== undefined &&
          clusterByStop.get(hub.stopId) === clusterByStop.get(sl.stopId);
        const dist = haversineCoords(
          [hubStop.stopLon, hubStop.stopLat],
          [slStop.stopLon, slStop.stopLat]
        );
        if (dist > (sameCluster ? CLUSTER_TRANSFER_MAX_M : TRANSFER_SAME_STATION_M))
          continue;

        const transferWalkSec = Math.max(
          MIN_TRANSFER_WALK_SEC,
          Math.round((dist / WHEELCHAIR_SPEED_M_PER_MIN) * 60)
        );
        // No time-window prefilter here: the events are per-ROUTE
        // representatives whose clock times are arbitrary (often the day's
        // first trip). buildTransferRoute resolves the actual next departure
        // after leg 1's arrival and enforces the transfer-wait bound.

        const destEvt = destAlightByTrip.get(sl.tripId);
        if (!destEvt || destEvt.seq <= sl.seq) continue;

        // Dedupe by (leg1 route stop pair, leg2 route stop pair) approximation.
        const key = `${origTripId}|${hubStop.stopName}|${sl.tripId}`;
        if (usedRouteKeys.has(key)) continue;
        usedRouteKeys.add(key);
        // Each build costs a few DB round-trips — bound the total.
        if (++buildAttempts > 30) {
          debugLog("[1T] build budget exhausted");
          return routes;
        }
        debugLog(
          "[1T] build:",
          `board=${board.stopId}`,
          `hub=${hubStop.stopId}(${hubStop.stopName})`,
          `sl=${sl.stopId}`,
          `alight=${destEvt.stopId}`
        );

        const route = await buildTransferRoute(
          origin,
          destination,
          board,
          hub,
          hubStop,
          sl,
          slStop,
          destEvt,
          afterSec,
          activeServiceIds,
          transferWalkSec,
          opts?.mode ?? "wheelchair"
        );
        if (route) routes.push(route);
        if (routes.length >= (opts?.limit ?? 5)) {
          debugLog("[1T] pairs:", candPairs, "builds:", buildAttempts, "routes:", routes.length);
          return routes;
        }
      }
    }
  }

  debugLog("[1T] pairs:", candPairs, "builds:", buildAttempts, "routes:", routes.length);
  return routes;
}

async function buildTransferRoute(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  board: StopEvent & { stopId: string },
  hub: { tripId: string; stopId: string; stopSequence: number },
  hubStop: { stopId: string; stopName: string; stopLat: number; stopLon: number },
  sl: { tripId: string; stopId: string; seq: number; sec: number },
  slStop: { stopId: string; stopName: string; stopLat: number; stopLon: number },
  destEvt: StopEvent & { stopId: string },
  afterSec: number,
  activeServiceIds: Set<string>,
  transferWalkSec: number,
  mode: AccessibilityMode = "wheelchair"
): Promise<AccessibleRoute | null> {
  const wheelchairWalk = mode === "wheelchair";
  // Reuse findDirectConnections for each leg to get full connection metadata.
  // Sequential: leg 2's earliest catchable departure is anchored to leg 1's
  // resolved arrival plus the transfer walk (correct for both schedule- and
  // headway-based trips — findDirectConnections handles frequencies).
  const leg1List = await findDirectConnections(
    [board.stopId],
    [hubStop.stopId],
    afterSec,
    activeServiceIds,
    { limit: 3 }
  );
  const leg1 = leg1List.find((c) => c.tripId === hub.tripId) ?? leg1List[0];
  if (!leg1) return null;

  const leg2List = await findDirectConnections(
    [slStop.stopId],
    [destEvt.stopId],
    leg1.arrivalSec + transferWalkSec,
    activeServiceIds,
    { limit: 5 }
  );
  const leg2 = leg2List.find((c) => c.tripId === sl.tripId) ?? leg2List[0];
  if (!leg2) return null;
  // The fallback above may swap in a different trip than the paired one —
  // re-check the degenerate same-line "transfer" here.
  if (sameLine(leg1, leg2)) return null;
  if (
    leg2.departureSec < leg1.arrivalSec ||
    leg2.departureSec - leg1.arrivalSec > MAX_TRANSFER_WAIT_SEC + transferWalkSec
  )
    return null;
  // Overall journey must head toward the destination (rejects backwards rides).
  if (!ridesToward(leg1.fromCoords, leg2.toCoords, origin, destination))
    return null;
  // Redundant transfer (catches same-line short-turn variants under different
  // route ids): when leg 1's trip already serves leg 2's alight stop, the
  // rider could simply have stayed on board.
  const leg1Reach = await GtfsStopTime.findOne({
    tripId: leg1.tripId,
    stopId: leg2.toStopId,
  })
    .select("_id")
    .lean();
  if (leg1Reach) return null;

  const [t1, t2] = await Promise.all([
    connectionToLeg(leg1, afterSec),
    connectionToLeg(leg2, leg1.arrivalSec),
  ]);
  if (!t1 || !t2) return null;

  const [
    walkIn,
    transferWalk,
    walkOut,
    a11y1Board,
    a11y1Alight,
    a11y2Board,
    a11y2Alight,
  ] = await Promise.all([
    buildWalkLeg(
      { coords: [origin.lng, origin.lat], label: "出發地" },
      { coords: leg1.fromCoords, label: leg1.fromStopName },
      wheelchairWalk
    ),
    buildWalkLeg(
      { coords: leg1.toCoords, label: leg1.toStopName },
      { coords: leg2.fromCoords, label: leg2.fromStopName },
      wheelchairWalk
    ),
    buildWalkLeg(
      { coords: leg2.toCoords, label: leg2.toStopName },
      { coords: [destination.lng, destination.lat], label: "目的地" },
      wheelchairWalk
    ),
    nearbyA11y(leg1.fromCoords),
    nearbyA11y(leg1.toCoords),
    nearbyA11y(leg2.fromCoords),
    nearbyA11y(leg2.toCoords),
  ]);

  if (walkIn.distanceM + walkOut.distanceM > accessWalkBudgetM(origin, destination))
    return null;
  attachA11yToLeg(t1, a11y1Board, a11y1Alight);
  attachA11yToLeg(t2, a11y2Board, a11y2Alight);
  walkIn.a11yFacilities = a11y1Board;
  transferWalk.a11yFacilities = a11y1Alight;
  walkOut.a11yFacilities = a11y2Alight;

  // Indoor-graph enrichment: leg1 carries the street→platform entry (walkIn),
  // leg2 carries the platform→street exit (walkOut). The transfer hub between
  // them is in-station, so it gets highlight notes but no street exitInfo.
  if (isRailLeg(t1)) {
    await enrichLegIndoor(
      t1,
      walkIn,
      null,
      [origin.lng, origin.lat],
      leg1.toCoords,
      leg1.fromCoords,
      leg1.toCoords,
      mode
    );
  }
  if (isRailLeg(t2)) {
    await enrichLegIndoor(
      t2,
      null,
      walkOut,
      leg2.fromCoords,
      [destination.lng, destination.lat],
      leg2.fromCoords,
      leg2.toCoords,
      mode
    );
  }

  const highlights = deriveHighlights(a11y1Board, a11y2Alight);

  const legs = [walkIn, t1, transferWalk, t2, walkOut];
  const totalMinutes =
    walkIn.minutesEst +
    t1.estimatedWaitMinutes +
    leg1.rideMinutes +
    transferWalk.minutesEst +
    t2.estimatedWaitMinutes +
    leg2.rideMinutes +
    walkOut.minutesEst;
  return assembleRoute(
    `gtfs-transfer-${leg1.tripId}-${leg2.tripId}`,
    `${leg1.routeShortName || leg1.routeLongName} → ${
      leg2.routeShortName || leg2.routeLongName
    }`,
    legs,
    1,
    totalMinutes,
    highlights
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Two-transfer routes (Phase 12)
// ─────────────────────────────────────────────────────────────────────────────

const MAX_TWO_TRANSFER_RESULTS = 3;
const MAX_HUB_NAMES = 25; // hub-station names considered per side
const MAX_MIDDLE_STOP_TIME_ROWS = 30000; // hard cap on the middle-trip join scan
const MAX_TWO_TRANSFER_SIDE_TRIPS = 120; // origin/dest trips kept (time-sorted)

/** Seconds since service-day midnight → zero-padded "HH:MM:SS" (no 24h wrap). */
function secondsToHHmmss(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(
    r
  ).padStart(2, "0")}`;
}

/** Stage-by-stage diagnostics for the two-transfer join (GTFS_DEBUG=1). */
const debugLog = (...args: unknown[]) => {
  if (process.env.GTFS_DEBUG) console.log("[gtfs-2transfer]", ...args);
};

/**
 * Two-transfer routes: tripA (origin → hub X) + tripB (X → Y) + tripC (Y → dest).
 *
 * Bounded chain join over stop NAMES (this feed has no transfers.txt and
 * route-network stops carry no parent_station):
 *  1. Hub X candidates = downstream stops of trips boardable near the origin.
 *  2. Hub Y candidates = upstream stops of trips alighting near the destination.
 *  3. Middle trips = active trips serving an X-name stop BEFORE a Y-name stop.
 *  4. Chains must satisfy: leg1 arrive + walk ≤ leg2 depart, and
 *     leg2 arrive + walk ≤ leg3 depart (each wait ≤ MAX_TRANSFER_WAIT_SEC).
 *
 * Runs only as a fallback when direct + one-transfer leave the top-3 unfilled,
 * because the name-join scan is the most expensive query in the router.
 */
async function findTwoTransferRoutes(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  originStops: GtfsStopNear[],
  destStops: GtfsStopNear[],
  afterSec: number,
  activeServiceIds: Set<string>,
  opts?: PlanGtfsRouteOptions
): Promise<AccessibleRoute[]> {
  const originStopIds = originStops.map((s) => s.stopId);
  const destStopIds = destStops.map((s) => s.stopId);
  const originNames = new Set(originStops.map((s) => s.stopName));
  const destNames = new Set(destStops.map((s) => s.stopName));

  // ── 1+2. Same per-side scans as the one-transfer search ──
  const [originBoard, destAlight] = await Promise.all([
    GtfsStopTime.find({ stopId: { $in: originStopIds } })
      .select("tripId stopId stopSequence departureTime")
      .lean(),
    GtfsStopTime.find({ stopId: { $in: destStopIds } })
      .select("tripId stopId stopSequence arrivalTime")
      .lean(),
  ]);

  const tripIds = [
    ...new Set([
      ...originBoard.map((r) => r.tripId),
      ...destAlight.map((r) => r.tripId),
    ]),
  ];
  const trips = await GtfsTrip.find({ tripId: { $in: tripIds } }).lean();
  const activeTripSet = new Set(
    trips.filter((t) => activeServiceIds.has(t.serviceId)).map((t) => t.tripId)
  );

  // Headway-based (frequencies.txt) trips carry early-morning ANCHOR times in
  // stop_times, not actual departures — they repeat all day. Their events are
  // kept regardless of afterSec and their time-window checks are relaxed; the
  // REAL departure is resolved at build time by findDirectConnections, which
  // handles frequencies correctly.
  const activeTripIdArr = [...activeTripSet];
  const flexTripIds = new Set<string>(
    activeTripIdArr.length
      ? ((await GtfsFrequency.find({
          tripId: { $in: activeTripIdArr },
        }).distinct("tripId")) as string[])
      : []
  );

  // ONE representative trip per (route, direction) — see findOneTransferRoutes
  // for the rationale: route diversity over trip multiplicity, and the
  // representative's clock times are for hub DISCOVERY only (the build step
  // re-resolves real departures with chained afterSec).
  const routeDirByTrip = new Map(
    trips.map((t) => [t.tripId, `${t.routeId}|${t.directionId ?? 0}`])
  );
  // Board/alight stop choice by proximity to the endpoint (see one-transfer).
  const originDistById = new Map(originStops.map((s) => [s.stopId, s.distanceM]));
  const destDistById = new Map(destStops.map((s) => [s.stopId, s.distanceM]));

  const originBoardByTrip = new Map<string, StopEvent & { stopId: string }>();
  for (const r of originBoard) {
    if (!activeTripSet.has(r.tripId)) continue;
    const sec = gtfsTimeToSeconds(r.departureTime);
    if (isNaN(sec)) continue;
    if (!flexTripIds.has(r.tripId) && sec < afterSec) continue;
    const prev = originBoardByTrip.get(r.tripId);
    if (
      !prev ||
      (originDistById.get(r.stopId) ?? Infinity) <
        (originDistById.get(prev.stopId) ?? Infinity)
    ) {
      originBoardByTrip.set(r.tripId, {
        tripId: r.tripId,
        seq: r.stopSequence,
        sec,
        stopId: r.stopId,
      });
    }
  }
  const bestOriginRD = new Map<string, { tripId: string; sec: number }>();
  for (const [tripId, ev] of originBoardByTrip) {
    const rd = routeDirByTrip.get(tripId);
    if (!rd) continue;
    const prev = bestOriginRD.get(rd);
    if (!prev || ev.sec < prev.sec) bestOriginRD.set(rd, { tripId, sec: ev.sec });
  }
  const originTripIds = [...bestOriginRD.values()]
    .sort((a, b) => a.sec - b.sec)
    .slice(0, MAX_TWO_TRANSFER_SIDE_TRIPS)
    .map((v) => v.tripId);

  const destAlightByTrip = new Map<string, StopEvent & { stopId: string }>();
  for (const r of destAlight) {
    if (!activeTripSet.has(r.tripId)) continue;
    const sec = gtfsTimeToSeconds(r.arrivalTime);
    if (isNaN(sec)) continue;
    // can't arrive before departure — except flexible (headway) trips
    if (!flexTripIds.has(r.tripId) && sec < afterSec) continue;
    const prev = destAlightByTrip.get(r.tripId);
    if (
      !prev ||
      (destDistById.get(r.stopId) ?? Infinity) <
        (destDistById.get(prev.stopId) ?? Infinity)
    ) {
      destAlightByTrip.set(r.tripId, {
        tripId: r.tripId,
        seq: r.stopSequence,
        sec,
        stopId: r.stopId,
      });
    }
  }
  const bestDestRD = new Map<string, { tripId: string; sec: number }>();
  for (const [tripId, ev] of destAlightByTrip) {
    const rd = routeDirByTrip.get(tripId);
    if (!rd) continue;
    const prev = bestDestRD.get(rd);
    if (!prev || ev.sec < prev.sec) bestDestRD.set(rd, { tripId, sec: ev.sec });
  }
  const destTripIds = [...bestDestRD.values()]
    .sort((a, b) => a.sec - b.sec)
    .slice(0, MAX_TWO_TRANSFER_SIDE_TRIPS * 2)
    .map((v) => v.tripId);
  if (!originTripIds.length || !destTripIds.length) return [];

  const [originDownstream, destUpstream] = await Promise.all([
    GtfsStopTime.find({ tripId: { $in: originTripIds } })
      .select("tripId stopId stopSequence arrivalTime")
      .lean(),
    GtfsStopTime.find({ tripId: { $in: destTripIds } })
      .select("tripId stopId stopSequence departureTime")
      .lean(),
  ]);

  const sideStopIds = new Set<string>();
  for (const r of originDownstream) sideStopIds.add(r.stopId);
  for (const r of destUpstream) sideStopIds.add(r.stopId);
  const [sideStops, sideClusters] = await Promise.all([
    GtfsStop.find({ stopId: { $in: [...sideStopIds] } })
      .select("stopId stopName stopLat stopLon")
      .lean(),
    getClusterKeys([...sideStopIds, ...originStopIds, ...destStopIds]),
  ]);
  const sideById = new Map(sideStops.map((s) => [s.stopId, s]));
  // Hub key: StationCluster id when available (bus↔rail), stop_name otherwise.
  const keyOf = (stopId: string, stopName: string) =>
    sideClusters.get(stopId) ?? stopName;
  const isClusterKey = (key: string) => key.startsWith("SC_");
  const hubDistBound = (key: string) =>
    isClusterKey(key) ? CLUSTER_TRANSFER_MAX_M : TRANSFER_SAME_STATION_M;
  // Hubs must not be the origin/destination boarding area itself.
  const endpointKeys = new Set<string>();
  for (const s of originStops) endpointKeys.add(keyOf(s.stopId, s.stopName));
  for (const s of destStops) endpointKeys.add(keyOf(s.stopId, s.stopName));

  // Earliest leg1 arrival per hub-X key (board must follow the origin event).
  type HubEvent = {
    tripId: string;
    stopId: string;
    seq: number;
    sec: number;
    coords: [number, number];
  };
  const leg1ByXKey = new Map<string, HubEvent & { boardStopId: string }>();
  for (const r of originDownstream) {
    const board = originBoardByTrip.get(r.tripId);
    if (!board || r.stopSequence <= board.seq) continue;
    const s = sideById.get(r.stopId);
    if (!s) continue;
    const key = keyOf(s.stopId, s.stopName);
    if (endpointKeys.has(key) || originNames.has(s.stopName) || destNames.has(s.stopName))
      continue;
    const sec = gtfsTimeToSeconds(r.arrivalTime);
    if (isNaN(sec)) continue;
    const prev = leg1ByXKey.get(key);
    if (!prev || sec < prev.sec) {
      leg1ByXKey.set(key, {
        tripId: r.tripId,
        stopId: r.stopId,
        seq: r.stopSequence,
        sec,
        coords: [s.stopLon, s.stopLat],
        boardStopId: board.stopId,
      });
    }
  }

  // Leg3 departures per hub-Y key, sorted ascending (alight must precede dest).
  const leg3ByYKey = new Map<string, (HubEvent & { alightStopId: string })[]>();
  for (const r of destUpstream) {
    const alight = destAlightByTrip.get(r.tripId);
    if (!alight || r.stopSequence >= alight.seq) continue;
    const s = sideById.get(r.stopId);
    if (!s) continue;
    const key = keyOf(s.stopId, s.stopName);
    if (endpointKeys.has(key) || originNames.has(s.stopName) || destNames.has(s.stopName))
      continue;
    const sec = gtfsTimeToSeconds(r.departureTime);
    if (isNaN(sec)) continue;
    const arr = leg3ByYKey.get(key) ?? [];
    arr.push({
      tripId: r.tripId,
      stopId: r.stopId,
      seq: r.stopSequence,
      sec,
      coords: [s.stopLon, s.stopLat],
      alightStopId: alight.stopId,
    });
    leg3ByYKey.set(key, arr);
  }
  for (const arr of leg3ByYKey.values()) arr.sort((a, b) => a.sec - b.sec);

  // Cap hub keys: X by earliest leg1 arrival, Y by earliest leg3 departure.
  const xKeys = [...leg1ByXKey.entries()]
    .sort((a, b) => a[1].sec - b[1].sec)
    .slice(0, MAX_HUB_NAMES)
    .map(([key]) => key);
  const yKeys = [...leg3ByYKey.keys()].slice(0, MAX_HUB_NAMES);
  debugLog(
    "originTrips:", originTripIds.length,
    "destTrips:", destTripIds.length,
    "xKeys:", xKeys.length,
    "yKeys:", yKeys.length
  );
  debugLog("xKeys:", xKeys.join(","));
  debugLog("yKeys:", yKeys.join(","));
  if (!xKeys.length || !yKeys.length) return [];

  // ── 3. Middle trips joining an X-hub stop to a Y-hub stop ──
  // Cluster keys resolve to their member stop ids; plain keys match by name.
  const allKeys = [...new Set([...xKeys, ...yKeys])];
  const clusterIds = allKeys.filter(isClusterKey);
  const plainNames = allKeys.filter((k) => !isClusterKey(k));
  const clusterDocs = clusterIds.length
    ? await StationCluster.find({ clusterId: { $in: clusterIds } })
        .select("clusterId memberStopIds")
        .lean()
    : [];
  const clusterByMember = new Map<string, string>();
  for (const c of clusterDocs)
    for (const id of c.memberStopIds) clusterByMember.set(id, c.clusterId);

  const middleStops = await GtfsStop.find({
    locationType: 0,
    parentStation: null,
    $or: [
      ...(plainNames.length ? [{ stopName: { $in: plainNames } }] : []),
      ...(clusterByMember.size
        ? [{ stopId: { $in: [...clusterByMember.keys()] } }]
        : []),
    ],
  })
    .select("stopId stopName stopLat stopLon")
    .lean();
  const middleById = new Map(middleStops.map((s) => [s.stopId, s]));
  const middleKeyOf = (stopId: string, stopName: string) =>
    clusterByMember.get(stopId) ?? stopName;
  const xNameSet = new Set(xKeys);
  const yNameSet = new Set(yKeys);

  // departureTime ≥ now is safe for both roles of a row (a middle-leg board
  // departs after the leg-1 arrival ≥ afterSec; an alight follows its board),
  // and keeps the morning-trip bulk from exhausting the row cap.
  const middleRows = await GtfsStopTime.find({
    stopId: { $in: middleStops.map((s) => s.stopId) },
    departureTime: { $gte: secondsToHHmmss(afterSec) },
  })
    .select("tripId stopId stopSequence arrivalTime departureTime")
    .limit(MAX_MIDDLE_STOP_TIME_ROWS)
    .lean();

  type MiddleCand = {
    board: { stopId: string; seq: number; sec: number; name: string; coords: [number, number] };
    alight: { stopId: string; seq: number; sec: number; name: string; coords: [number, number] };
  };
  const middleByTrip = new Map<string, MiddleCand>();
  for (const r of middleRows) {
    const s = middleById.get(r.stopId);
    if (!s) continue;
    const key = middleKeyOf(s.stopId, s.stopName);
    const cand =
      middleByTrip.get(r.tripId) ??
      ({ board: null, alight: null } as unknown as MiddleCand);
    if (xNameSet.has(key)) {
      const sec = gtfsTimeToSeconds(r.departureTime);
      if (!isNaN(sec) && (!cand.board || r.stopSequence < cand.board.seq)) {
        cand.board = {
          stopId: r.stopId,
          seq: r.stopSequence,
          sec,
          name: key,
          coords: [s.stopLon, s.stopLat],
        };
      }
    }
    if (yNameSet.has(key)) {
      const sec = gtfsTimeToSeconds(r.arrivalTime);
      if (!isNaN(sec) && (!cand.alight || r.stopSequence > cand.alight.seq)) {
        cand.alight = {
          stopId: r.stopId,
          seq: r.stopSequence,
          sec,
          name: key,
          coords: [s.stopLon, s.stopLat],
        };
      }
    }
    middleByTrip.set(r.tripId, cand);
  }

  const middleTripIds = [...middleByTrip.entries()]
    .filter(
      ([, c]) =>
        c.board && c.alight && c.board.seq < c.alight.seq && c.board.name !== c.alight.name
    )
    .map(([tripId]) => tripId);
  debugLog(
    "middleStops:", middleStops.length,
    "middleRows:", middleRows.length,
    "middleTrips(joined):", middleTripIds.length
  );
  if (!middleTripIds.length) return [];

  const middleTrips = await GtfsTrip.find({
    tripId: { $in: middleTripIds },
  }).lean();
  const activeMiddleIds = middleTrips
    .filter((t) => activeServiceIds.has(t.serviceId))
    .map((t) => t.tripId);

  // ── 4. Chain assembly (hub proximity only), earliest middle-board first ──
  const chains: { leg1: HubEvent & { boardStopId: string }; mid: MiddleCand; midTripId: string; leg3: HubEvent & { alightStopId: string } }[] = [];
  const seenCombos = new Set<string>();

  for (const midTripId of activeMiddleIds.sort(
    (a, b) => middleByTrip.get(a)!.board.sec - middleByTrip.get(b)!.board.sec
  )) {
    const mid = middleByTrip.get(midTripId)!;

    const leg1 = leg1ByXKey.get(mid.board.name);
    if (!leg1) continue;
    // Same physical station check (key matched; verify proximity — looser
    // bound when the key is a cluster, since bus↔rail members sit apart).
    // No time-window prefilter: events are per-route representatives with
    // arbitrary clock times — buildTwoTransferRoute resolves the actual
    // departures with chained afterSec and enforces the wait bounds.
    if (haversineCoords(leg1.coords, mid.board.coords) > hubDistBound(mid.board.name))
      continue;

    const leg3Cands = leg3ByYKey.get(mid.alight.name) ?? [];
    const leg3 = leg3Cands.find(
      (c) =>
        haversineCoords(mid.alight.coords, c.coords) <= hubDistBound(mid.alight.name)
    );
    if (!leg3) continue;

    // Dedupe by transfer-hub PAIR, not trip ids — consecutive trips of the
    // same lines through the same hubs are near-identical chains and would
    // exhaust the build buffer with candidates that all fail the same filter.
    const combo = `${mid.board.name}|${mid.alight.name}`;
    if (seenCombos.has(combo)) continue;
    seenCombos.add(combo);

    chains.push({ leg1, mid, midTripId, leg3 });
    if (chains.length >= MAX_TWO_TRANSFER_RESULTS * 7) break; // build buffer
  }
  debugLog("activeMiddle:", activeMiddleIds.length, "chains:", chains.length);

  // ── 5. Build full routes for the best chains ──
  const routes: AccessibleRoute[] = [];
  for (const chain of chains) {
    const route = await buildTwoTransferRoute(
      origin,
      destination,
      chain,
      afterSec,
      activeServiceIds,
      opts?.mode ?? "wheelchair"
    );
    if (route) routes.push(route);
    if (routes.length >= MAX_TWO_TRANSFER_RESULTS) break;
  }
  return routes;
}

async function buildTwoTransferRoute(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  chain: {
    leg1: { tripId: string; stopId: string; boardStopId: string };
    mid: {
      board: { stopId: string };
      alight: { stopId: string };
    };
    midTripId: string;
    leg3: { tripId: string; stopId: string; alightStopId: string };
  },
  afterSec: number,
  activeServiceIds: Set<string>,
  mode: AccessibilityMode = "wheelchair"
): Promise<AccessibleRoute | null> {
  const wheelchairWalk = mode === "wheelchair";

  // Re-resolve each leg through findDirectConnections for full metadata
  // (frequencies, shape, route names). Sequential on purpose: each leg's
  // earliest catchable departure is anchored to the PREVIOUS leg's arrival
  // plus the in-station transfer walk — querying all three with the original
  // afterSec would return departures that precede the upstream arrival.
  const c1List = await findDirectConnections(
    [chain.leg1.boardStopId],
    [chain.leg1.stopId],
    afterSec,
    activeServiceIds,
    { limit: 3 }
  );
  const c1 = c1List.find((c) => c.tripId === chain.leg1.tripId) ?? c1List[0];
  if (!c1) return null;

  const c2List = await findDirectConnections(
    [chain.mid.board.stopId],
    [chain.mid.alight.stopId],
    c1.arrivalSec + MIN_TRANSFER_WALK_SEC,
    activeServiceIds,
    { limit: 5 }
  );
  const c2 = c2List.find((c) => c.tripId === chain.midTripId) ?? c2List[0];
  if (!c2) return null;

  const c3List = await findDirectConnections(
    [chain.leg3.stopId],
    [chain.leg3.alightStopId],
    c2.arrivalSec + MIN_TRANSFER_WALK_SEC,
    activeServiceIds,
    { limit: 5 }
  );
  const c3 = c3List.find((c) => c.tripId === chain.leg3.tripId) ?? c3List[0];
  if (!c3) return null;

  if (sameLine(c1, c2) || sameLine(c2, c3)) return null;

  // Redundant-transfer check (catches same-line short-turn variants and
  // backtracking, which share stop ids): when the previous trip already serves
  // the next leg's alight stop, the rider could simply have stayed on board.
  const [c1Reach, c2Reach] = await Promise.all([
    GtfsStopTime.findOne({ tripId: c1.tripId, stopId: c2.toStopId })
      .select("_id")
      .lean(),
    GtfsStopTime.findOne({ tripId: c2.tripId, stopId: c3.toStopId })
      .select("_id")
      .lean(),
  ]);
  if (c1Reach || c2Reach) return null;

  // Safety: the chain must still be time-ordered and each wait bounded.
  if (
    c2.departureSec < c1.arrivalSec ||
    c3.departureSec < c2.arrivalSec ||
    c2.departureSec - c1.arrivalSec > MAX_TRANSFER_WAIT_SEC ||
    c3.departureSec - c2.arrivalSec > MAX_TRANSFER_WAIT_SEC
  )
    return null;

  // Overall journey must head toward the destination (rejects backwards rides).
  if (!ridesToward(c1.fromCoords, c3.toCoords, origin, destination)) return null;

  const [t1, t2, t3] = await Promise.all([
    connectionToLeg(c1, afterSec),
    connectionToLeg(c2, c1.arrivalSec),
    connectionToLeg(c3, c2.arrivalSec),
  ]);
  if (!t1 || !t2 || !t3) return null;

  const [walkIn, transferWalk1, transferWalk2, walkOut] = await Promise.all([
    buildWalkLeg(
      { coords: [origin.lng, origin.lat], label: "出發地" },
      { coords: c1.fromCoords, label: c1.fromStopName },
      wheelchairWalk
    ),
    buildWalkLeg(
      { coords: c1.toCoords, label: c1.toStopName },
      { coords: c2.fromCoords, label: c2.fromStopName },
      wheelchairWalk
    ),
    buildWalkLeg(
      { coords: c2.toCoords, label: c2.toStopName },
      { coords: c3.fromCoords, label: c3.fromStopName },
      wheelchairWalk
    ),
    buildWalkLeg(
      { coords: c3.toCoords, label: c3.toStopName },
      { coords: [destination.lng, destination.lat], label: "目的地" },
      wheelchairWalk
    ),
  ]);
  if (walkIn.distanceM + walkOut.distanceM > accessWalkBudgetM(origin, destination))
    return null;

  const [a11y1Board, a11y1Alight, a11y2Alight, a11y3Board, a11y3Alight] =
    await Promise.all([
      nearbyA11y(c1.fromCoords),
      nearbyA11y(c1.toCoords),
      nearbyA11y(c2.toCoords),
      nearbyA11y(c3.fromCoords),
      nearbyA11y(c3.toCoords),
    ]);

  attachA11yToLeg(t1, a11y1Board, a11y1Alight);
  attachA11yToLeg(t2, a11y1Alight, a11y2Alight);
  attachA11yToLeg(t3, a11y3Board, a11y3Alight);
  walkIn.a11yFacilities = a11y1Board;
  transferWalk1.a11yFacilities = a11y1Alight;
  transferWalk2.a11yFacilities = a11y2Alight;
  walkOut.a11yFacilities = a11y3Alight;

  // Indoor enrichment only at the street ends (transfer hubs stay in-station).
  if (isRailLeg(t1)) {
    await enrichLegIndoor(
      t1,
      walkIn,
      null,
      [origin.lng, origin.lat],
      c1.toCoords,
      c1.fromCoords,
      c1.toCoords,
      mode
    );
  }
  if (isRailLeg(t3)) {
    await enrichLegIndoor(
      t3,
      null,
      walkOut,
      c3.fromCoords,
      [destination.lng, destination.lat],
      c3.fromCoords,
      c3.toCoords,
      mode
    );
  }

  const highlights = deriveHighlights(a11y1Board, a11y3Alight);
  const legs = [walkIn, t1, transferWalk1, t2, transferWalk2, t3, walkOut];
  const totalMinutes =
    walkIn.minutesEst +
    t1.estimatedWaitMinutes +
    c1.rideMinutes +
    transferWalk1.minutesEst +
    t2.estimatedWaitMinutes +
    c2.rideMinutes +
    transferWalk2.minutesEst +
    t3.estimatedWaitMinutes +
    c3.rideMinutes +
    walkOut.minutesEst;

  return assembleRoute(
    `gtfs-2transfer-${c1.tripId}-${c2.tripId}-${c3.tripId}`,
    `${c1.routeShortName || c1.routeLongName} → ${
      c2.routeShortName || c2.routeLongName
    } → ${c3.routeShortName || c3.routeLongName}`,
    legs,
    2,
    totalMinutes,
    highlights
  );
}
