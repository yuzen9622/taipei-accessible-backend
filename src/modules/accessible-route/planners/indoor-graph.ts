/**
 * Phase 8 — Indoor Graph Layer (system-agnostic).
 *
 * Upgrades indoor navigation from the TRTC-only `A11y` collection (Phase 5) to
 * the GTFS `pathways.txt` graph (spec §10), which covers EVERY system that ships
 * indoor data in this feed — TRTC, NTMC, KLRT, TMRT, KRTC, TYMC, THSR, TRA — with
 * a single traversal.
 *
 * Data model (two disjoint stop namespaces in this feed):
 *   • Routing nodes — `TRTC_R28`, no parent_station, referenced by stop_times.
 *   • Indoor nodes  — numeric ids, linked by parent_station to a location_type=1
 *                     station node, referenced by pathways (NOT stop_times).
 * The two are bridged by stop_name + proximity (same trick the GTFS router uses
 * for transfer hubs), since they share no ids.
 *
 * Indoor node taxonomy under a station (location_type=1):
 *   0 = platform   2 = entrance/exit   3 = generic node (gate / elevator landing)
 *
 * Pathway modes (spec §10.2): 1 walkway · 2 stairs · 3 moving sidewalk ·
 *   4 escalator · 5 elevator · 6 fare gate · 7 exit gate.
 * Wheelchair traversal excludes stairs (2) and prefers elevators (5).
 *
 * All coordinates are [lng, lat] (GeoJSON order); no conversion is performed.
 */

import { GtfsStop, IGtfsStop } from "../../../model/gtfs-stop.model";
import { GtfsPathway, IGtfsPathway } from "../../../model/gtfs-pathway.model";
import { GtfsLevel } from "../../../model/gtfs-level.model";
import { equalStopName } from "../../../config/lib";
import { haversineCoords } from "./ors";

export type AccessibilityMode =
  | "wheelchair"
  | "elderly"
  | "visual_impaired"
  | "normal";

/** Default traversal seconds when pathways.txt omits `traversal_time` (spec §10.2). */
const DEFAULT_TRAVERSAL_SEC: Record<number, number> = {
  1: 15, // walkway
  2: 20, // stairs
  3: 15, // moving sidewalk
  4: 20, // escalator
  5: 30, // elevator
  6: 5, // fare gate
  7: 5, // exit gate
};

/** Modes a wheelchair user cannot traverse. */
const WHEELCHAIR_BLOCKED_MODES = new Set([2]); // stairs

/** Extra cost (s) to deprioritise non-preferred modes in wheelchair routing. */
const ESCALATOR_WHEELCHAIR_PENALTY = 120;

/** Max distance (m) between a routing-node coordinate and a candidate indoor
 * station node for the two to be considered the same physical station. */
const STATION_MATCH_RADIUS_M = 600;

// ─────────────────────────────────────────────────────────────────────────────
// Station bridging — routing node → indoor station node
// ─────────────────────────────────────────────────────────────────────────────

export interface IndoorStation {
  stationId: string;
  stopName: string;
  coords: [number, number];
}

/**
 * Resolve the indoor station node (location_type=1) that corresponds to a
 * routing station, matching by stop_name + proximity. Returns null when this
 * feed carries no indoor data for the station (e.g. most bus stops, TRA halts).
 */
