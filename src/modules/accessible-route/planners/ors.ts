/**
 * OpenRouteService (ORS) client for wheelchair-accessible walking routes.
 * Falls back to straight-line Haversine when ORS_API_KEY is not set.
 *
 * Sign up at https://openrouteservice.org/ for a free API key (500 req/day).
 * For unlimited requests, self-host: https://github.com/GIScience/openrouteservice
 */

import { getWalkCache, setWalkCache } from "./walk-cache";
import { walkSpeedMps } from "../scoring";
import { WHEELCHAIR_SPEED_M_PER_MIN } from "../../../constants/accessibility";
import type { AccessibilityMode } from "../../../types/route";
import type {
  WalkingRoute,
} from "./ors.types";
export type {
  WalkingRoute,
};

const ORS_BASE = "https://api.openrouteservice.org/v2";

/** Walk duration (seconds) for a distance at the mode's walking speed. */
function durationForMode(distanceM: number, mode: AccessibilityMode): number {
  return distanceM / walkSpeedMps(mode);
}

export function haversineCoords(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function straightLineRoute(
  from: [number, number],
  to: [number, number],
  mode: AccessibilityMode,
): WalkingRoute {
  const distanceM = haversineCoords(from, to);
  return {
    polyline: [from, to],
    distanceM,
    durationSec: durationForMode(distanceM, mode),
  };
}

export async function orsWalkingRoute(
  from: [number, number],
  to: [number, number],
  mode: AccessibilityMode = "wheelchair",
): Promise<WalkingRoute> {
  const apiKey = process.env.ORS_API_KEY;

  // Distance is mode-independent; duration is always (re)derived from the mode's
  // walking speed, so a cached entry never leaks one mode's duration to another.
  const cached = await getWalkCache(from, to);
  if (cached) {
    return {
      polyline: [from, to],
      distanceM: cached.distanceM,
      durationSec: durationForMode(cached.distanceM, mode),
    };
  }

  if (!apiKey) {
    return straightLineRoute(from, to, mode);
  }

  const profile = mode === "wheelchair" ? "wheelchair" : "foot-walking";

  try {
    let resp = await fetch(`${ORS_BASE}/directions/${profile}/geojson`, {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ coordinates: [from, to] }),
    });

    if (!resp.ok && resp.status === 404 && profile === "wheelchair") {
      resp = await fetch(`${ORS_BASE}/directions/foot-walking/geojson`, {
        method: "POST",
        headers: {
          Authorization: apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ coordinates: [from, to] }),
      });
    }

    if (!resp.ok) {
      console.warn(`ORS ${resp.status} — falling back to straight line`);
      return straightLineRoute(from, to, mode);
    }

    const data = (await resp.json()) as any;
    const feature = data.features?.[0];
    if (!feature) return straightLineRoute(from, to, mode);

    // Trust ORS for distance/geometry; derive duration from the mode's walking
    // speed so wheelchair times aren't underestimated by ORS's foot-walking pace.
    const distanceM = feature.properties.summary.distance as number;
    const route: WalkingRoute = {
      polyline: feature.geometry.coordinates as [number, number][],
      distanceM,
      durationSec: durationForMode(distanceM, mode),
    };

    void setWalkCache(from, to, route.durationSec, route.distanceM).catch(
      () => {},
    );

    return route;
  } catch (err) {
    console.warn("ORS request failed — falling back to straight line:", err);
    return straightLineRoute(from, to, mode);
  }
}

/**
 * ORS Matrix: one-to-many walking durations.
 *
 * Returns walking duration in SECONDS for each destination, in the same order
 * as `destinations`. An element is `null` only when ORS reports a destination
 * as unreachable. When ORS_API_KEY is unset or any error occurs, falls back to
 * straight-line Haversine estimates (never null in fallback mode).
 *
 * @param origin The [lng, lat] origin coordinate.
 * @param destinations The [lng, lat] destination coordinates.
 * @returns Walking duration in seconds per destination, in input order.
 */
export async function orsWalkingMatrix(
  origin: [number, number],
  destinations: [number, number][],
): Promise<(number | null)[]> {
  const fallback = (): (number | null)[] =>
    destinations.map((d) => {
      const distM = haversineCoords(origin, d);
      return (distM / WHEELCHAIR_SPEED_M_PER_MIN) * 60;
    });

  if (destinations.length === 0) return [];

  const apiKey = process.env.ORS_API_KEY;
  if (!apiKey) return fallback();

  try {
    const body = {
      locations: [origin, ...destinations],
      sources: [0],
      destinations: Array.from(
        { length: destinations.length },
        (_, i) => i + 1,
      ),
      metrics: ["duration"],
    };

    const resp = await fetch(`${ORS_BASE}/matrix/foot-walking`, {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      console.warn(`ORS matrix ${resp.status} — falling back to straight line`);
      return fallback();
    }

    const data = (await resp.json()) as any;
    const row = data.durations?.[0] as (number | null)[] | undefined;
    if (!Array.isArray(row) || row.length !== destinations.length) {
      console.warn("ORS matrix unexpected response — falling back");
      return fallback();
    }

    return row.map((v) => (typeof v === "number" ? v : null));
  } catch (err) {
    console.warn("ORS matrix request failed — falling back to straight line:", err);
    return fallback();
  }
}
