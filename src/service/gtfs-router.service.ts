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
import OsmA11y from "../model/osm-a11y.model";
import {
  orsWalkingRoute,
  haversineCoords,
  WHEELCHAIR_SPEED_M_PER_MIN,
} from "../config/ors";
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

/** Local-date "YYYYMMDD" for calendar comparison. */
function toYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

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
  const weekdayField = WEEKDAY_FIELDS[date.getDay()];

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

  const [railCandidates, busDocs] = await Promise.all([
    // Over-fetch rail candidates, then keep only those actually served by a trip.
    // Many nearby rail stops carry no schedule in the feed (TRA/TMRT/NTMC have
    // stops but no stop_times) and would otherwise crowd out a scheduled-but-
    // distant station (intercity HSR). Data-driven: future TRA schedules just work.
    GtfsStop.find({ ...near(railRadiusM), stopId: { $regex: RAIL_STOP_ID_REGEX } })
      .limit(MAX_NEAR_RAIL_STOPS * 4)
      .lean(),
    GtfsStop.find(near(busRadiusM)).limit(busLimit).lean(),
  ]);

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

function waitFromConnection(
  conn: GtfsConnection,
  afterSec: number
): { waitInfo: WaitInfo; estimatedWaitMinutes: number } {
  if (conn.isFrequency && conn.headwaySecs) {
    const minutes = Math.round(conn.headwaySecs / 2 / 60);
    return { waitInfo: { minutes, source: "schedule" }, estimatedWaitMinutes: minutes };
  }
  const minutes = Math.max(0, Math.round((conn.departureSec - afterSec) / 60));
  return { waitInfo: { minutes, source: "schedule" }, estimatedWaitMinutes: minutes };
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
    const isThsr =
      conn.agencyId === "THSR" || conn.routeId.startsWith("THSR");
    if (isThsr) {
      const leg: ThsrLeg = {
        type: "THSR",
        trainNo: conn.routeShortName || conn.tripId,
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
      trainNo: conn.routeShortName || conn.tripId,
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
// First/last-mile walk legs (ORS)
// ─────────────────────────────────────────────────────────────────────────────

async function buildWalkLeg(
  from: { coords: [number, number]; label: string },
  to: { coords: [number, number]; label: string }
): Promise<WalkLeg> {
  const route = await orsWalkingRoute(from.coords, to.coords);
  return {
    type: "WALK",
    from: from.label,
    to: to.label,
    distanceM: Math.round(route.distanceM),
    minutesEst: Math.max(1, Math.round(route.durationSec / 60)),
    polyline: route.polyline,
    a11yFacilities: [],
    exitInfo: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// High-level route planning
// ─────────────────────────────────────────────────────────────────────────────

export interface PlanGtfsRouteOptions {
  departureTime?: Date;
  maxTransfers?: 0 | 1;
  routeTypes?: Array<1 | 2 | 3 | 4>;
  limit?: number;
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
  const afterSec = gtfsTimeToSeconds(
    `${String(now.getHours()).padStart(2, "0")}:${String(
      now.getMinutes()
    ).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`
  );
  const maxTransfers = opts?.maxTransfers ?? 0;

  const [activeServiceIds, originStops, destStops] = await Promise.all([
    getActiveServiceIds(now),
    findNearestGtfsStops(origin),
    findNearestGtfsStops(destination),
  ]);
  if (!activeServiceIds.size || !originStops.length || !destStops.length) {
    return [];
  }

  const routes: AccessibleRoute[] = [];

  // ── Direct ──
  const direct = await findDirectConnections(
    originStops.map((s) => s.stopId),
    destStops.map((s) => s.stopId),
    afterSec,
    activeServiceIds,
    { routeTypes: opts?.routeTypes, limit: opts?.limit ?? MAX_DIRECT_RESULTS }
  );

  for (const conn of direct) {
    const transitLeg = await connectionToLeg(conn, afterSec);
    if (!transitLeg) continue;
    const [walkIn, walkOut, boardA11y, alightA11y] = await Promise.all([
      buildWalkLeg(
        { coords: [origin.lng, origin.lat], label: "出發地" },
        { coords: conn.fromCoords, label: conn.fromStopName }
      ),
      buildWalkLeg(
        { coords: conn.toCoords, label: conn.toStopName },
        { coords: [destination.lng, destination.lat], label: "目的地" }
      ),
      nearbyA11y(conn.fromCoords),
      nearbyA11y(conn.toCoords),
    ]);
    attachA11yToLeg(transitLeg, boardA11y, alightA11y);
    walkIn.a11yFacilities = boardA11y;
    walkOut.a11yFacilities = alightA11y;
    const legs = [walkIn, transitLeg, walkOut];
    const transitMinutes = transitLeg.estimatedWaitMinutes + conn.rideMinutes;
    const totalMinutes = walkIn.minutesEst + transitMinutes + walkOut.minutesEst;
    routes.push(
      assembleRoute(
        `gtfs-direct-${conn.tripId}`,
        conn.routeShortName || conn.routeLongName,
        legs,
        0,
        totalMinutes,
        deriveHighlights(boardA11y, alightA11y)
      )
    );
  }

  // ── One transfer ──
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
    routes.push(...transferRoutes);
  }

  return routes;
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

  // Origin trips → board event (earliest seq), capped.
  const originBoardByTrip = new Map<string, StopEvent & { stopId: string }>();
  for (const r of originBoard) {
    if (!activeTripSet.has(r.tripId)) continue;
    const prev = originBoardByTrip.get(r.tripId);
    if (!prev || r.stopSequence < prev.seq) {
      originBoardByTrip.set(r.tripId, {
        tripId: r.tripId,
        seq: r.stopSequence,
        sec: gtfsTimeToSeconds(r.departureTime),
        stopId: r.stopId,
      });
    }
  }
  const originTripIds = [...originBoardByTrip.keys()].slice(
    0,
    MAX_TRANSFER_HUB_TRIPS
  );

  // Dest trips → alight event (latest seq), capped.
  const destAlightByTrip = new Map<string, StopEvent & { stopId: string }>();
  for (const r of destAlight) {
    if (!activeTripSet.has(r.tripId)) continue;
    const prev = destAlightByTrip.get(r.tripId);
    if (!prev || r.stopSequence > prev.seq) {
      destAlightByTrip.set(r.tripId, {
        tripId: r.tripId,
        seq: r.stopSequence,
        sec: gtfsTimeToSeconds(r.arrivalTime),
        stopId: r.stopId,
      });
    }
  }
  const destTripIds = [...destAlightByTrip.keys()].slice(
    0,
    MAX_TRANSFER_HUB_TRIPS
  );

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

  // Resolve stop names/coords for all involved stops to match hubs by name.
  const hubStopIds = new Set<string>();
  for (const r of originDownstream) hubStopIds.add(r.stopId);
  for (const r of destUpstream) hubStopIds.add(r.stopId);
  const hubStops = await GtfsStop.find({ stopId: { $in: [...hubStopIds] } })
    .select("stopId stopName stopLat stopLon")
    .lean();
  const hubById = new Map(hubStops.map((s) => [s.stopId, s]));

  // Index dest upstream board events by stop NAME (hub matching is by name).
  const destBoardByName = new Map<
    string,
    { tripId: string; stopId: string; seq: number; sec: number }[]
  >();
  for (const r of destUpstream) {
    const s = hubById.get(r.stopId);
    if (!s) continue;
    const arr = destBoardByName.get(s.stopName) ?? [];
    arr.push({
      tripId: r.tripId,
      stopId: r.stopId,
      seq: r.stopSequence,
      sec: gtfsTimeToSeconds(r.departureTime),
    });
    destBoardByName.set(s.stopName, arr);
  }

  const routes: AccessibleRoute[] = [];
  const usedRouteKeys = new Set<string>();

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

      const secondLegs = destBoardByName.get(hubStop.stopName);
      if (!secondLegs) continue;

      for (const sl of secondLegs) {
        const slStop = hubById.get(sl.stopId);
        if (!slStop) continue;
        // same physical station: name already matched, verify proximity
        const dist = haversineCoords(
          [hubStop.stopLon, hubStop.stopLat],
          [slStop.stopLon, slStop.stopLat]
        );
        if (dist > TRANSFER_SAME_STATION_M) continue;

        const transferWalkSec = Math.max(
          MIN_TRANSFER_WALK_SEC,
          Math.round((dist / WHEELCHAIR_SPEED_M_PER_MIN) * 60)
        );
        const readySec = leg1ArriveSec + transferWalkSec;
        const wait = sl.sec - readySec;
        if (wait < 0 || wait > MAX_TRANSFER_WAIT_SEC) continue;

        const destEvt = destAlightByTrip.get(sl.tripId);
        if (!destEvt || destEvt.seq <= sl.seq) continue;

        // Dedupe by (leg1 route stop pair, leg2 route stop pair) approximation.
        const key = `${origTripId}|${hubStop.stopName}|${sl.tripId}`;
        if (usedRouteKeys.has(key)) continue;
        usedRouteKeys.add(key);

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
          transferWalkSec
        );
        if (route) routes.push(route);
        if (routes.length >= (opts?.limit ?? 5)) return routes;
      }
    }
  }

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
  transferWalkSec: number
): Promise<AccessibleRoute | null> {
  // Reuse findDirectConnections for each leg to get full connection metadata.
  const [leg1List, leg2List] = await Promise.all([
    findDirectConnections([board.stopId], [hubStop.stopId], afterSec, activeServiceIds, {
      limit: 3,
    }),
    findDirectConnections(
      [slStop.stopId],
      [destEvt.stopId],
      board.sec, // any time; we filter by trip below
      activeServiceIds,
      { limit: 5 }
    ),
  ]);

  const leg1 = leg1List.find((c) => c.tripId === hub.tripId) ?? leg1List[0];
  const leg2 = leg2List.find((c) => c.tripId === sl.tripId) ?? leg2List[0];
  if (!leg1 || !leg2) return null;

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
      { coords: leg1.fromCoords, label: leg1.fromStopName }
    ),
    buildWalkLeg(
      { coords: leg1.toCoords, label: leg1.toStopName },
      { coords: leg2.fromCoords, label: leg2.fromStopName }
    ),
    buildWalkLeg(
      { coords: leg2.toCoords, label: leg2.toStopName },
      { coords: [destination.lng, destination.lat], label: "目的地" }
    ),
    nearbyA11y(leg1.fromCoords),
    nearbyA11y(leg1.toCoords),
    nearbyA11y(leg2.fromCoords),
    nearbyA11y(leg2.toCoords),
  ]);

  attachA11yToLeg(t1, a11y1Board, a11y1Alight);
  attachA11yToLeg(t2, a11y2Board, a11y2Alight);
  walkIn.a11yFacilities = a11y1Board;
  transferWalk.a11yFacilities = a11y1Alight;
  walkOut.a11yFacilities = a11y2Alight;
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
