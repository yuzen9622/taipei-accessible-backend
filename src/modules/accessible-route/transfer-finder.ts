/**
 * One-transfer route finder.
 *
 * Builds wheelchair-accessible routes that require exactly one transfer between
 * two transit legs (bus↔bus, bus↔metro, metro↔metro). Reuses the direct-route
 * helpers exported from accessible-route.service.ts so TDX-fetch / scoring logic
 * is never duplicated. All coordinates are [lng, lat] (GeoJSON / ORS convention).
 *
 * High-level flow: find reachable stops on each side, enumerate first-leg and
 * last-leg routes, join them on intermediate stops with a straight-line
 * prefilter, resolve transfer walk-times via one ORS matrix call, assemble
 * five-leg AccessibleRoute objects, then score with the shared scoreAndRank.
 */

import {
  haversineM,
  nearQuery,
  fetchTdxRoute,
  fetchWaitInfo,
  waitInfoMinutes,
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
} from "./planners/reachable-stops";

import {
  orsWalkingRoute,
  orsWalkingMatrix,
  WHEELCHAIR_SPEED_M_PER_MIN,
} from "./planners/ors";

import { CITY_METRO_SYSTEMS } from "../../config/transit";
import { TaiwanCityEn } from "../../types/transit";

import { getRouteDirectionImproved, equalStopName } from "../../utils/transit-text";

import BusStopModel from "../../model/bus-stop.model";
import OsmA11y from "../../model/osm-a11y.model";
import {
  findAccessibleExits,
  selectNearestExit,
} from "./planners/a11y-exit";

import {
  ITdxBusStop,
  ITdxMetroStation,
  IOsmA11y,
} from "../../types";
import { BusRoute, TdxMetroStationFacility } from "../../types/transit";

const MAX_WALK_MIN = 20;
const MAX_ORIGIN_STOPS = 10;
const MAX_DEST_STOPS = 10;
const MAX_ROUTES_PER_STOP = 3;
const TRANSFER_PREFILTER_M = 800;
const MAX_TRANSFER_WALK_SEC = 10 * 60;
const MAX_COMBOS = 20;
const LAST_LEG_ALIGHT_MAX_M = 2000;

interface IntermediateStop {
  name: string;
  coords: [number, number];
  stopIdx: number;
  direction: number;
}

interface BoardableRoute {
  kind: "BUS" | "METRO";
  routeId: string;
  railSystem?: string;
  city: string;
  originStop: ReachableStop;
  boardName: string;
  boardCoords: [number, number];
  stopSequence: IntermediateStop[];
}

