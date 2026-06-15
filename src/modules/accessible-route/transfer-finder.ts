/**
 * Phase 3 — one-transfer route finder.
 *
 * Builds wheelchair-accessible routes that require exactly one transfer between
 * two transit legs (bus↔bus, bus↔metro, metro↔metro). Reuses the direct-route
 * helpers exported from accessible-route.service.ts so TDX-fetch / scoring logic
 * is never duplicated.
 *
 * All coordinates are [lng, lat] (GeoJSON / ORS convention).
 *
 * High-level flow (see Phase 3 SPEC §4):
 *   1. findReachableStops(origin) and findReachableStops(destination) in parallel.
 *   2. Enumerate first-leg routes from origin-side stops (bus subRouteIds / metro lines).
 *   3. Enumerate last-leg routes into destination-side stops.
 *   4. Combinatorial join on intermediate stops with an 800 m straight-line prefilter.
 *   5. Resolve transfer walk-times with a single ORS matrix call.
 *   6. Assemble five-leg AccessibleRoute objects (walk → transit → walk → transit → walk).
 *   7. Score with the shared scoreAndRank and return up to 20 routes.
 */

import {
  haversineM,
  nearQuery,
  fetchTdxRoute,
  fetchWaitInfo,
  waitInfoMinutes,
  fetchNearestBus,
  fetchMetroStationOfLine,
  fetchMetroTravelTimes,
  fetchMetroHeadway,
  fetchMetroFacilities,
  FACILITY_LABELS,
  scoreAndRank,
  type WalkLeg,
  type BusLeg,
  type MetroLeg,
  type WaitInfo,
  type AccessibleRoute,
} from "./accessible-route.service";

import {
  findReachableStops,
  type ReachableStop,
} from "../../service/reachable-stops.service";

import {
  orsWalkingRoute,
  orsWalkingMatrix,
  WHEELCHAIR_SPEED_M_PER_MIN,
} from "../../service/ors.service";

import { CITY_METRO_SYSTEMS } from "../../config/transit";
import { TaiwanCityEn } from "../../types/transit";

import { getRouteDirectionImproved, equalStopName } from "../../config/lib";

import BusStopModel from "../../model/bus-stop.model";
import OsmA11y from "../../model/osm-a11y.model";
import {
  findAccessibleExits,
  selectNearestExit,
} from "../../service/a11y-exit.service";

import {
  ITdxBusStop,
  ITdxMetroStation,
  IOsmA11y,
} from "../../types";
import { BusRoute, TdxMetroStationFacility } from "../../types/transit";

// ─── Tunables ──────────────────────────────────────────────────────────────

const MAX_WALK_MIN = 20; // reachable-stop budget on each side
const MAX_ORIGIN_STOPS = 10; // first-leg origin stops to expand
const MAX_DEST_STOPS = 10; // last-leg destination stops to expand
const MAX_ROUTES_PER_STOP = 3; // first-leg routes per origin stop
const TRANSFER_PREFILTER_M = 800; // straight-line cap at the transfer point
const MAX_TRANSFER_WALK_SEC = 10 * 60; // routed transfer walk ceiling
const MAX_COMBOS = 20; // hard cap on assembled candidates
const LAST_LEG_ALIGHT_MAX_M = 2000; // last-leg alighting stop must be within this of dest

// ─── Internal data structures (SPEC §3) ─────────────────────────────────────

interface IntermediateStop {
  name: string; // Zh_tw
  coords: [number, number]; // [lng, lat]
  stopIdx: number; // position in the TDX stop sequence
  direction: number; // bus direction (0/1); 0 for metro forward
}

interface BoardableRoute {
  kind: "BUS" | "METRO";
  routeId: string; // subRouteId (bus) | lineId, e.g. "TRTC-R" (metro)
  railSystem?: string; // metro only
  city: string; // ITdxBusStop.city for bus; city param for metro
  originStop: ReachableStop; // boarding stop on the origin side
  boardName: string; // boarding stop/station Zh_tw
  boardCoords: [number, number];
  stopSequence: IntermediateStop[]; // stops forward of the boarding stop
}

interface ServiceableRoute {
  kind: "BUS" | "METRO";
  routeId: string; // subRouteId (bus) | lineId (metro)
  railSystem?: string; // metro only
  city: string;
  destStop: ReachableStop;
  boardName: string; // last-leg boarding stop/station Zh_tw
  boardCoords: [number, number];
  stopDoc: ITdxBusStop | null;
  stationDoc: ITdxMetroStation | null;
}

