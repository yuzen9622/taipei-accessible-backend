/**
 * accessible-route module type declarations — the shapes used across the
 * module's own files (the orchestrator service, scoring engine, OTP planner
 * and response slimming). Planner-specific types live beside each planner in
 * planners/<planner>.types.ts; cross-module contracts live in src/types.
 */

import type { ResponseCode } from "../../types/code";
import type {
  AccessibilityMode,
  AccessibleRoute,
  TravelMode,
  WalkLeg,
  BusLeg,
  MetroLeg,
  ThsrLeg,
  TraLeg,
  DriveLeg,
} from "../../types/route";
import type { RouteIntent } from "../../types/ai";
import type { TaiwanCityEn } from "../../types/transit";

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

export type LatLng = { lat: number; lng: number };

/** Transport modes served by the Valhalla road-routing path (not OTP transit). */
export type RoadTravelMode = Exclude<TravelMode, "transit">;

export interface FindAccessibleRoutesOptions {
  mode?: AccessibilityMode;
  maxTransfers?: 0 | 1 | 2;
  departureTime?: Date;
  format?: "standard" | "compact";
  waypoints?: LatLng[];
}

export interface PlanRoadRouteOptions {
  travelMode: RoadTravelMode;
  waypoints?: LatLng[];
  departureTime?: Date;
}

export interface FindDrivingRoutesOptions {
  travelMode: RoadTravelMode;
  waypoints?: LatLng[];
  departureTime?: Date;
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
  travelMode?: TravelMode;
  waypoints?: (string | { latitude: number; longitude: number })[];
}

export type PlanRouteResult =
  | {
      ok: true;
      data: {
        origin: { lat: number; lng: number };
        destination: { lat: number; lng: number };
        city: TaiwanCityEn;
        travelMode: TravelMode;
        waypoints?: LatLng[];
        routes: AccessibleRoute[];
        intent?: RouteIntent;
      };
    }
  | { ok: false; status: ResponseCode; error: string };

export type AnyLeg = WalkLeg | BusLeg | MetroLeg | ThsrLeg | TraLeg | DriveLeg;
