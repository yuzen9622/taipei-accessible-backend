/**
 * Type declarations for the indoor graph planner (indoor-graph.ts).
 */

import type { AccessibilityMode } from "../../../types/route";

export interface IndoorStation {
  stationId: string;
  stopName: string;
  coords: [number, number];
}

export interface Edge {
  to: string;
  mode: number;
  cost: number;
}

export interface IndoorPathStep {
  stopId: string;
  viaMode?: number;
}

export interface IndoorPath {
  steps: IndoorPathStep[];
  totalSeconds: number;
  usesElevator: boolean;
  usesStairs: boolean;
}

export interface FindIndoorPathOptions {
  excludePathwayModes?: number[];
  preferPathwayModes?: number[];
  mode?: AccessibilityMode;
  allowedNodeIds?: Set<string>;
}

export interface StationAccess {
  stationId: string;
  stationName: string;
  entrance: {
    stopId: string;
    name: string;
    exitNumber: string;
    coords: [number, number];
  } | null;
  hasElevator: boolean;
  stepFree: boolean | null;
  usesElevator: boolean;
  elevatorLevelName?: string;
}