interface TransferCombo {
  originStop: ReachableStop;
  firstLeg: BoardableRoute;
  midCoords: [number, number];
  midName: string;
  midStop: IntermediateStop;
  destStop: ReachableStop;
  lastLeg: ServiceableRoute;
  transferWalkSec: number; // resolved in Step 5
}


function bareLineId(railSystem: string, lineId: string): string {
  return lineId.startsWith(`${railSystem}-`)
    ? lineId.slice(railSystem.length + 1)
    : lineId;
}

function bareStationId(railSystem: string, stationUid: string): string {
  return stationUid.startsWith(`${railSystem}-`)
    ? stationUid.slice(railSystem.length + 1)
    : stationUid;
}

const osmTagVal = (nodes: IOsmA11y[], key: string, val: string): boolean =>
  nodes.some((f) => f.tags?.[key] === val);

/**
 * OSM-derived accessibility highlights for a single point (mirrors the
 * highlight logic in buildCandidate, scoped to one node set).
 */
function pointHighlights(nodes: IOsmA11y[], label: string): string[] {
  const out: string[] = [];
  if (nodes.some((f) => f.category === "elevator") || osmTagVal(nodes, "elevator", "yes"))
    out.push(`${label}附近有電梯`);
  if (nodes.some((f) => f.category === "kerb_cut" || f.category === "ramp"))
    out.push(`${label}附近有無障礙坡道`);
  if (osmTagVal(nodes, "toilets:wheelchair", "yes")) out.push(`${label}附近有無障礙廁所`);
  if (osmTagVal(nodes, "tactile_paving", "yes")) out.push(`${label}附近有導盲磚`);
  if (osmTagVal(nodes, "traffic_signals:sound", "yes")) out.push(`${label}附近有音響號誌`);
  if (osmTagVal(nodes, "wheelchair", "yes")) out.push(`${label}設施完善`);
  return out;
}

/**
 * TRTC exit-info lookup (SPEC §6). Returns the closest elevator/ramp exit at
 * the given station to `near`, or null. Only valid when railSystem === "TRTC".
 */
async function lookupTrtcExit(
  railSystem: string,
  stationName: string,
  near: [number, number]
): Promise<WalkLeg["exitInfo"]> {
  if (railSystem !== "TRTC") return null;
  try {
    // Reuse the single source of truth for exit lookup + parsing instead of
    // duplicating the query/regex here (keeps exitInfo identical to the
    // direct-route path in a11y-exit.service.ts).
    const exits = await findAccessibleExits(stationName);
    if (!exits.length) return null;
    const nearest = selectNearestExit(near, exits);
    return {
      exitName: nearest.exitName,
      exitNumber: nearest.exitNumber,
      type: nearest.type,
      coords: nearest.coords,
    };
  } catch {
    return null;
  }
}

// ─── Step 2: enumerate first-leg (boardable) routes ──────────────────────────

async function enumerateBoardableRoutes(
  originStops: ReachableStop[],
  metroSeqCache: Map<string, Awaited<ReturnType<typeof fetchMetroStationOfLine>>>
): Promise<BoardableRoute[]> {
  const out: BoardableRoute[] = [];

  for (const stop of originStops.slice(0, MAX_ORIGIN_STOPS)) {
    if (stop.kind === "bus") {
      const doc = stop.doc as ITdxBusStop;
      const boardName = doc.stopName.Zh_tw;
      const routeIds = doc.subRouteIds.slice(0, MAX_ROUTES_PER_STOP);
      for (const routeId of routeIds) {
        try {
          const routes = await fetchTdxRoute(routeId, doc.city);
          if (!routes.length) continue;
          const seq: IntermediateStop[] = [];
          for (const r of routes) {
            const stops = r.Stops ?? [];
            const boardIdx = stops.findIndex((s) =>
              equalStopName(s.StopName?.Zh_tw, boardName)
            );
            if (boardIdx === -1) continue;
            for (let i = boardIdx + 1; i < stops.length; i++) {
              const s = stops[i];
              seq.push({
                name: s.StopName.Zh_tw,
                coords: [s.StopPosition.PositionLon, s.StopPosition.PositionLat],
                stopIdx: i,
                direction: r.Direction,
              });
            }
          }
          if (!seq.length) continue;
          out.push({
            kind: "BUS",
            routeId,
            city: doc.city,
            originStop: stop,
            boardName,
            boardCoords: stop.coords,
            stopSequence: seq,
          });
        } catch {
          // skip this route on any TDX failure
        }
      }
    } else {
      // metro
      const doc = stop.doc as ITdxMetroStation;
      const railSystem = doc.railSystem;
      const boardName = doc.stationName.Zh_tw;
      const bareBoard = bareStationId(railSystem, doc.stationUid);
      const lineIds = doc.lineIds.slice(0, MAX_ROUTES_PER_STOP);
      for (const lineId of lineIds) {
        try {
          let stationOfLines = metroSeqCache.get(railSystem);
          if (!stationOfLines) {
            stationOfLines = await fetchMetroStationOfLine(railSystem);
            metroSeqCache.set(railSystem, stationOfLines);
          }
          const bare = bareLineId(railSystem, lineId);
          const sol = stationOfLines.find((s) => s.LineID === bare);
          if (!sol) continue;
          const boardIdx = sol.Stations.findIndex((s) => s.StationID === bareBoard);
          if (boardIdx === -1) continue;
          // forward direction along the sequence (coords resolved from DB below)
          const seq: IntermediateStop[] = sol.Stations.slice(boardIdx + 1).map(
            (s, i) => ({
              name: s.StationName.Zh_tw,
              coords: [0, 0] as [number, number],
              stopIdx: boardIdx + 1 + i,
              direction: 0,
            })
          );
          // The station-of-line response carries no coordinates; resolve them
          // via a DB lookup by name. Drop entries with no stored coords.
          const resolved = await resolveMetroSeqCoords(railSystem, seq);
          if (!resolved.length) continue;
          out.push({
            kind: "METRO",
            routeId: lineId,
            railSystem,
            city: doc.railSystem,
            originStop: stop,
            boardName,
            boardCoords: stop.coords,
            stopSequence: resolved,
          });
        } catch {
          // skip this line on any TDX failure
        }
      }
    }
  }
  return out;
}

