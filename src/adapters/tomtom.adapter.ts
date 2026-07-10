import axios from "axios";
import {
  TOMTOM_LANGUAGE,
  TOMTOM_ROUTING_BASE_URL,
  TOMTOM_TIMEOUT_MS,
} from "../config/tomtom";

const TOMTOM_KEY = () => process.env.TOMTOM_API_KEY ?? "";

export type TomTomTravelMode = "car" | "motorcycle" | "pedestrian";

export interface TomTomPoint {
  latitude: number;
  longitude: number;
}

export interface TomTomSummary {
  lengthInMeters?: number;
  travelTimeInSeconds?: number;
  noTrafficTravelTimeInSeconds?: number;
  trafficDelayInSeconds?: number;
}

export interface TomTomLeg {
  summary?: TomTomSummary;
  points?: TomTomPoint[];
}

export interface TomTomSection {
  startPointIndex?: number;
  endPointIndex?: number;
  sectionType?: string;
  travelMode?: string;
}

export interface TomTomInstruction {
  routeOffsetInMeters?: number;
  travelTimeInSeconds?: number;
  point?: TomTomPoint;
  pointIndex?: number;
  maneuver?: string;
  message?: string;
}

export interface TomTomRoute {
  summary?: TomTomSummary;
  legs?: TomTomLeg[];
  sections?: TomTomSection[];
  guidance?: { instructions?: TomTomInstruction[] };
}

export interface ComputeTomTomRoutesParams {
  origin: { lat: number; lng: number };
  destination: { lat: number; lng: number };
  waypoints?: { lat: number; lng: number }[];
  travelMode: TomTomTravelMode;
  departureTime?: string;
  trafficAware?: boolean;
  computeAlternatives?: boolean;
}

export type ComputeTomTomRoutesStatus =
  | "OK"
  | "NO_ROUTE"
  | "UNSUPPORTED_MODE"
  | "UPSTREAM_ERROR";

export interface ComputeTomTomRoutesResult {
  status: ComputeTomTomRoutesStatus;
  routes: TomTomRoute[];
  httpStatus?: number;
  errorCode?: string;
}

const WAYPOINT_LIMIT = 5;
const NO_ROUTE_CODES = new Set(["NO_ROUTE_FOUND", "MAP_MATCHING_FAILURE"]);

/**
 * True when a route contains any TRAVEL_MODE section the requested mode could
 * not honour (TomTom flags such stretches with `travelMode: "other"`), i.e. the
 * beta motorcycle map data has a coverage gap on this route.
 *
 * @param route A single TomTom route with its sections.
 * @returns Whether the route degrades to an unsupported travel mode.
 */
function hasUnsupportedSection(route: TomTomRoute): boolean {
  return (route.sections ?? []).some(
    (s) => s.sectionType === "TRAVEL_MODE" && s.travelMode === "other",
  );
}

/**
 * Compute driving / motorcycle / walking routes via the TomTom Routing API
 * (calculateRoute). `traffic` + `departAt` yield traffic-aware durations for
 * motorized modes; waypoints add ordered intermediate stops. Never throws —
 * upstream failures and coverage gaps are reported via `status`.
 *
 * @param p Route request (coords in {lat,lng}, RFC3339 departureTime).
 * @returns The matched routes plus a status; routes[] is empty unless OK.
 */
export async function computeTomTomRoutes(
  p: ComputeTomTomRoutesParams,
): Promise<ComputeTomTomRoutesResult> {
  const key = TOMTOM_KEY();
  if (!key) return { status: "UPSTREAM_ERROR", routes: [] };

  const motorized = p.travelMode !== "pedestrian";
  const coords = [
    p.origin,
    ...(p.waypoints ?? []).slice(0, WAYPOINT_LIMIT),
    p.destination,
  ];
  const locations = coords.map((c) => `${c.lat},${c.lng}`).join(":");

  const params: Record<string, string | number | boolean> = {
    key,
    travelMode: p.travelMode,
    computeTravelTimeFor: "all",
    instructionsType: "text",
    language: TOMTOM_LANGUAGE,
    sectionType: "travelMode",
    routeRepresentation: "polyline",
  };
  if (motorized && p.trafficAware) params.traffic = true;
  if (motorized && p.departureTime) params.departAt = p.departureTime;
  if (p.computeAlternatives && !p.waypoints?.length) params.maxAlternatives = 2;

  try {
    const response = await axios.get(
      `${TOMTOM_ROUTING_BASE_URL}/${locations}/json`,
      { params, signal: AbortSignal.timeout(TOMTOM_TIMEOUT_MS) },
    );
    const routes = (response.data?.routes ?? []) as TomTomRoute[];
    if (!routes.length) return { status: "NO_ROUTE", routes: [] };

    if (p.travelMode === "motorcycle") {
      const supported = routes.filter((r) => !hasUnsupportedSection(r));
      if (!supported.length) return { status: "UNSUPPORTED_MODE", routes: [] };
      return { status: "OK", routes: supported };
    }
    return { status: "OK", routes };
  } catch (err) {
    const httpStatus = axios.isAxiosError(err)
      ? err.response?.status
      : undefined;
    const detailed = axios.isAxiosError(err)
      ? (err.response?.data?.detailedError as
          | { code?: string; message?: string }
          | undefined)
      : undefined;
    const errorCode = detailed?.code;

    if (httpStatus && httpStatus >= 400 && httpStatus < 500) {
      if (errorCode && NO_ROUTE_CODES.has(errorCode)) {
        return { status: "NO_ROUTE", routes: [], httpStatus, errorCode };
      }
      if (
        httpStatus === 400 &&
        p.travelMode === "motorcycle" &&
        (detailed?.message ?? "").toLowerCase().includes("travelmode")
      ) {
        return {
          status: "UNSUPPORTED_MODE",
          routes: [],
          httpStatus,
          errorCode,
        };
      }
    }
    if (errorCode) {
      console.error("[tomtom] routing upstream error", errorCode);
    }
    return { status: "UPSTREAM_ERROR", routes: [], httpStatus, errorCode };
  }
}
