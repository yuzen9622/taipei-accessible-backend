/**
 * Phase 5 — FR-07: A11y station exit navigation.
 *
 * Resolves the nearest catalogued accessible exit (elevator / ramp) at a TRTC
 * metro station from the `Accessibility` collection, and builds an arrival
 * WalkLeg that routes the user to that exit instead of the station centroid.
 *
 * Data coverage: the A11y exit dataset covers ONLY TRTC. The collection has no
 * explicit `type` or `exitNumber` field — both are parsed at runtime from the
 * "出入口電梯/無障礙坡道名稱" name string (see VERIFIED FACTS / SPEC §3c).
 *
 * All coordinates are [lng, lat] (GeoJSON order); no conversion is performed.
 */

import A11y from "../model/a11y.model";
import { IA11y } from "../types";
import { orsWalkingRoute, haversineCoords } from "./ors.service";
import type { WalkLeg } from "../types/route";
import { getStationAccess } from "./indoor-graph.service";

/** Raw lean()'d A11y document — the stored DB shape, before parsing. */
type RawA11yDoc = IA11y;

/** A parsed, derived accessible exit. */
export interface A11yExit {
  /** Full raw value of "出入口電梯/無障礙坡道名稱". */
  exitName: string;
  /** Best-effort extracted exit identifier, or "" when not parseable. */
  exitNumber: string;
  type: "elevator" | "ramp";
  /** [lng, lat] from location.coordinates. */
  coords: [number, number];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Look up all catalogued accessible exits (elevator / ramp) for a station by
 * name prefix. `stationName` is the MetroStationModel Zh_tw value (no trailing
 * "站"); A11y name strings start with "{name}站".
 *
 * Returns only exits whose type could be determined; never throws.
 */
export async function findAccessibleExits(
  stationName: string
): Promise<A11yExit[]> {
  try {
    const stripped = stationName.replace(/站$/, "");
    const nameRegex = new RegExp("^" + escapeRegExp(stripped) + "站");

    const docs = await A11y.find({
      "出入口電梯/無障礙坡道名稱": nameRegex,
    }).lean<RawA11yDoc[]>();

    const out: A11yExit[] = [];
    for (const doc of docs) {
      const name = doc["出入口電梯/無障礙坡道名稱"];
      const type: "elevator" | "ramp" | null = name.includes("電梯")
        ? "elevator"
        : name.includes("坡道")
          ? "ramp"
          : null;
      if (!type) continue; // skip docs that are neither elevator nor ramp

      const m = name.match(/出口?\s*(\d+|電梯\d*|單一出口)/);
      const exitNumber = m ? m[1] : "";

      out.push({
        exitName: name,
        exitNumber,
        type,
        coords: doc.location.coordinates as [number, number],
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Pick the exit closest to `userCoords` by Haversine distance.
 * Precondition: `exits.length >= 1`.
 */
export function selectNearestExit(
  userCoords: [number, number],
  exits: A11yExit[]
): A11yExit {
  let best = exits[0];
  let bestDist = haversineCoords(userCoords, best.coords);
  for (let i = 1; i < exits.length; i++) {
    const d = haversineCoords(userCoords, exits[i].coords);
    if (d < bestDist) {
      bestDist = d;
      best = exits[i];
    }
  }
  return best;
}

/**
 * Build the arrival WalkLeg into a transit station.
 *
 * For TRTC stations with catalogued exit data, routes the walk to the nearest
 * accessible exit and attaches `exitInfo`. Otherwise (no exit data, or a
 * non-TRTC system), routes to the station centroid with `exitInfo: null`.
 *
 * Never throws: any error degrades to a station-centroid walk with
 * `exitInfo: null`. The OSM facility lookup is NOT this function's
 * responsibility — `a11yFacilities` is returned empty for the caller to merge.
 */
export async function buildExitWalkLeg(
  userCoords: [number, number],
  station: { name: string; coords: [number, number]; railSystem: string },
  from = "出發地"
): Promise<WalkLeg> {
  try {
    // Phase 8 (spec §10.5): the GTFS pathways indoor graph is the primary,
    // system-agnostic source. It covers every system with indoor data, so it is
    // tried first regardless of operator. The TRTC-only A11y collection below
    // remains as a fallback when the feed carries no pathways for the station.
    if (process.env.USE_INDOOR_GRAPH !== "false") {
      const access = await getStationAccess(
        { name: station.name, coords: station.coords },
        userCoords,
        "wheelchair"
      );
      if (access?.entrance && access.stepFree) {
        const walk = await orsWalkingRoute(userCoords, access.entrance.coords);
        return {
          type: "WALK",
          from,
          to: station.name,
          distanceM: Math.round(walk.distanceM),
          minutesEst: Math.round(walk.durationSec / 60),
          polyline: walk.polyline,
          a11yFacilities: [],
          exitInfo: {
            exitName: access.entrance.name,
            exitNumber: access.entrance.exitNumber,
            type: access.usesElevator ? "elevator" : "ramp",
            coords: access.entrance.coords,
          },
        };
      }
    }

    if (station.railSystem === "TRTC") {
      const exits = await findAccessibleExits(station.name);
      if (exits.length > 0) {
        const nearest = selectNearestExit(userCoords, exits);
        const walk = await orsWalkingRoute(userCoords, nearest.coords);
        return {
          type: "WALK",
          from,
          to: station.name,
          distanceM: Math.round(walk.distanceM),
          minutesEst: Math.round(walk.durationSec / 60),
          polyline: walk.polyline,
          a11yFacilities: [],
          exitInfo: {
            exitName: nearest.exitName,
            exitNumber: nearest.exitNumber,
            type: nearest.type,
            coords: nearest.coords,
          },
        };
      }
      // TRTC but no catalogued exit — degrade to station centroid.
      const walk = await orsWalkingRoute(userCoords, station.coords);
      return {
        type: "WALK",
        from,
        to: station.name,
        distanceM: Math.round(walk.distanceM),
        minutesEst: Math.round(walk.durationSec / 60),
        polyline: walk.polyline,
        a11yFacilities: [],
        exitInfo: null,
      };
    }

    // Non-TRTC (TRA / THSR / bus / other) — no exit lookup.
    const walk = await orsWalkingRoute(userCoords, station.coords);
    return {
      type: "WALK",
      from,
      to: station.name,
      distanceM: Math.round(walk.distanceM),
      minutesEst: Math.round(walk.durationSec / 60),
      polyline: walk.polyline,
      a11yFacilities: [],
      exitInfo: null,
    };
  } catch (err) {
    console.warn("buildExitWalkLeg failed — degrading to station centroid:", err);
    const walk = await orsWalkingRoute(userCoords, station.coords);
    return {
      type: "WALK",
      from,
      to: station.name,
      distanceM: Math.round(walk.distanceM),
      minutesEst: Math.round(walk.durationSec / 60),
      polyline: walk.polyline,
      a11yFacilities: [],
      exitInfo: null,
    };
  }
}