/**
 * Resolve [lng,lat] for a metro station sequence by looking the stations up in
 * MongoDB by Zh_tw name on the given rail system. Stations without a stored doc
 * are dropped (they cannot participate in distance prefiltering).
 */
async function resolveMetroSeqCoords(
  railSystem: string,
  seq: IntermediateStop[]
): Promise<IntermediateStop[]> {
  if (!seq.length) return [];
  // Map each seq entry to its prefixed UID via the name+sequence; we stored the
  // bare StationID position only, so re-derive UID from railSystem + name match.
  // Simpler: query all stations on this rail system by name set.
  const names = [...new Set(seq.map((s) => s.name))];
  const MetroStationModel = (await import("../../model/metro-station.model"))
    .default;
  const docs = await MetroStationModel.find({
    railSystem,
    "stationName.Zh_tw": { $in: names },
  }).lean<ITdxMetroStation[]>();
  const byName = new Map<string, [number, number]>();
  for (const d of docs)
    byName.set(d.stationName.Zh_tw, d.location.coordinates as [number, number]);
  const out: IntermediateStop[] = [];
  for (const s of seq) {
    const c = byName.get(s.name);
    if (!c) continue;
    out.push({ ...s, coords: c });
  }
  return out;
}

// ─── Step 3: enumerate last-leg (serviceable) routes ─────────────────────────

function enumerateServiceableRoutes(
  destStops: ReachableStop[],
  city: TaiwanCityEn
): {
  routes: ServiceableRoute[];
  byName: Map<string, ServiceableRoute[]>;
} {
  const routes: ServiceableRoute[] = [];
  const byName = new Map<string, ServiceableRoute[]>();
  void city;

  const add = (name: string, r: ServiceableRoute) => {
    routes.push(r);
    const arr = byName.get(name);
    if (arr) arr.push(r);
    else byName.set(name, [r]);
  };

  for (const stop of destStops.slice(0, MAX_DEST_STOPS)) {
    if (stop.kind === "bus") {
      const doc = stop.doc as ITdxBusStop;
      const name = doc.stopName.Zh_tw;
      for (const routeId of doc.subRouteIds) {
        add(name, {
          kind: "BUS",
          routeId,
          city: doc.city,
          destStop: stop,
          boardName: name,
          boardCoords: stop.coords,
          stopDoc: doc,
          stationDoc: null,
        });
      }
    } else {
      const doc = stop.doc as ITdxMetroStation;
      const name = doc.stationName.Zh_tw;
      for (const lineId of doc.lineIds) {
        add(name, {
          kind: "METRO",
          routeId: lineId,
          railSystem: doc.railSystem,
          city: doc.railSystem,
          destStop: stop,
          boardName: name,
          boardCoords: stop.coords,
          stopDoc: null,
          stationDoc: doc,
        });
      }
    }
  }
  return { routes, byName };
}

// ─── Step 4: combinatorial join ──────────────────────────────────────────────

