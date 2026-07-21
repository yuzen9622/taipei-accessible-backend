/**
 * Per-LINE-user conversation state (pending intent + last shared location),
 * stored in Redis under `line:state:{id}` alongside line-memory's chat history.
 * Writes use an atomic Lua compare-and-set (no WATCH/MULTI, which is
 * connection-scoped and unsafe on the shared ioredis singleton). The
 * discriminated union is validated on read; invalid payloads are treated as no
 * state. Dependency direction is line → agent (forward): the neutral GeoLocation
 * lives in the agent module.
 */
import { redisClient } from "../../config/redis";
import {
  ALL_ACTIONS,
  type Action,
  type GeoLocation,
  type SlotCandidate,
} from "../agent/agent-intent.types";

const LINE_STATE_TTL_SEC = 30 * 60;
const CAS_MAX_ATTEMPTS = 3;

/** A shared location carries the neutral coordinate plus a share timestamp. */
export interface SharedLocation extends GeoLocation {
  ts: string;
}

export type PendingIntent =
  | { kind: "awaiting_bind_code" }
  | { kind: "awaiting_domain_choice"; location?: SharedLocation }
  | {
      kind: "collecting_slots";
      action: Action;
      filledSlots: Record<string, string | number>;
      location?: SharedLocation;
      awaitingSlot: string;
      candidates?: SlotCandidate[];
      missingSlots: string[];
    };

export interface LineConvState {
  version: number;
  pendingIntent?: PendingIntent;
  lastSharedLocation?: SharedLocation;
  updatedAt: string;
}

/** Fields a caller may set; version and updatedAt are managed internally. */
export type LineStateContent = Omit<LineConvState, "version" | "updatedAt">;

function lineStateKey(lineUserId: string): string {
  return `line:state:${lineUserId}`;
}

function isSharedLocation(value: unknown): value is SharedLocation {
  if (!value || typeof value !== "object") return false;
  const loc = value as Record<string, unknown>;
  return (
    typeof loc.lat === "number" &&
    typeof loc.lng === "number" &&
    typeof loc.ts === "string"
  );
}

function isPendingIntent(value: unknown): value is PendingIntent {
  if (!value || typeof value !== "object") return false;
  const pending = value as Record<string, unknown>;
  if (pending.kind === "awaiting_bind_code") return true;
  if (pending.kind === "awaiting_domain_choice") {
    return pending.location === undefined || isSharedLocation(pending.location);
  }
  if (pending.kind === "collecting_slots") {
    return (
      ALL_ACTIONS.includes(pending.action as Action) &&
      typeof pending.awaitingSlot === "string" &&
      Array.isArray(pending.missingSlots) &&
      Boolean(pending.filledSlots) &&
      typeof pending.filledSlots === "object" &&
      (pending.location === undefined || isSharedLocation(pending.location))
    );
  }
  return false;
}

function isLineConvState(value: unknown): value is LineConvState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  if (typeof state.version !== "number") return false;
  if (typeof state.updatedAt !== "string") return false;
  if (
    state.pendingIntent !== undefined &&
    !isPendingIntent(state.pendingIntent)
  ) {
    return false;
  }
  if (
    state.lastSharedLocation !== undefined &&
    !isSharedLocation(state.lastSharedLocation)
  ) {
    return false;
  }
  return true;
}

/**
 * Atomic compare-and-set: set the value only if the stored version equals the
 * expected version (0 / absent seeds to a first write). Returns 1 on success,
 * 0 on version conflict.
 */
const CAS_SCRIPT = `
local key = KEYS[1]
local expected = tonumber(ARGV[1])
local newval = ARGV[2]
local ttl = tonumber(ARGV[3])
local current = redis.call('GET', key)
local curver = 0
if current then
  local ok, decoded = pcall(cjson.decode, current)
  if ok and type(decoded) == 'table' and decoded.version then
    curver = decoded.version
  end
end
if curver ~= expected then
  return 0
end
redis.call('SET', key, newval, 'EX', ttl)
return 1
`;

/**
 * @param lineUserId LINE user identifier used to scope the state.
 * @returns The stored conversation state, or null on miss / invalid / error.
 */
export async function getLineState(
  lineUserId: string,
): Promise<LineConvState | null> {
  if (!redisClient) return null;
  try {
    const raw = await redisClient.get(lineStateKey(lineUserId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isLineConvState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Read → compute → atomic CAS write, retrying on version conflict up to 3 times.
 * The updater returns the new content (or null to delete the key).
 *
 * @param lineUserId LINE user identifier used to scope the state.
 * @param updater Computes the next content from the current state.
 * @returns `{ ok: true, state }` on success; `{ ok: false }` when Redis is
 *   unavailable, EVAL errors, or the CAS retries are exhausted.
 */
export async function updateLineState(
  lineUserId: string,
  updater: (prev: LineConvState | null) => LineStateContent | null,
): Promise<{ ok: boolean; state?: LineConvState }> {
  if (!redisClient) return { ok: false };
  const key = lineStateKey(lineUserId);

  for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt++) {
    const current = await getLineState(lineUserId);
    const expected = current?.version ?? 0;
    const content = updater(current);

    if (content === null) {
      try {
        await redisClient.del(key);
        return { ok: true };
      } catch {
        return { ok: false };
      }
    }

    const next: LineConvState = {
      pendingIntent: content.pendingIntent,
      lastSharedLocation: content.lastSharedLocation,
      version: expected + 1,
      updatedAt: new Date().toISOString(),
    };

    try {
      const res = await redisClient.eval(
        CAS_SCRIPT,
        1,
        key,
        String(expected),
        JSON.stringify(next),
        String(LINE_STATE_TTL_SEC),
      );
      if (Number(res) === 1) return { ok: true, state: next };
      // Version conflict → re-read and retry.
    } catch {
      return { ok: false };
    }
  }

  return { ok: false };
}

/**
 * Clear any pending intent while preserving the last shared location.
 *
 * @param lineUserId LINE user identifier used to scope the state.
 * @returns `{ ok }` indicating whether the write succeeded.
 */
export async function clearPendingIntent(
  lineUserId: string,
): Promise<{ ok: boolean }> {
  const result = await updateLineState(lineUserId, (prev) => ({
    pendingIntent: undefined,
    lastSharedLocation: prev?.lastSharedLocation,
  }));
  return { ok: result.ok };
}
