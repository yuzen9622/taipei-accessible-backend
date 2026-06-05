/**
 * OpenRouteService (ORS) client for wheelchair-accessible walking routes.
 * Falls back to straight-line Haversine when ORS_API_KEY is not set.
 *
 * Sign up at https://openrouteservice.org/ for a free API key (500 req/day).
 * For unlimited requests, self-host: https://github.com/GIScience/openrouteservice
 */

import { getWalkCache, setWalkCache } from "../service/walk-cache.service";

const ORS_BASE = "https://api.openrouteservice.org/v2";
const WHEELCHAIR_SPEED_M_PER_MIN = 60; // conservative wheelchair walking speed

export interface WalkingRoute {
  polyline: [number, number][]; // [[lng, lat], ...] GeoJSON order
  distanceM: number;
  durationSec: number;
}

function haversineCoords(a: [number, number], b: [number, number]): number {
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
    const resp = await fetch(`${ORS_BASE}/directions/${profile}/geojson`, {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ coordinates: [from, to] }),
    });

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