function findTransferCombos(
  boardables: BoardableRoute[],
  serviceablesByName: Map<string, ServiceableRoute[]>
): TransferCombo[] {
  interface Scored {
    combo: TransferCombo;
    score: number;
  }
  const scored: Scored[] = [];
  const seenComboKey = new Set<string>();

  for (const first of boardables) {
    for (const mid of first.stopSequence) {
      // S_mid cannot be the same physical stop we boarded.
      if (equalStopName(mid.name, first.boardName)) continue;

      const candidates = serviceablesByName.get(mid.name);
      if (!candidates) continue;

      for (const last of candidates) {
        // straight-line prefilter at the transfer point
        const d = haversineM(mid.coords, last.boardCoords);
        if (d > TRANSFER_PREFILTER_M) continue;

        // Don't transfer onto the very same route we're already on.
        if (
          first.kind === last.kind &&
          first.routeId === last.routeId &&
          first.railSystem === last.railSystem
        )
          continue;

        // Explicit guard: last leg must actually serve its dest stop (trivially
        // true by construction, but assert it for safety).
        if (last.kind === "BUS") {
          if (!last.stopDoc?.subRouteIds.includes(last.routeId)) continue;
        } else {
          if (!last.stationDoc?.lineIds.includes(last.routeId)) continue;
        }

        const comboKey = `${first.routeId}|${mid.name}|${last.routeId}`;
        if (seenComboKey.has(comboKey)) continue;
        seenComboKey.add(comboKey);

        const combo: TransferCombo = {
          originStop: first.originStop,
          firstLeg: first,
          midCoords: mid.coords,
          midName: mid.name,
          midStop: mid,
          destStop: last.destStop,
          lastLeg: last,
          transferWalkSec: 0,
        };
        const score =
          first.originStop.walkMinutes + d / WHEELCHAIR_SPEED_M_PER_MIN;
        scored.push({ combo, score });
      }
    }
  }

  scored.sort((a, b) => a.score - b.score);
  if (scored.length > MAX_COMBOS) {
    console.warn("[transfer-finder] transfer combo cap reached (20)");
  }
  return scored.slice(0, MAX_COMBOS).map((s) => s.combo);
}

// ─── Step 6: leg assembly helpers ────────────────────────────────────────────

/**
 * Build a BusLeg + the alighting coords/name for a transit segment, boarding at
 * `boardName` and alighting at `alightName`. Reuses fetchWaitInfo/fetchNearestBus.
 * Returns null on any failure (bad direction, missing stops, etc.).
 */
async function buildBusSegment(
  routeId: string,
  city: string,
  boardName: string,
  alightName: string
): Promise<{
  leg: BusLeg;
  rideMinutes: number;
  waitMinutes: number;
  alightCoords: [number, number];
} | null> {
  const routes = await fetchTdxRoute(routeId, city);
  if (!routes.length) return null;

  const byDir: Record<number, BusRoute["Stops"]> = {};
  for (const r of routes) byDir[r.Direction] = r.Stops;

  const direction = getRouteDirectionImproved(byDir, boardName, alightName, "Zh_tw");
  if (direction === -1) return null;

  const dirStops = byDir[direction] ?? [];
  const boardIdx = dirStops.findIndex((s) =>
    equalStopName(s.StopName?.Zh_tw, boardName)
  );
  const alightIdx = dirStops.findIndex((s) =>
    equalStopName(s.StopName?.Zh_tw, alightName)
  );
  if (boardIdx === -1 || alightIdx === -1 || boardIdx >= alightIdx) return null;

  const boardStop = dirStops[boardIdx];
  const alightStop = dirStops[alightIdx];
  const boardCoords: [number, number] = [
    boardStop.StopPosition.PositionLon,
    boardStop.StopPosition.PositionLat,
  ];
  const alightCoords: [number, number] = [
    alightStop.StopPosition.PositionLon,
    alightStop.StopPosition.PositionLat,
  ];

  const polyline: [number, number][] = dirStops
    .slice(boardIdx, alightIdx + 1)
    .map((s) => [s.StopPosition.PositionLon, s.StopPosition.PositionLat]);

  const [waitInfo, originA11y, destA11y, nearestBus] = await Promise.all([
    fetchWaitInfo(routeId, city, direction, boardName),
    OsmA11y.find(nearQuery(boardCoords, 150)).limit(5).lean<IOsmA11y[]>(),
    OsmA11y.find(nearQuery(alightCoords, 150)).limit(5).lean<IOsmA11y[]>(),
    fetchNearestBus(routeId, city, direction, boardCoords, boardIdx, dirStops),
  ]);

  const waitMinutes = waitInfoMinutes(waitInfo);
  const rideMinutes = (alightIdx - boardIdx) * 2;

  const leg: BusLeg = {
    type: "BUS",
    routeName: routeId,
    departureStop: boardName,
    arrivalStop: alightName,
    waitInfo,
    estimatedWaitMinutes: waitMinutes,
    direction: direction as 0 | 1,
    polyline,
    departureStopA11y: originA11y,
    arrivalStopA11y: destA11y,
    ...(nearestBus ? { nearestBus } : {}),
  };

  return { leg, rideMinutes, waitMinutes, alightCoords };
}

