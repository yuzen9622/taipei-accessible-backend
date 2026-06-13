/**
 * OpenRouteService (ORS) client for wheelchair-accessible walking routes.
 * Falls back to straight-line Haversine when ORS_API_KEY is not set.
 *
 * Sign up at https://openrouteservice.org/ for a free API key (500 req/day).
 * For unlimited requests, self-host: https://github.com/GIScience/openrouteservice
 */

import { getWalkCache, setWalkCache } from "./walk-cache.service";

const ORS_BASE = "https://api.openrouteservice.org/v2";
export const WHEELCHAIR_SPEED_M_PER_MIN = 60; // conservative wheelchair walking speed

export interface WalkingRoute {
  polyline: [number, number][]; // [[lng, lat], ...] GeoJSON order
  distanceM: number;
  durationSec: number;
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
): WalkingRoute {
  const distanceM = haversineCoords(from, to);
  return {
    polyline: [from, to],
    distanceM,
    durationSec: (distanceM / WHEELCHAIR_SPEED_M_PER_MIN) * 60,
  };
}

export async function orsWalkingRoute(
  from: [number, number], // [lng, lat]
  to: [number, number],
  wheelchair = true,
): Promise<WalkingRoute> {
  const apiKey = process.env.ORS_API_KEY;

  // Phase 1 (FR-04): check the walk cache first. A cached entry only stores
  // duration + distance, so reconstruct a straight-line-shaped polyline.
  const cached = await getWalkCache(from, to);
  if (cached) {
    return {
      polyline: [from, to],
      distanceM: cached.distanceM,
      durationSec: cached.durationSec,
    };
  }

  if (!apiKey) {
    // Straight-line fallback is NOT cached — caching poor estimates would
    // pollute the cache once ORS becomes available.
    return straightLineRoute(from, to);
  }

  const profile = wheelchair ? "wheelchair" : "foot-walking";

  try {
    let resp = await fetch(`${ORS_BASE}/directions/${profile}/geojson`, {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ coordinates: [from, to] }),
    });

    // wheelchair profile is not available on the free public API — retry with
    // foot-walking before giving up entirely.
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
      return straightLineRoute(from, to);
    }

    const data = (await resp.json()) as any;
    const feature = data.features?.[0];
    if (!feature) return straightLineRoute(from, to);

    const route: WalkingRoute = {
      polyline: feature.geometry.coordinates as [number, number][],
      distanceM: feature.properties.summary.distance,
      durationSec: feature.properties.summary.duration,
    };

    // Cache only successful ORS responses. Fire-and-forget; never delay or
    // break the caller on a cache-write failure.
    void setWalkCache(from, to, route.durationSec, route.distanceM).catch(
      () => {},
    );

    return route;
  } catch (err) {
    console.warn("ORS request failed — falling back to straight line:", err);
    return straightLineRoute(from, to);
  }
}

/**
 * Phase 2 — ORS Matrix: one-to-many walking durations.
 *
 * Returns walking duration in SECONDS for each destination, in the same order
 * as `destinations`. An element is `null` only when ORS reports a destination
 * as unreachable. When ORS_API_KEY is unset or any error occurs, falls back to
 * straight-line Haversine estimates (never null in fallback mode).
 */
export async function orsWalkingMatrix(
  origin: [number, number], // [lng, lat]
  destinations: [number, number][], // [[lng, lat], ...]
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
