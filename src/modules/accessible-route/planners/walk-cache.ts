/**
 * Phase 1 — walk-time cache (FR-04).
 *
 * Caches origin→destination walking time/distance under a stable geocoded key.
 * All Redis interaction goes through src/config/redis.ts, which degrades
 * gracefully when Redis is unavailable, so these helpers also never throw.
 *
 * Cache key format (FR-04, exact):
 *   walk:{o_lng.toFixed(6)},{o_lat.toFixed(6)}:{d_lng.toFixed(6)},{d_lat.toFixed(6)}
 * TTL: 86400 seconds (24h).
 */
import { redisGet, redisSet } from "../../../config/redis";

const WALK_TTL_SEC = 86400; // 24h

export interface WalkCacheEntry {
  durationSec: number;
  distanceM: number;
}

/** Builds the FR-04 cache key. Coordinates are [lng, lat] (GeoJSON order). */
export function walkCacheKey(
  origin: [number, number],
  dest: [number, number],
): string {
  return (
    `walk:${origin[0].toFixed(6)},${origin[1].toFixed(6)}` +
    `:${dest[0].toFixed(6)},${dest[1].toFixed(6)}`
  );
}

/** Returns the cached entry, or null on miss / parse-error / unavailable. */
export async function getWalkCache(
  origin: [number, number],
  dest: [number, number],
): Promise<WalkCacheEntry | null> {
  const raw = await redisGet(walkCacheKey(origin, dest));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<WalkCacheEntry>;
    if (
      typeof parsed.durationSec === "number" &&
      typeof parsed.distanceM === "number"
    ) {
      return { durationSec: parsed.durationSec, distanceM: parsed.distanceM };
    }
    return null;
  } catch {
    return null;
  }
}

/** Stores a walk-time entry. No-ops on unavailable / error. */
export async function setWalkCache(
  origin: [number, number],
  dest: [number, number],
  durationSec: number,
  distanceM: number,
): Promise<void> {
  const value = JSON.stringify({ durationSec, distanceM } satisfies WalkCacheEntry);
  await redisSet(walkCacheKey(origin, dest), value, WALK_TTL_SEC);
}