/**
 * Build a MetroLeg + alighting coords/name for a metro transit segment, boarding
 * at `boardDoc` and alighting at the line station nearest `alightTarget`.
 */
async function buildMetroSegment(
  railSystem: string,
  lineId: string,
  boardName: string,
  boardCoords: [number, number],
  alightTarget: [number, number],
  metroSeqCache: Map<string, Awaited<ReturnType<typeof fetchMetroStationOfLine>>>
): Promise<{
  leg: MetroLeg;
  rideMinutes: number;
  waitMinutes: number;
  alightName: string;
  alightCoords: [number, number];
} | null> {
  const MetroStationModel = (await import("../../model/metro-station.model"))
    .default;

  let stationOfLines = metroSeqCache.get(railSystem);
  if (!stationOfLines) {
    stationOfLines = await fetchMetroStationOfLine(railSystem);
    metroSeqCache.set(railSystem, stationOfLines);
  }
  const bare = bareLineId(railSystem, lineId);
  const sol = stationOfLines.find((s) => s.LineID === bare);
  if (!sol) return null;

  // Resolve coords for every station on the line via DB.
  const names = [...new Set(sol.Stations.map((s) => s.StationName.Zh_tw))];
  const docs = await MetroStationModel.find({
    railSystem,
    "stationName.Zh_tw": { $in: names },
  }).lean<ITdxMetroStation[]>();
  const byName = new Map<string, ITdxMetroStation>();
  for (const d of docs) byName.set(d.stationName.Zh_tw, d);

  const boardSeqIdx = sol.Stations.findIndex((s) =>
    equalStopName(s.StationName.Zh_tw, boardName)
  );
  if (boardSeqIdx === -1) return null;

  // Alighting station = station forward of boarding nearest to alightTarget.
  let alightSeqIdx = -1;
  let bestDist = Infinity;
  for (let i = boardSeqIdx + 1; i < sol.Stations.length; i++) {
    const doc = byName.get(sol.Stations[i].StationName.Zh_tw);
    if (!doc) continue;
    const d = haversineM(doc.location.coordinates as [number, number], alightTarget);
    if (d < bestDist) {
      bestDist = d;
      alightSeqIdx = i;
    }
  }
  if (alightSeqIdx === -1 || bestDist > LAST_LEG_ALIGHT_MAX_M) return null;

  const alightStationName = sol.Stations[alightSeqIdx].StationName.Zh_tw;
  const alightDoc = byName.get(alightStationName);
  if (!alightDoc) return null;
  const alightCoords = alightDoc.location.coordinates as [number, number];
  const boardDoc = byName.get(sol.Stations[boardSeqIdx].StationName.Zh_tw);
  const boardUid = boardDoc?.stationUid ?? `${railSystem}-${bare}`;
  const lineUid = lineId;

  const orderedSeq = sol.Stations.slice(boardSeqIdx, alightSeqIdx + 1);
  const polyline: [number, number][] = orderedSeq
    .map((s) => byName.get(s.StationName.Zh_tw)?.location.coordinates)
    .filter((c): c is [number, number] => !!c)
    .map((c) => c as [number, number]);

  const [travelMap, avgHeadway, boardFacility, alightFacility, boardA11y, alightA11y] =
    await Promise.all([
      fetchMetroTravelTimes(railSystem),
      fetchMetroHeadway(railSystem, lineUid),
      fetchMetroFacilities(railSystem, boardUid),
      fetchMetroFacilities(railSystem, alightDoc.stationUid),
      OsmA11y.find(nearQuery(boardCoords, 200)).limit(5).lean<IOsmA11y[]>(),
      OsmA11y.find(nearQuery(alightCoords, 200)).limit(5).lean<IOsmA11y[]>(),
    ]);

  // Ride time: sum consecutive segments along the ordered sequence.
  let rideMinutes = 0;
  for (let i = 0; i < orderedSeq.length - 1; i++) {
    const fromUid = `${railSystem}-${orderedSeq[i].StationID}`;
    const toUid = `${railSystem}-${orderedSeq[i + 1].StationID}`;
    rideMinutes += travelMap.get(`${fromUid}|${toUid}`) ?? 2;
  }
  if (rideMinutes === 0) rideMinutes = Math.max(1, orderedSeq.length - 1) * 2;

  const waitMinutes = Math.round(avgHeadway / 2);
  // Metro is headway-only (no timetable clock) — numeric expected wait.
  const waitInfo: WaitInfo = { time: waitMinutes, source: "schedule" };

  const facilityHighlights: string[] = [];
  for (const [facility, prefix] of [
    [boardFacility, "乘車站"],
    [alightFacility, "下車站"],
  ] as [TdxMetroStationFacility | null, string][]) {
    if (!facility) continue;
    for (const f of facility.Facilities) {
      const label = FACILITY_LABELS[f.FacilityType];
      if (label) facilityHighlights.push(`${prefix}${label}`);
    }
  }

  const leg: MetroLeg = {
    type: "METRO",
    railSystem,
    lineId: bare,
    lineName: lineUid,
    lineUid,
    departureStation: boardName,
    arrivalStation: alightStationName,
    departureStationUid: boardUid,
    arrivalStationUid: alightDoc.stationUid,
    direction: 0,
    stopsCount: orderedSeq.length - 1,
    rideMinutes,
    waitInfo,
    estimatedWaitMinutes: waitMinutes,
    polyline,
    departureStationA11y: boardA11y,
    arrivalStationA11y: alightA11y,
    facilityHighlights,
  };

  return { leg, rideMinutes, waitMinutes, alightName: alightStationName, alightCoords };
}

