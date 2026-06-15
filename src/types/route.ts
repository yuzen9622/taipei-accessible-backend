/**
 * Route / leg domain model — the shared shape of a planned accessible route.
 *
 * Lives in the neutral types layer (not in the orchestrator) so that every
 * planner in src/service/* and the orchestrator in
 * modules/accessible-route/accessible-route.service.ts can depend on these
 * types DOWNWARD, with no upward import and no runtime circular dependency.
 */

import type { IOsmA11y } from "./index";

/** Slimmed facility shape returned by /accessible-route (Phase 14). */
export interface SlimA11y {
  osmId: string;
  category: IOsmA11y["category"];
  name?: string;
  wheelchair?: IOsmA11y["wheelchair"];
  location: IOsmA11y["location"];
  /** Whitelisted tags only; omitted entirely when none survive. */
  tags?: Record<string, string>;
}

export interface WaitInfo {
  /**
   * "realtime" → number: minutes until the vehicle reaches the board stop
   *   (TDX live ETA).
   * "schedule" → string "HH:mm": the timetable departure clock time. A number
   *   appears only for headway-only services with no timetable clock (metro:
   *   expected wait = headway / 2, from the TDX headway API — not hardcoded).
   * "unavailable" → null (last bus gone / no service today).
   */
  time: number | string | null;
  source: "realtime" | "schedule" | "unavailable";
}

export interface NearestBus {
  plateNumb: string;
  position: [number, number];
  speed?: number;
  stopsAway?: number;
}

export interface WalkLeg {
  type: "WALK";
  /** Phase 14 compact format only: osmId refs into route-level `facilities`. */
  a11yRefs?: string[];
  from: string;
  to: string;
  distanceM: number;
  minutesEst: number;
  polyline: [number, number][]; // [[lng, lat], ...] GeoJSON order
  a11yFacilities: IOsmA11y[];
  /**
   * Set only on transfer routes when the walk leg ends/starts at a TRTC metro
   * station with A11y exit data. Non-breaking optional field; null otherwise.
   */
  exitInfo?: {
    exitName: string;
    exitNumber: string;
    type: "elevator" | "ramp";
    coords: [number, number];
  } | null;
}

export interface BusLeg {
  type: "BUS";
  /** Phase 14 compact format only: osmId refs into route-level `facilities`. */
  a11yRefs?: string[];
  routeName: string;
  departureStop: string;
  arrivalStop: string;
  /**
   * System-prefixed GTFS stop ids（"TXG2646" 城市公車、"THB…" 公路客運）。
   * Set by the GTFS router only; Phase 15 realtime ETA overlay keys the TDX
   * city/intercity endpoint choice off the leading letters.
   */
  departureStopId?: string;
  arrivalStopId?: string;
  /**
   * TDX operator system code（"NWT"、"TXG"、"THB" 公路客運…）。Set by the TDX
   * MaaS path (from agency_id), where stop ids are unavailable — the Phase 15
   * overlay's fallback for picking the realtime ETA endpoint.
   */
  cityCode?: string;
  /** "HH:mm" scheduled next departure, when the source timetable provides it. */
  departureTime?: string;
  /** "HH:mm" scheduled arrival, when the source timetable provides it. */
  arrivalTime?: string;
  waitInfo: WaitInfo;
  estimatedWaitMinutes: number; // numeric wait estimate, kept for backwards compat
  direction: 0 | 1;
  polyline: [number, number][];
  departureStopA11y: IOsmA11y[];
  arrivalStopA11y: IOsmA11y[];
  nearestBus?: NearestBus;
}

export interface MetroLeg {
  type: "METRO";
  /** Phase 14 compact format only: osmId refs into route-level `facilities`. */
  a11yRefs?: string[];
  railSystem: string;
  /** Bare line code for the frontend to colour/label the line: 紅線 "R", 藍線 "BL", 綠線 "G", … */
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
  /** "HH:mm" scheduled next departure, when the source timetable provides it. */
  departureTime?: string;
  /** "HH:mm" scheduled arrival, when the source timetable provides it. */
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
  /** Phase 14 compact format only: osmId refs into route-level `facilities`. */
  a11yRefs?: string[];
  trainNo: string;
  departureStation: string;
  arrivalStation: string;
  departureStationUID: string;
  arrivalStationUID: string;
  departureTime: string; // "HH:mm"
  arrivalTime: string; // "HH:mm"
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
  /** Phase 14 compact format only: osmId refs into route-level `facilities`. */
  a11yRefs?: string[];
  trainNo: string;
  trainTypeName: string; // e.g. "自強", "莒光", "區間車"
  departureStation: string;
  arrivalStation: string;
  departureStationUID: string;
  arrivalStationUID: string;
  departureTime: string; // "HH:mm"
  arrivalTime: string; // "HH:mm"
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
  /** 0 = direct, 1 = one transfer, 2 = two transfers (Phase 12) */
  transferCount: number;
  legs: (WalkLeg | BusLeg | MetroLeg | ThsrLeg | TraLeg)[];
  accessibilityHighlights: string[];
  /**
   * Service date of the route as "YYYY-MM-DD", set only when today's services
   * are exhausted and the router rolled forward to the next service day.
   * Undefined means the route departs today.
   */
  departureDate?: string;
  /**
   * Phase 14 compact format only: deduped facility dictionary keyed by osmId.
   * Legs then carry `a11yRefs` (osmId references) and empty facility arrays.
   */
  facilities?: Record<string, SlimA11y>;
  /** 0–100 evidence-based accessibility score. Set by scoreAndRank(). */
  accessibilityScore?: number;
  /** Semantic label for the score. Set by scoreAndRank(). */
  accessibilityLabel?: "excellent" | "good" | "fair" | "poor" | "critical";
  /** Score sub-components for debugging. Set by scoreAndRank(). */
  scoreComponents?: {
    facilityScore: number;
    timeScore: number;
    criticalFeatureScore: number;
  };
}
