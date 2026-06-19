/**
 * accessible-route module type declarations — the shapes used across the
 * module's own files (the orchestrator service, scoring engine, transfer finder
 * and response slimming). Planner-specific types live beside each planner in
 * planners/<planner>.types.ts; cross-module contracts live in src/types.
 */

import type { ResponseCode } from "../../types/code";
import type {
  AccessibilityMode,
  AccessibleRoute,
  WalkLeg,
  BusLeg,
  MetroLeg,
  ThsrLeg,
  TraLeg,
} from "../../types/route";
import type { RouteIntent } from "../../types/ai";
import type { TaiwanCityEn } from "../../types/transit";
import type { ITdxBusStop, ITdxMetroStation } from "../../types";
import type { ReachableStop } from "./planners/reachable-stops.types";

export type TagWeightMap = Record<string, Record<string, number>>;

export type ScoreLabel = "excellent" | "good" | "fair" | "poor" | "critical";

export interface ModeProfile {
  a11yWeight: number;
  timeWeight: number;
  transferPenaltyMultiplier: number;
  tier1Required: boolean;
  criticalWeights: {
    elevator: number;
    flushKerb: number;
    ramp: number;
    wheelchairYes: number;
    accessibleToilet: number;
    audioSignal: number;
    tactilePaving: number;
  };
}

export type DataConfidence = "high" | "medium" | "low";

export interface RouteAccessibilityScore {
  totalScore: number;
  label: ScoreLabel;
  dataConfidence: DataConfidence;
  warnings: string[];
  components: {
    facilityScore: number;
    timeScore: number;
    criticalFeatureScore: number;
    walkPenalty: number;
  };
}

export interface FindAccessibleRoutesOptions {
  mode?: AccessibilityMode;
  maxTransfers?: 0 | 1 | 2;
  departureTime?: Date;
  format?: "standard" | "compact";
}

export interface PlanRouteRequest {
  origin?: unknown;
  destination?: unknown;
  query?: string;
  userLocation?: { latitude: number; longitude: number };
  maxTransfers?: number;
  departureTime?: string;
  format?: string;
  mode?: RouteIntent["mode"];
}

export type PlanRouteResult =
  | {
      ok: true;
      data: {
        origin: { lat: number; lng: number };
        destination: { lat: number; lng: number };
        city: TaiwanCityEn;
        routes: AccessibleRoute[];
        intent?: RouteIntent;
      };
    }
  | { ok: false; status: ResponseCode; error: string };

export interface IntermediateStop {
  name: string;
  coords: [number, number];
  stopIdx: number;
  direction: number;
}

export interface BoardableRoute {
  kind: "BUS" | "METRO";
  routeId: string;
  railSystem?: string;
  city: string;
  originStop: ReachableStop;
  boardName: string;
  boardCoords: [number, number];
  stopSequence: IntermediateStop[];
}

export interface ServiceableRoute {
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

export interface TransferCombo {
  originStop: ReachableStop;
  firstLeg: BoardableRoute;
  midCoords: [number, number];
  midName: string;
  midStop: IntermediateStop;
  destStop: ReachableStop;
  lastLeg: ServiceableRoute;
  transferWalkSec: number;
}

export type AnyLeg = WalkLeg | BusLeg | MetroLeg | ThsrLeg | TraLeg;