// ─── Step 6: assemble a full transfer route from one combo ───────────────────

async function assembleCombo(
  combo: TransferCombo,
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  metroSeqCache: Map<string, Awaited<ReturnType<typeof fetchMetroStationOfLine>>>
): Promise<AccessibleRoute | null> {
  const originCoords: [number, number] = [origin.lng, origin.lat];
  const destCoords: [number, number] = [destination.lng, destination.lat];

  // ── Leg 2: first transit leg (board origin stop → S_mid) ──
  let firstLeg: BusLeg | MetroLeg;
  let firstRideMin: number;
  let firstWaitMin: number;
  let firstAlightCoords: [number, number];

  if (combo.firstLeg.kind === "BUS") {
    const seg = await buildBusSegment(
      combo.firstLeg.routeId,
      combo.firstLeg.city,
      combo.firstLeg.boardName,
      combo.midName
    );
    if (!seg) return null;
    firstLeg = seg.leg;
    firstRideMin = seg.rideMinutes;
    firstWaitMin = seg.waitMinutes;
    firstAlightCoords = seg.alightCoords;
  } else {
    const railSystem = combo.firstLeg.railSystem!;
    const seg = await buildMetroSegment(
      railSystem,
      combo.firstLeg.routeId,
      combo.firstLeg.boardName,
      combo.firstLeg.boardCoords,
      combo.midCoords,
      metroSeqCache
    );
    if (!seg) return null;
    // Force the metro first-leg to alight at S_mid specifically.
    if (!equalStopName(seg.alightName, combo.midName)) {
      // S_mid wasn't the chosen alighting station — rebuild not possible; skip.
      return null;
    }
    firstLeg = seg.leg;
    firstRideMin = seg.rideMinutes;
    firstWaitMin = seg.waitMinutes;
    firstAlightCoords = seg.alightCoords;
  }

  // ── Leg 4: last transit leg (board dest stop → alight near destination) ──
  let lastLeg: BusLeg | MetroLeg;
  let lastRideMin: number;
  let lastWaitMin: number;
  let lastAlightName: string;
  let lastAlightCoords: [number, number];

  if (combo.lastLeg.kind === "BUS") {
    // Determine the alighting stop nearest destination on this route.
    const routes = await fetchTdxRoute(combo.lastLeg.routeId, combo.lastLeg.city);
    if (!routes.length) return null;
    const byDir: Record<number, BusRoute["Stops"]> = {};
    for (const r of routes) byDir[r.Direction] = r.Stops;

    // Find direction where the board stop appears, then nearest-to-dest stop after it.
    let chosen: { name: string; coords: [number, number] } | null = null;
    let bestDist = Infinity;
    for (const dirStr of Object.keys(byDir)) {
      const dir = Number(dirStr);
      const stops = byDir[dir];
      const boardIdx = stops.findIndex((s) =>
        equalStopName(s.StopName?.Zh_tw, combo.lastLeg.boardName)
      );
      if (boardIdx === -1) continue;
      for (let i = boardIdx + 1; i < stops.length; i++) {
        const c: [number, number] = [
          stops[i].StopPosition.PositionLon,
          stops[i].StopPosition.PositionLat,
        ];
        const d = haversineM(c, destCoords);
        if (d < bestDist) {
          bestDist = d;
          chosen = { name: stops[i].StopName.Zh_tw, coords: c };
        }
      }
    }
    if (!chosen || bestDist > LAST_LEG_ALIGHT_MAX_M) return null;

    const seg = await buildBusSegment(
      combo.lastLeg.routeId,
      combo.lastLeg.city,
      combo.lastLeg.boardName,
      chosen.name
    );
    if (!seg) return null;
    lastLeg = seg.leg;
    lastRideMin = seg.rideMinutes;
    lastWaitMin = seg.waitMinutes;
    lastAlightName = chosen.name;
    lastAlightCoords = seg.alightCoords;
  } else {
    const railSystem = combo.lastLeg.railSystem!;
    const seg = await buildMetroSegment(
      railSystem,
      combo.lastLeg.routeId,
      combo.lastLeg.boardName,
      combo.lastLeg.boardCoords,
      destCoords,
      metroSeqCache
    );
    if (!seg) return null;
    lastLeg = seg.leg;
    lastRideMin = seg.rideMinutes;
    lastWaitMin = seg.waitMinutes;
    lastAlightName = seg.alightName;
    lastAlightCoords = seg.alightCoords;
  }

  // ── Walks (Legs 1, 3, 5) + A11y facility lookups, parallel ──
  const [walk1, walk3, walk5, walk1A11y, walk3A11y, walk5A11y] = await Promise.all([
    orsWalkingRoute(originCoords, combo.firstLeg.boardCoords),
    orsWalkingRoute(combo.midCoords, combo.lastLeg.boardCoords),
    orsWalkingRoute(lastAlightCoords, destCoords),
    OsmA11y.find(nearQuery(combo.firstLeg.boardCoords, 150)).limit(5).lean<IOsmA11y[]>(),
    OsmA11y.find(nearQuery(combo.midCoords, 150)).limit(5).lean<IOsmA11y[]>(),
    OsmA11y.find(nearQuery(lastAlightCoords, 150)).limit(5).lean<IOsmA11y[]>(),
  ]);

  // exitInfo enrichment for TRTC metro endpoints.
  const [leg1Exit, leg3Exit] = await Promise.all([
    combo.firstLeg.kind === "METRO" && combo.firstLeg.railSystem === "TRTC"
      ? lookupTrtcExit("TRTC", combo.firstLeg.boardName, combo.firstLeg.boardCoords)
      : Promise.resolve<WalkLeg["exitInfo"]>(null),
    combo.lastLeg.kind === "METRO" && combo.lastLeg.railSystem === "TRTC"
      ? lookupTrtcExit("TRTC", combo.midName, combo.midCoords)
      : Promise.resolve<WalkLeg["exitInfo"]>(null),
  ]);

  const transferWalkSec =
    combo.transferWalkSec > 0 ? combo.transferWalkSec : walk3.durationSec;
  const transferWalkMin = Math.round(transferWalkSec / 60);

  const walkLeg1: WalkLeg = {
    type: "WALK",
    from: "出發地",
    to: combo.firstLeg.boardName,
    distanceM: Math.round(walk1.distanceM),
    minutesEst: Math.round(walk1.durationSec / 60),
    polyline: walk1.polyline,
    a11yFacilities: walk1A11y,
    exitInfo: leg1Exit ?? null,
  };

  const walkLeg3: WalkLeg = {
    type: "WALK",
    from: combo.midName,
    to: combo.lastLeg.boardName,
    distanceM: Math.round(haversineM(combo.midCoords, combo.lastLeg.boardCoords)),
    minutesEst: transferWalkMin,
    polyline: walk3.polyline,
    a11yFacilities: walk3A11y,
    exitInfo: leg3Exit ?? null,
  };

  const walkLeg5: WalkLeg = {
    type: "WALK",
    from: lastAlightName,
    to: "目的地",
    distanceM: Math.round(walk5.distanceM),
    minutesEst: Math.round(walk5.durationSec / 60),
    polyline: walk5.polyline,
    a11yFacilities: walk5A11y,
    exitInfo: null,
  };

  const totalMinutes =
    Math.round(walk1.durationSec / 60) +
    firstWaitMin +
    firstRideMin +
    transferWalkMin +
    lastWaitMin +
    lastRideMin +
    Math.round(walk5.durationSec / 60);

  const originUid =
    combo.originStop.kind === "bus"
      ? (combo.originStop.doc as ITdxBusStop).stopUid
      : (combo.originStop.doc as ITdxMetroStation).stationUid;
  const destUid =
    combo.destStop.kind === "bus"
      ? (combo.destStop.doc as ITdxBusStop).stopUid
      : (combo.destStop.doc as ITdxMetroStation).stationUid;

  // Highlights: collect from all legs, dedupe.
  const highlightSet = new Set<string>();
  for (const h of pointHighlights(walk1A11y, "上車站")) highlightSet.add(h);
  for (const h of pointHighlights(walk3A11y, "轉乘站")) highlightSet.add(h);
  for (const h of pointHighlights(walk5A11y, "下車站")) highlightSet.add(h);
  if (firstLeg.type === "METRO")
    for (const h of firstLeg.facilityHighlights) highlightSet.add(h);
  if (lastLeg.type === "METRO")
    for (const h of lastLeg.facilityHighlights) highlightSet.add(h);
  if (leg1Exit) highlightSet.add("上車站出入口有無障礙電梯/坡道");
  if (leg3Exit) highlightSet.add("轉乘站出入口有無障礙電梯/坡道");

  return {
    routeId: `TRANSFER-${originUid}-${combo.firstLeg.routeId}-${combo.midName}-${combo.lastLeg.routeId}-${destUid}`,
    routeName: `${combo.firstLeg.routeId} → 轉乘 → ${combo.lastLeg.routeId}`,
    totalMinutes,
    transferCount: 1,
    legs: [walkLeg1, firstLeg, walkLeg3, lastLeg, walkLeg5],
    accessibilityHighlights: [...highlightSet],
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function findTransferRoutes(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  city: TaiwanCityEn
): Promise<AccessibleRoute[]> {
  void CITY_METRO_SYSTEMS; // city→metro mapping (metro stops carry railSystem directly)
  void BusStopModel;

  // Step 1
  const [originStops, destStops] = await Promise.all([
    findReachableStops(origin, { maxWalkMin: MAX_WALK_MIN }),
    findReachableStops(destination, { maxWalkMin: MAX_WALK_MIN }),
  ]);
  if (!originStops.length || !destStops.length) return [];

  // Per-invocation cache of metro line sequences, keyed by railSystem.
  const metroSeqCache = new Map<
    string,
    Awaited<ReturnType<typeof fetchMetroStationOfLine>>
  >();

  // Steps 2 & 3
  const [boardables, serviceable] = await Promise.all([
    enumerateBoardableRoutes(originStops, metroSeqCache),
    Promise.resolve(enumerateServiceableRoutes(destStops, city)),
  ]);
  if (!boardables.length || !serviceable.routes.length) return [];

  // Step 4
  const combos = findTransferCombos(boardables, serviceable.byName);
  if (!combos.length) return [];

  // Step 5: resolve transfer walk-times in one ORS matrix call.
  // Build a de-duplicated set of (S_mid → last-leg board) pairs.
  const pairKey = (a: [number, number], b: [number, number]) =>
    `${a[0]},${a[1]}|${b[0]},${b[1]}`;
  const uniquePairs = new Map<
    string,
    { from: [number, number]; to: [number, number] }
  >();
  for (const c of combos) {
    uniquePairs.set(pairKey(c.midCoords, c.lastLeg.boardCoords), {
      from: c.midCoords,
      to: c.lastLeg.boardCoords,
    });
  }
  // ORS matrix is one-source-to-many; run one matrix call per unique S_mid origin.
  const byOrigin = new Map<string, [number, number][]>();
  const originOf = new Map<string, [number, number]>();
  for (const { from, to } of uniquePairs.values()) {
    const k = `${from[0]},${from[1]}`;
    originOf.set(k, from);
    const arr = byOrigin.get(k);
    if (arr) arr.push(to);
    else byOrigin.set(k, [to]);
  }
  const walkSecByPair = new Map<string, number | null>();
  await Promise.all(
    [...byOrigin.entries()].map(async ([k, dests]) => {
      const from = originOf.get(k)!;
      const durations = await orsWalkingMatrix(from, dests);
      dests.forEach((to, i) => {
        walkSecByPair.set(pairKey(from, to), durations[i]);
      });
    })
  );

  // Map matrix results back; discard unreachable / too-long transfers.
  const survivors: TransferCombo[] = [];
  for (const c of combos) {
    const sec = walkSecByPair.get(pairKey(c.midCoords, c.lastLeg.boardCoords));
    if (sec === null || sec === undefined) continue;
    if (sec > MAX_TRANSFER_WALK_SEC) continue;
    c.transferWalkSec = sec;
    survivors.push(c);
  }
  if (!survivors.length) return [];

  // Step 6: assemble (each combo wrapped so a failure yields null).
  const assembled = await Promise.all(
    survivors.map((c) =>
      assembleCombo(c, origin, destination, metroSeqCache).catch(() => null)
    )
  );
  const valid = assembled.filter((r): r is AccessibleRoute => r !== null);
  if (!valid.length) return [];

  // Step 7: score & return (caller merges + re-ranks with direct routes).
  return scoreAndRank(valid);
}