interface ServiceableRoute {
  kind: "BUS" | "METRO";
  routeId: string;
  railSystem?: string;
  city: string;
  destStop: ReachableStop;
  boardName: string;
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
  transferWalkSec: number;
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
 *
 * @param nodes OSM a11y nodes near the point.
 * @param label Location label prefixed onto each highlight string.
 * @returns The highlight strings for the point.
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
 * TRTC exit-info lookup. Returns the closest elevator/ramp exit at the given
 * station to `near`, or null. Only valid when railSystem === "TRTC".
 *
 * @param railSystem Rail system code; only "TRTC" yields a result.
 * @param stationName Station name to look up exits for.
 * @param near Reference coordinate the nearest exit is chosen against.
 * @returns The nearest exit info, or null.
 */
async function lookupTrtcExit(
  railSystem: string,
  stationName: string,
  near: [number, number]
): Promise<WalkLeg["exitInfo"]> {
  if (railSystem !== "TRTC") return null;
  try {
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
          /* skip this route on any TDX failure */
        }
      }
    } else {
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
          const seq: IntermediateStop[] = sol.Stations.slice(boardIdx + 1).map(
            (s, i) => ({
              name: s.StationName.Zh_tw,
              coords: [0, 0] as [number, number],
              stopIdx: boardIdx + 1 + i,
              direction: 0,
            })
          );
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
          /* skip this line on any TDX failure */
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
 *
 * @param railSystem Rail system the stations belong to.
 * @param seq Station sequence whose coordinates are resolved.
 * @returns The sequence with resolved coordinates, dropping unstored stations.
 */
async function resolveMetroSeqCoords(
  railSystem: string,
  seq: IntermediateStop[]
): Promise<IntermediateStop[]> {
  if (!seq.length) return [];
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
      if (equalStopName(mid.name, first.boardName)) continue;

      const candidates = serviceablesByName.get(mid.name);
      if (!candidates) continue;

      for (const last of candidates) {
        const d = haversineM(mid.coords, last.boardCoords);
        if (d > TRANSFER_PREFILTER_M) continue;

        if (
          first.kind === last.kind &&
          first.routeId === last.routeId &&
          first.railSystem === last.railSystem
        )
          continue;

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

/**
 * Build a BusLeg plus the alighting coords for a transit segment, boarding at
 * `boardName` and alighting at `alightName`. Reuses fetchWaitInfo.
 *
 * @param routeId TDX subRouteId of the bus route.
 * @param city TDX City segment for the route.
 * @param boardName Boarding stop name (Zh_tw).
 * @param alightName Alighting stop name (Zh_tw).
 * @returns The leg, ride/wait minutes and alighting coords, or null on failure.
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

  const [waitInfo, originA11y, destA11y] = await Promise.all([
    fetchWaitInfo(routeId, city, direction, boardName),
    OsmA11y.find(nearQuery(boardCoords, 150)).limit(5).lean<IOsmA11y[]>(),
    OsmA11y.find(nearQuery(alightCoords, 150)).limit(5).lean<IOsmA11y[]>(),
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
    tdxCity: city,
  };

  return { leg, rideMinutes, waitMinutes, alightCoords };
}

/**
 * Build a MetroLeg plus alighting coords/name for a metro transit segment,
 * boarding at `boardName` and alighting at the line station nearest
 * `alightTarget`.
 *
 * @param railSystem Rail system code.
 * @param lineId Metro line id to ride.
 * @param boardName Boarding station name (Zh_tw).
 * @param boardCoords Boarding station coordinates.
 * @param alightTarget Target coordinate the alighting station is chosen near.
 * @param metroSeqCache Per-invocation cache of line sequences by rail system.
 * @returns The leg, ride/wait minutes and alighting name/coords, or null on
 *   failure.
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

  let rideMinutes = 0;
  for (let i = 0; i < orderedSeq.length - 1; i++) {
    const fromUid = `${railSystem}-${orderedSeq[i].StationID}`;
    const toUid = `${railSystem}-${orderedSeq[i + 1].StationID}`;
    rideMinutes += travelMap.get(`${fromUid}|${toUid}`) ?? 2;
  }
  if (rideMinutes === 0) rideMinutes = Math.max(1, orderedSeq.length - 1) * 2;

  const waitMinutes = Math.round(avgHeadway / 2);
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

async function assembleCombo(
  combo: TransferCombo,
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  metroSeqCache: Map<string, Awaited<ReturnType<typeof fetchMetroStationOfLine>>>
): Promise<AccessibleRoute | null> {
  const originCoords: [number, number] = [origin.lng, origin.lat];
  const destCoords: [number, number] = [destination.lng, destination.lat];

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
    if (!equalStopName(seg.alightName, combo.midName)) {
      return null;
    }
    firstLeg = seg.leg;
    firstRideMin = seg.rideMinutes;
    firstWaitMin = seg.waitMinutes;
    firstAlightCoords = seg.alightCoords;
  }

  let lastLeg: BusLeg | MetroLeg;
  let lastRideMin: number;
  let lastWaitMin: number;
  let lastAlightName: string;
  let lastAlightCoords: [number, number];

  if (combo.lastLeg.kind === "BUS") {
    const routes = await fetchTdxRoute(combo.lastLeg.routeId, combo.lastLeg.city);
    if (!routes.length) return null;
    const byDir: Record<number, BusRoute["Stops"]> = {};
    for (const r of routes) byDir[r.Direction] = r.Stops;

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

  const [walk1, walk3, walk5, walk1A11y, walk3A11y, walk5A11y] = await Promise.all([
    orsWalkingRoute(originCoords, combo.firstLeg.boardCoords),
    orsWalkingRoute(combo.midCoords, combo.lastLeg.boardCoords),
    orsWalkingRoute(lastAlightCoords, destCoords),
    OsmA11y.find(nearQuery(combo.firstLeg.boardCoords, 150)).limit(5).lean<IOsmA11y[]>(),
    OsmA11y.find(nearQuery(combo.midCoords, 150)).limit(5).lean<IOsmA11y[]>(),
    OsmA11y.find(nearQuery(lastAlightCoords, 150)).limit(5).lean<IOsmA11y[]>(),
  ]);

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

export async function findTransferRoutes(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  city: TaiwanCityEn
): Promise<AccessibleRoute[]> {
  void CITY_METRO_SYSTEMS;
  void BusStopModel;

  const [originStops, destStops] = await Promise.all([
    findReachableStops(origin, { maxWalkMin: MAX_WALK_MIN }),
    findReachableStops(destination, { maxWalkMin: MAX_WALK_MIN }),
  ]);
  if (!originStops.length || !destStops.length) return [];

  const metroSeqCache = new Map<
    string,
    Awaited<ReturnType<typeof fetchMetroStationOfLine>>
  >();

  const [boardables, serviceable] = await Promise.all([
    enumerateBoardableRoutes(originStops, metroSeqCache),
    Promise.resolve(enumerateServiceableRoutes(destStops, city)),
  ]);
  if (!boardables.length || !serviceable.routes.length) return [];

  const combos = findTransferCombos(boardables, serviceable.byName);
  if (!combos.length) return [];

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

  const survivors: TransferCombo[] = [];
  for (const c of combos) {
    const sec = walkSecByPair.get(pairKey(c.midCoords, c.lastLeg.boardCoords));
    if (sec === null || sec === undefined) continue;
    if (sec > MAX_TRANSFER_WALK_SEC) continue;
    c.transferWalkSec = sec;
    survivors.push(c);
  }
  if (!survivors.length) return [];

  const assembled = await Promise.all(
    survivors.map((c) =>
      assembleCombo(c, origin, destination, metroSeqCache).catch(() => null)
    )
  );
  const valid = assembled.filter((r): r is AccessibleRoute => r !== null);
  if (!valid.length) return [];

  return scoreAndRank(valid);
}