export async function findIndoorStation(
  name: string,
  coords: [number, number]
): Promise<IndoorStation | null> {
  // Exact name first (the common case), then a contains-regex fallback.
  let candidates = await GtfsStop.find({ locationType: 1, stopName: name })
    .lean<IGtfsStop[]>();
  if (!candidates.length) {
    const core = name.replace(/[站台臺]+$/u, "").trim();
    if (core) {
      candidates = await GtfsStop.find({
        locationType: 1,
        stopName: { $regex: escapeRegExp(core) },
      }).lean<IGtfsStop[]>();
    }
  }
  if (!candidates.length) return null;

  let best: IGtfsStop | null = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    if (!equalStopName(c.stopName, name)) continue;
    const cc = c.location?.coordinates as [number, number] | undefined;
    // Placeholder [0,0] nodes have no usable geometry — fall back to name-only.
    const dist =
      cc && (cc[0] !== 0 || cc[1] !== 0) ? haversineCoords(coords, cc) : 0;
    if (dist < bestDist) {
      bestDist = dist;
      best = c;
    }
  }
  if (!best) return null;
  if (bestDist > STATION_MATCH_RADIUS_M) return null;

  return {
    stationId: best.stopId,
    stopName: best.stopName,
    coords: best.location.coordinates as [number, number],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pathway graph traversal (Dijkstra, bounded to one station)
// ─────────────────────────────────────────────────────────────────────────────

interface Edge {
  to: string;
  mode: number;
  cost: number;
}

/** One step in a resolved indoor path. */
export interface IndoorPathStep {
  stopId: string;
  /** Pathway mode used to ARRIVE at this stop (undefined for the start node). */
  viaMode?: number;
}

export interface IndoorPath {
  steps: IndoorPathStep[];
  totalSeconds: number;
  /** True when the path traverses at least one elevator (mode 5). */
  usesElevator: boolean;
  /** True when the path traverses stairs (mode 2) — only when not excluded. */
  usesStairs: boolean;
}

export interface FindIndoorPathOptions {
  /** Pathway modes that may NOT be traversed (wheelchair → [2]). */
  excludePathwayModes?: number[];
  /** Pathway modes to favour with zero/low cost (wheelchair → [5]). */
  preferPathwayModes?: number[];
  mode?: AccessibilityMode;
  /** Restrict traversal to this node-id set (a single station's nodes). */
  allowedNodeIds?: Set<string>;
}

function edgeCost(
  p: IGtfsPathway,
  opts: FindIndoorPathOptions
): number | null {
  const exclude = new Set(opts.excludePathwayModes ?? []);
  if (exclude.has(p.pathwayMode)) return null; // impassable

  let cost = p.traversalTime ?? DEFAULT_TRAVERSAL_SEC[p.pathwayMode] ?? 15;

  // Wheelchair: penalise escalators so an elevator path is chosen when one exists.
  if (opts.mode === "wheelchair" && p.pathwayMode === 4) {
    cost += ESCALATOR_WHEELCHAIR_PENALTY;
  }
  return cost;
}

/**
 * Build the adjacency list for a set of indoor node ids. Bidirectional pathways
 * yield edges in both directions; one-directional escalators/gates only forward.
 */
async function buildAdjacency(
  nodeIds: Set<string>,
  opts: FindIndoorPathOptions
): Promise<Map<string, Edge[]>> {
  const ids = [...nodeIds];
  const pathways = await GtfsPathway.find({
    $or: [{ fromStopId: { $in: ids } }, { toStopId: { $in: ids } }],
  }).lean<IGtfsPathway[]>();

  const adj = new Map<string, Edge[]>();
  const push = (from: string, e: Edge) => {
    const arr = adj.get(from);
    if (arr) arr.push(e);
    else adj.set(from, [e]);
  };

  for (const p of pathways) {
    // Stay inside the station's node set (avoids wandering into neighbours that
    // share a pathway id range).
    if (!nodeIds.has(p.fromStopId) || !nodeIds.has(p.toStopId)) continue;
    const cost = edgeCost(p, opts);
    if (cost === null) continue;
    push(p.fromStopId, { to: p.toStopId, mode: p.pathwayMode, cost });
    if (p.isBidirectional === 1) {
      push(p.toStopId, { to: p.fromStopId, mode: p.pathwayMode, cost });
    }
  }
  return adj;
}

/**
 * Dijkstra over a prebuilt adjacency list. Pure (no I/O), so callers that probe
 * many origin/destination pairs within one station build the graph once and
 * reuse it. Returns null when `toStopId` is unreachable.
 */
function dijkstraPath(
  adj: Map<string, Edge[]>,
  fromStopId: string,
  toStopId: string
): IndoorPath | null {
  if (fromStopId === toStopId) {
    return { steps: [{ stopId: fromStopId }], totalSeconds: 0, usesElevator: false, usesStairs: false };
  }

  const dist = new Map<string, number>([[fromStopId, 0]]);
  const prev = new Map<string, { from: string; mode: number }>();
  const visited = new Set<string>();

  while (true) {
    let cur: string | null = null;
    let curDist = Infinity;
    for (const [node, d] of dist) {
      if (!visited.has(node) && d < curDist) {
        curDist = d;
        cur = node;
      }
    }
    if (cur === null) break;
    if (cur === toStopId) break;
    visited.add(cur);

    for (const e of adj.get(cur) ?? []) {
      if (visited.has(e.to)) continue;
      const nd = curDist + e.cost;
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        prev.set(e.to, { from: cur, mode: e.mode });
      }
    }
  }

  if (!dist.has(toStopId)) return null;

  const steps: IndoorPathStep[] = [];
  let node: string | undefined = toStopId;
  let usesElevator = false;
  let usesStairs = false;
  while (node) {
    const p = prev.get(node);
    steps.unshift({ stopId: node, viaMode: p?.mode });
    if (p?.mode === 5) usesElevator = true;
    if (p?.mode === 2) usesStairs = true;
    node = p?.from;
  }

  return { steps, totalSeconds: dist.get(toStopId) ?? 0, usesElevator, usesStairs };
}

