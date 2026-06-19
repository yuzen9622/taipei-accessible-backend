/**
 * Route accessibility enrichment.
 *
 * Shared, planner-agnostic helpers that decorate a finished AccessibleRoute leg
 * with accessibility context. Used by every active planner path (OTP and TDX
 * MaaS) via the accessible-route orchestrator; the former in-Mongo GTFS planner
 * also used these before it was retired.
 *
 *   - nearbyA11y       : OSM accessibility facilities around a stop coordinate
 *   - deriveHighlights : route-level a11y highlight strings from board/alight sets
 *   - attachA11yToLeg  : attach board/alight a11y arrays to a transit leg
 *   - enrichLegIndoor  : Indoor Graph step-free exit/elevator guidance
 *
 * Leg/route types are imported as TYPES only so this service has no runtime
 * dependency on the accessible-route module.
 */

import OsmA11y from "../../../model/osm-a11y.model";
import { getStationAccess } from "./indoor-graph";
import type { IOsmA11y } from "../../../types";
import type {
  AccessibilityMode,
  WalkLeg,
  BusLeg,
  MetroLeg,
  ThsrLeg,
  TraLeg,
} from "../../../types/route";
import type {
  RailLeg,
} from "./route-a11y.types";
export type {
  RailLeg,
};

const A11Y_RADIUS_M = 200;
const A11Y_LIMIT = 5;

/**
 * Nearby OSM accessibility facilities around a stop coordinate.
 *
 * @param coords The stop's [lng, lat] coordinates.
 * @returns The nearby OSM accessibility facilities.
 */
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

/**
 * Derive route-level accessibility highlights (same rules as the TDX path).
 *
 * @param boardA11y Accessibility facilities at the boarding stop.
 * @param alightA11y Accessibility facilities at the alighting stop.
 * @returns The derived highlight strings.
 */
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

/**
 * Attach board/alight a11y arrays to a transit leg (field name varies by type).
 *
 * @param leg The transit leg to annotate.
 * @param boardA11y Accessibility facilities at the boarding stop.
 * @param alightA11y Accessibility facilities at the alighting stop.
 */
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

/**
 * Enrich a rail leg + its adjacent walk legs with indoor-graph guidance:
 *  • the in-station walk to the boarding station gets `exitInfo` (nearest
 *    step-free entrance + elevator info), and likewise the walk OUT of the
 *    alighting station;
 *  • the rail leg's `facilityHighlights` gains step-free / elevator notes.
 *
 * Best-effort and non-throwing: stations without indoor data are left untouched.
 * Gated by env so the extra DB work can be disabled (USE_INDOOR_GRAPH=false).
 *
 * @param leg The rail leg to enrich.
 * @param walkIn The walk leg into the boarding station, or null.
 * @param walkOut The walk leg out of the alighting station, or null.
 * @param originCoords The user's [lng, lat] origin.
 * @param destCoords The user's [lng, lat] destination.
 * @param boardCoords The boarding station's [lng, lat] coordinates.
 * @param alightCoords The alighting station's [lng, lat] coordinates.
 * @param mode The accessibility mode for traversal constraints.
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
