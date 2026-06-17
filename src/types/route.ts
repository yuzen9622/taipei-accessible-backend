/**
 * Route / leg domain model — the shared shape of a planned accessible route.
 *
 * Lives in the neutral types layer (not in the orchestrator) so that every
 * planner in src/service/* and the orchestrator in
 * modules/accessible-route/accessible-route.service.ts can depend on these
 * types DOWNWARD, with no upward import and no runtime circular dependency.
 */

import type { IOsmA11y } from "./index";

export interface SlimA11y {
  osmId: string;
  category: IOsmA11y["category"];
  name?: string;
  wheelchair?: IOsmA11y["wheelchair"];
  location: IOsmA11y["location"];
  tags?: Record<string, string>;
}

export interface WaitInfo {
  time: number | string | null;
  source: "realtime" | "schedule" | "unavailable";
}

export interface WalkStep {
  relativeDirection: string;
  absoluteDirection: string | null;
  streetName: string;
  bogusName: boolean;
  area: boolean;
  distanceM: number;
  location: [number, number];
}

export interface WalkLeg {
  type: "WALK";
  a11yRefs?: string[];
  from: string;
  to: string;
  distanceM: number;
  minutesEst: number;
  polyline: [number, number][];
  a11yFacilities: IOsmA11y[];
  exitInfo?: {
    exitName: string;
    exitNumber: string;
    type: "elevator" | "ramp";
    coords: [number, number];
  } | null;
  steps?: WalkStep[];
}

export interface BusLeg {
  type: "BUS";
  a11yRefs?: string[];
  routeName: string;
  departureStop: string;
  arrivalStop: string;
  departureStopId?: string;
  arrivalStopId?: string;
  cityCode?: string;
  departureTime?: string;
  arrivalTime?: string;
  waitInfo: WaitInfo;
  estimatedWaitMinutes: number;
  direction: 0 | 1;
  polyline: [number, number][];
  departureStopA11y: IOsmA11y[];
  arrivalStopA11y: IOsmA11y[];
  tdxCity?: string;
}

export interface MetroLeg {
  type: "METRO";
  a11yRefs?: string[];
  railSystem: string;
  lineId: string;
  lineName: string;
  lineUid: string;
  departureStation: string;
  arrivalStation: string;
  departureStationUid: string;
  arrivalStationUid: string;
  direction: 0 | 1;
  stopsCount: number;
  rideMinutes: number;
  departureTime?: string;
  arrivalTime?: string;
  waitInfo: WaitInfo;
  estimatedWaitMinutes: number;
  polyline: [number, number][];
  departureStationA11y: IOsmA11y[];
  arrivalStationA11y: IOsmA11y[];
  facilityHighlights: string[];
}

export interface ThsrLeg {
  type: "THSR";
  a11yRefs?: string[];
  trainNo: string;
  departureStation: string;
  arrivalStation: string;
  departureStationUID: string;
  arrivalStationUID: string;
  departureTime: string;
  arrivalTime: string;
  rideMinutes: number;
  waitInfo: WaitInfo;
  estimatedWaitMinutes: number;
  polyline: [number, number][];
  departureStationA11y: IOsmA11y[];
  arrivalStationA11y: IOsmA11y[];
  facilityHighlights: string[];
}

export interface TraLeg {
  type: "TRA";
  a11yRefs?: string[];
  trainNo: string;
  trainTypeName: string;
  departureStation: string;
  arrivalStation: string;
  departureStationUID: string;
  arrivalStationUID: string;
  departureTime: string;
  arrivalTime: string;
  rideMinutes: number;
  waitInfo: WaitInfo;
  estimatedWaitMinutes: number;
  polyline: [number, number][];
  departureStationA11y: IOsmA11y[];
  arrivalStationA11y: IOsmA11y[];
  facilityHighlights: string[];
}

export interface AccessibleRoute {
  routeId: string;
  routeName: string;
  totalMinutes: number;
  transferCount: number;
  legs: (WalkLeg | BusLeg | MetroLeg | ThsrLeg | TraLeg)[];
  accessibilityHighlights: string[];
  departureDate?: string;
  facilities?: Record<string, SlimA11y>;
  accessibilityScore?: number;
  accessibilityLabel?: "excellent" | "good" | "fair" | "poor" | "critical";
  dataConfidence?: "high" | "medium" | "low";
  scoreWarnings?: string[];
  totalWalkDistanceM?: number;
  scoreComponents?: {
    facilityScore: number;
    timeScore: number;
    criticalFeatureScore: number;
    walkPenalty: number;
  };
}
