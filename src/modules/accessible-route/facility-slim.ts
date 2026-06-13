/**
 * Phase 14 — response payload slimming for OSM a11y facilities.
 *
 * Problem: every leg's facility arrays embed the FULL OsmA11y document — up to
 * ~50 `tags` fields (addr:*, network:*, contact:*, multilingual names…), ~2KB
 * per facility, and the same facility repeats across adjacent transit/walk
 * legs. 3 routes × 100+ facilities → 200KB+ responses.
 *
 * Stage A (`slimRoutes`) — always on: project each facility down to the fields
 * the frontend and the re-scoring endpoints (/route-rank, /route-select)
 * actually consume. The tag whitelist is EXACTLY the keys read by
 * src/config/a11y-scoring.ts (so slimmed routes re-score identically) plus a
 * few display keys. Full documents stay available via GET /api/a11y/place.
 *
 * Stage B (`compactRoutes`) — opt-in via body `format: "compact"`: dedupe
 * facilities into a route-level `facilities` dictionary keyed by osmId; legs
 * keep empty arrays plus `a11yRefs` (osmId references).
 */

import type { IOsmA11y } from "../../types";
import type {
  AccessibleRoute,
  WalkLeg,
  BusLeg,
  MetroLeg,
  ThsrLeg,
  TraLeg,
  SlimA11y,
} from "../../types/route";

// SlimA11y now lives in the neutral types layer; re-exported here so existing
// importers of this module continue to resolve it.
export type { SlimA11y } from "../../types/route";

/**
 * Tags that survive slimming.
 * Scoring keys: every key read by a11y-scoring.ts (ALL_TAG_WEIGHTS tiers 1–4
 * plus the numeric width/incline helpers) — keeps /route-rank & /route-select
 * re-scoring of slimmed payloads identical to first-pass scoring.
 * Display keys: name / opening_hours / level / amenity for frontend rendering.
 */
const A11Y_TAG_WHITELIST = new Set<string>([
  // Tier 1
  "wheelchair",
  "elevator",
  "highway",
  "ramp:wheelchair",
  "ramp",
  "kerb",
  // Tier 2 + numeric helpers
  "smoothness",
  "surface",
  "width",
  "incline",
  // Tier 3
  "toilets:wheelchair",
  "traffic_signals:sound",
  "traffic_signals:vibration",
  "tactile_paving",
  "crossing",
  "pedestrian arcade:wheelchair",
  // Tier 4
  "shelter",
  "bench",
  "automatic_door",
  "door",
  "lit",
  "capacity:disabled",
  // Display
  "name",
  "opening_hours",
  "level",
  "amenity",
]);

/** Project one facility document down to the slim response shape. */
export function slimFacility(f: IOsmA11y): SlimA11y {
  const slim: SlimA11y = {
    osmId: f.osmId,
    category: f.category,
    location: f.location,
  };
  if (f.name) slim.name = f.name;
  if (f.wheelchair) slim.wheelchair = f.wheelchair;
  const src = f.tags ?? {};
  let tags: Record<string, string> | undefined;
  for (const key of Object.keys(src)) {
    if (!A11Y_TAG_WHITELIST.has(key)) continue;
    (tags ??= {})[key] = src[key];
  }
  if (tags) slim.tags = tags;
  return slim;
}

type AnyLeg = WalkLeg | BusLeg | MetroLeg | ThsrLeg | TraLeg;

/**
 * The facility arrays a leg carries, by leg type. The leg interfaces type
 * them as IOsmA11y[]; after slimming they hold SlimA11y objects (a structural
 * subset — every SlimA11y field exists on IOsmA11y with the same type), so the
 * in-place replacement below casts once and stays contained to this module.
 */
function facilityArrayKeys(leg: AnyLeg): string[] {
  switch (leg.type) {
    case "WALK":
      return ["a11yFacilities"];
    case "BUS":
      return ["departureStopA11y", "arrivalStopA11y"];
    default:
      return ["departureStationA11y", "arrivalStationA11y"];
  }
}

/** Stage A: replace every facility array's documents with slim projections. */
export function slimRoutes(routes: AccessibleRoute[]): void {
  for (const route of routes) {
    for (const leg of route.legs) {
      const bag = leg as unknown as Record<string, unknown>;
      for (const key of facilityArrayKeys(leg)) {
        const arr = bag[key];
        if (Array.isArray(arr)) bag[key] = arr.map(slimFacility);
      }
    }
  }
}

/**
 * Stage B: per route, move (already slim) facilities into a route-level
 * dictionary keyed by osmId; each leg keeps an empty array plus `a11yRefs`.
 * Run AFTER slimRoutes.
 */
export function compactRoutes(routes: AccessibleRoute[]): void {
  for (const route of routes) {
    const facilities: Record<string, SlimA11y> = {};
    for (const leg of route.legs) {
      const bag = leg as unknown as Record<string, unknown>;
      const refs = new Set<string>();
      for (const key of facilityArrayKeys(leg)) {
        const arr = bag[key];
        if (!Array.isArray(arr)) continue;
        for (const f of arr as SlimA11y[]) {
          facilities[f.osmId] ??= f;
          refs.add(f.osmId);
        }
        bag[key] = [];
      }
      if (refs.size) bag.a11yRefs = [...refs];
    }
    route.facilities = facilities;
  }
}
