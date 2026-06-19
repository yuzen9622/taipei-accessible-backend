/**
 * Type declarations for the ORS walking-route planner.
 */

export interface WalkingRoute {
  polyline: [number, number][];
  distanceM: number;
  durationSec: number;
}