/** Collect every node id belonging to a station (children + the station node). */
export async function getStationNodeIds(stationId: string): Promise<Set<string>> {
  const kids = await GtfsStop.find({ parentStation: stationId })
    .select("stopId")
    .lean<{ stopId: string }[]>();
  const set = new Set(kids.map((k) => k.stopId));
  set.add(stationId);
  return set;
}

/**
 * Shortest accessible indoor path between two nodes within a station, via
 * Dijkstra over the pathway graph. Returns null when no permitted path exists
 * (e.g. wheelchair user and every route needs stairs).
 */
export async function findIndoorPath(
  fromStopId: string,
  toStopId: string,
  opts: FindIndoorPathOptions = {}
): Promise<IndoorPath | null> {
  if (fromStopId === toStopId) {
    return { steps: [{ stopId: fromStopId }], totalSeconds: 0, usesElevator: false, usesStairs: false };
  }

  const nodeIds =
    opts.allowedNodeIds ??
    (await (async () => {
      // Default scope: union of both endpoints' stations.
      const set = new Set<string>([fromStopId, toStopId]);
      const ends = await GtfsStop.find({ stopId: { $in: [fromStopId, toStopId] } })
        .select("parentStation")
        .lean<{ parentStation?: string }[]>();
      for (const e of ends) {
        if (e.parentStation) {
          const sub = await getStationNodeIds(e.parentStation);
          sub.forEach((id) => set.add(id));
        }
      }
      return set;
    })());
  nodeIds.add(fromStopId);
  nodeIds.add(toStopId);

  const adj = await buildAdjacency(nodeIds, opts);
  return dijkstraPath(adj, fromStopId, toStopId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Entrances / platforms / accessibility derivation
// ─────────────────────────────────────────────────────────────────────────────

/** Entrance nodes (location_type=2) of a station, with usable coordinates. */
export async function getStationEntrances(stationId: string): Promise<IGtfsStop[]> {
  const docs = await GtfsStop.find({ parentStation: stationId, locationType: 2 })
    .lean<IGtfsStop[]>();
  return docs.filter((d) => {
    const c = d.location?.coordinates;
    return c && (c[0] !== 0 || c[1] !== 0);
  });
}

/** Platform nodes (location_type=0) of a station. */
export async function getStationPlatforms(stationId: string): Promise<IGtfsStop[]> {
  return GtfsStop.find({ parentStation: stationId, locationType: 0 })
    .lean<IGtfsStop[]>();
}

/** Entrance nearest the user, by Haversine distance. */
export function selectNearestEntrance(
  userCoords: [number, number],
  entrances: IGtfsStop[]
): IGtfsStop | null {
  let best: IGtfsStop | null = null;
  let bestDist = Infinity;
  for (const e of entrances) {
    const d = haversineCoords(userCoords, e.location.coordinates as [number, number]);
    if (d < bestDist) {
      bestDist = d;
      best = e;
    }
  }
  return best;
}

/**
 * Derive step-free accessibility from the indoor graph (spec §10.4): a station
 * is wheelchair-accessible iff at least one elevator pathway (mode 5) connects
 * its nodes. Cheap existence check; never throws.
 */
export async function stationHasElevator(stationId: string): Promise<boolean> {
  try {
    const nodeIds = [...(await getStationNodeIds(stationId))];
    if (!nodeIds.length) return false;
    const count = await GtfsPathway.countDocuments({
      fromStopId: { $in: nodeIds },
      pathwayMode: 5,
    });
    return count > 0;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// High-level station access (the wiring surface for the router)
// ─────────────────────────────────────────────────────────────────────────────

export interface StationAccess {
  stationId: string;
  stationName: string;
  /** Nearest entrance to the user; null when the station lists no entrances. */
  entrance: {
    stopId: string;
    name: string;
    /** Best-effort exit identifier parsed from the name, or "". */
    exitNumber: string;
    coords: [number, number];
  } | null;
  /** Whether the station has any elevator pathway at all. */
  hasElevator: boolean;
  /**
   * Whether a step-free path exists from the chosen entrance to a platform for
   * the requested mode (wheelchair excludes stairs). Null when not evaluated
   * (no entrance or no platform data).
   */
  stepFree: boolean | null;
  /** Whether the chosen entrance→platform path actually rides an elevator. */
  usesElevator: boolean;
  /** levels.txt name of the first elevator landing on the path, when resolvable. */
  elevatorLevelName?: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseExitNumber(name: string): string {
  const m = name.match(/(\d+)/);
  return m ? m[1] : "";
}

/**
 * Resolve indoor access for a station from the routing node's name + coords.
 * Returns null when the feed has no indoor graph for the station (caller should
 * fall back to the TRTC A11y collection / station-centroid walk).
 *
 * Picks the entrance nearest the user, then the shortest mode-appropriate path
 * to any platform. Never throws — any failure degrades to null.
 */
export async function getStationAccess(
  station: { name: string; coords: [number, number] },
  userCoords: [number, number],
  mode: AccessibilityMode = "wheelchair"
): Promise<StationAccess | null> {
  try {
    const indoor = await findIndoorStation(station.name, station.coords);
    if (!indoor) return null;

    const [entrances, platforms, hasElevator] = await Promise.all([
      getStationEntrances(indoor.stationId),
      getStationPlatforms(indoor.stationId),
      stationHasElevator(indoor.stationId),
    ]);

    const toEntrance = (e: IGtfsStop) => ({
      stopId: e.stopId,
      name: e.stopName,
      exitNumber: parseExitNumber(e.stopName),
      coords: e.location.coordinates as [number, number],
    });

    const nearest = selectNearestEntrance(userCoords, entrances);
    const base: StationAccess = {
      stationId: indoor.stationId,
      stationName: indoor.stopName,
      entrance: nearest ? toEntrance(nearest) : null,
      hasElevator,
      stepFree: null,
      usesElevator: false,
    };

    if (!nearest || !platforms.length) return base;

    // Build the station graph ONCE (mode-aware), then probe every entrance.
    const allowed = await getStationNodeIds(indoor.stationId);
    const adj = await buildAdjacency(allowed, {
      mode,
      excludePathwayModes: mode === "wheelchair" ? [2] : [],
      preferPathwayModes: mode === "wheelchair" ? [5] : [],
    });

    const bestPathFrom = (entranceId: string): IndoorPath | null => {
      let best: IndoorPath | null = null;
      for (const plat of platforms) {
        const path = dijkstraPath(adj, entranceId, plat.stopId);
        if (path && (!best || path.totalSeconds < best.totalSeconds)) best = path;
      }
      return best;
    };

    // Prefer the entrance nearest the user that has a step-free path to a
    // platform; if none is step-free, keep the nearest entrance overall.
    const entrancesByDistance = [...entrances].sort(
      (a, b) =>
        haversineCoords(userCoords, a.location.coordinates as [number, number]) -
        haversineCoords(userCoords, b.location.coordinates as [number, number])
    );

    let chosen: IGtfsStop | null = null;
    let chosenPath: IndoorPath | null = null;
    for (const e of entrancesByDistance) {
      const path = bestPathFrom(e.stopId);
      if (path) {
        chosen = e;
        chosenPath = path;
        break;
      }
    }

    if (chosen && chosenPath) {
      base.entrance = toEntrance(chosen);
      base.stepFree = true;
      base.usesElevator = chosenPath.usesElevator;

      if (chosenPath.usesElevator) {
        // First elevator landing's level name, for the frontend guidance string.
        const elevStep = chosenPath.steps.find((s) => s.viaMode === 5);
        if (elevStep) {
          const node = await GtfsStop.findOne({ stopId: elevStep.stopId })
            .select("levelId")
            .lean<{ levelId?: string }>();
          if (node?.levelId) {
            const lvl = await GtfsLevel.findOne({ levelId: node.levelId })
              .select("levelName")
              .lean<{ levelName?: string }>();
            if (lvl?.levelName) base.elevatorLevelName = lvl.levelName;
          }
        }
      }
    } else {
      // Entrances exist and platforms exist, but no permitted path for this mode.
      base.stepFree = false;
    }

    return base;
  } catch (err) {
    console.warn("[indoor-graph] getStationAccess failed:", err);
    return null;
  }
}
