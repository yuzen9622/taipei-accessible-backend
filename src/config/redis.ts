/**
 * Singleton Redis client with graceful degradation.
 *
 * Reads process.env.REDIS_URL. If unset, no connection is attempted and every
 * operation silently no-ops (behaves as a cache miss). If the connection fails
 * at any point, operations also no-op — the app must never crash because Redis
 * is down. Connection errors are logged at most once.
 */
import Redis from "ioredis";

let logged = false;
let redisClient: Redis | null = null;

if (process.env.REDIS_URL) {
  redisClient = new Redis(process.env.REDIS_URL, {
    // Defer the TCP handshake until first command — avoids crashing on startup
    // if Redis is down.
    lazyConnect: true,
    // Reject commands immediately when disconnected instead of queuing forever.
    enableOfflineQueue: false,
    // Disable per-command retries to prevent request stalls.
    maxRetriesPerRequest: 0,
    // Fail fast on the initial handshake instead of blocking for the 10s default.
    connectTimeout: 3000,
  });

  redisClient.on("error", (err: Error) => {
    if (!logged) {
      console.warn("[Redis] connection error — walk cache disabled:", err.message);
      logged = true;
    }
  });

  // Fire-and-forget connect; failures surface via the "error" handler above.
  redisClient.connect().catch(() => {
    /* handled by "error" event */
  });
}

export { redisClient };

/** Returns the stored string, or null on miss / unavailable / error. */
export async function redisGet(key: string): Promise<string | null> {
  if (!redisClient) return null;
  try {
    return await redisClient.get(key);
  } catch {
    return null;
  }
}

/** Stores a string with a TTL in seconds. No-ops on unavailable / error. */
export async function redisSet(
  key: string,
  value: string,
  ttlSec: number,
): Promise<void> {
  if (!redisClient) return;
  try {
    await redisClient.set(key, value, "EX", ttlSec);
  } catch {
    /* no-op */
  }
}
