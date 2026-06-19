/**
 * Type declarations for the reachable-stops planner (reachable-stops.ts).
 */

import type { ITdxBusStop, ITdxMetroStation } from "../../../types";

export interface ReachableStop {
  kind: "bus" | "metro";
  doc: ITdxBusStop | ITdxMetroStation;
  coords: [number, number];
  walkMinutes: number;
}

export type RawStop =
  | { kind: "bus"; doc: ITdxBusStop; coords: [number, number] }
  | { kind: "metro"; doc: ITdxMetroStation; coords: [number, number] };
