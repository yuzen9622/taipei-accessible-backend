/**
 * Deterministic action registry: maps each classified `Action` to exactly one
 * first tool + argument builder + required slots + optional follow-up step
 * chain and a step state machine. The model never selects tools or fills tool
 * args on the LINE path — the executor drives these specs directly.
 */
import type {
  Action,
  ActionCtx,
  ActionSpec,
  ForcedStep,
  NormalizedToolResult,
  StepOutcome,
} from "./agent-intent.types";

/**
 * Parse a raw tool-result JSON string into a NormalizedToolResult that always
 * carries a boolean `ok`. Unparseable output becomes a controlled failure.
 *
 * @param raw The JSON string returned by the tool executor.
 * @returns The parsed object with a guaranteed `ok`, or a controlled failure.
 */
export function normalizeToolResult(raw: string): NormalizedToolResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, errorCode: "TOOL_RESULT_UNPARSEABLE" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: true, result: parsed };
  }
  const obj = parsed as Record<string, unknown>;
  let ok: boolean;
  if (typeof obj.ok === "boolean") ok = obj.ok;
  else if ("error" in obj && obj.error) ok = false;
  else ok = true;
  return { ...obj, ok };
}

function toNum(value: string | number | undefined): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value)))
    return Number(value);
  return undefined;
}

/** A terminal step that always proceeds to the summary after running. */
function terminalStep(
  name: string,
  buildArgs: (ctx: ActionCtx) => Record<string, unknown>,
): ForcedStep {
  return { name, buildArgs, onResult: () => ({ kind: "continue" }) };
}

function coords(ctx: ActionCtx): Record<string, number> {
  return ctx.location
    ? { latitude: ctx.location.lat, longitude: ctx.location.lng }
    : {};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function sessionSummary(result: NormalizedToolResult): string {
  const latest = asRecord(result.latestSession);
  if (!latest) return "目前沒有進行中的求救。";
  const owner = typeof latest.ownerName === "string" ? latest.ownerName : "家人";
  const status = typeof latest.status === "string" ? latest.status : "未知";
  const address = typeof latest.address === "string" ? latest.address : "位置不明";
  return `目前沒有進行中的求救。最近一次為 ${owner}（狀態：${status}，${address}）。`;
}

/**
 * The shared first SOS step: fetch active sessions, then branch on count.
 *
 * @returns A ForcedStep for getActiveSosContext with the multi-session guard.
 */
function sosContextStep(): ForcedStep {
  return {
    name: "getActiveSosContext",
    buildArgs: () => ({}),
    onResult: (result, ctx): StepOutcome => {
      if (result.ok === false) {
        return { kind: "stop_canned", message: "查詢求救狀態時發生問題，請稍後再試。" };
      }
      const active = Array.isArray(result.activeSessions)
        ? (result.activeSessions as unknown[])
        : [];
      if (active.length === 0) {
        return { kind: "stop_canned", message: sessionSummary(result) };
      }
      const candidates = active
        .map((entry) => asRecord(entry))
        .filter((entry): entry is Record<string, unknown> => Boolean(entry))
        .map((entry) => ({
          id: String(entry.sessionId ?? ""),
          label: `${typeof entry.ownerName === "string" ? entry.ownerName : "家人"}｜${
            typeof entry.address === "string" ? entry.address : "位置未知"
          }`,
        }))
        .filter((candidate) => candidate.id);
      if (candidates.length === 1) {
        ctx.slots.sosSessionId = candidates[0].id;
        return { kind: "continue" };
      }
      const selected = ctx.slots.sosSessionId
        ? String(ctx.slots.sosSessionId)
        : undefined;
      if (selected && candidates.some((candidate) => candidate.id === selected)) {
        return { kind: "continue" };
      }
      const list = candidates
        .map((candidate, index) => `${index + 1}. ${candidate.label}`)
        .join("\n");
      return {
        kind: "clarify",
        message: `目前有多筆進行中的求救，請回覆編號選擇：\n${list}`,
        persist: { awaitingSlot: "sosSessionId", candidates },
      };
    },
  };
}

function sosAction(secondStep: ForcedStep): ActionSpec {
  return {
    requiredSlots: () => [],
    askFor: {},
    steps: [sosContextStep(), secondStep],
    allowList: ["getActiveSosContext", secondStep.name],
  };
}

const busNeedsCity = (ctx: ActionCtx): boolean => !ctx.location;

export const ACTIONS: Record<Action, ActionSpec> = {
  "bind.code": {
    requiredSlots: () => ["code"],
    askFor: { code: "請輸入 6 碼綁定碼。" },
    allowList: ["bindEmergencyContactCode", "bindLineAccountCode"],
    steps: [
      {
        name: "bindEmergencyContactCode",
        buildArgs: (ctx) => ({ code: ctx.slots.code }),
        onResult: (result): StepOutcome => {
          if (result.ok === true) return { kind: "stop_success" };
          if (result.errorCode === "NO_EMERGENCY_BIND_CODE")
            return { kind: "fallback", toStepIndex: 1 };
          return {
            kind: "stop_canned",
            message:
              typeof result.error === "string"
                ? result.error
                : "綁定失敗，請確認綁定碼。",
          };
        },
      },
      {
        name: "bindLineAccountCode",
        buildArgs: (ctx) => ({ code: ctx.slots.code }),
        onResult: (result): StepOutcome => {
          if (result.ok === true) return { kind: "stop_success" };
          return {
            kind: "stop_canned",
            message: "找不到可用的綁定碼，請確認 6 碼是否正確或重新索取。",
          };
        },
      },
    ],
  },

  "sos.location": sosAction(
    terminalStep("getSosLiveLocation", (ctx) => ({
      sessionId: ctx.slots.sosSessionId,
    })),
  ),
  "sos.environment": sosAction(
    terminalStep("getSosEnvironmentInfo", (ctx) => ({
      sessionId: ctx.slots.sosSessionId,
    })),
  ),
  "sos.nearby": sosAction(
    terminalStep("findSosNearbyPlaces", (ctx) => ({
      sessionId: ctx.slots.sosSessionId,
      query: ctx.slots.query ? String(ctx.slots.query) : "醫院",
    })),
  ),
  "sos.nearby_a11y": sosAction(
    terminalStep("findSosNearbyA11yPlaces", (ctx) => ({
      sessionId: ctx.slots.sosSessionId,
      query: ctx.slots.query ? String(ctx.slots.query) : "附近無障礙設施",
    })),
  ),
  "sos.route": sosAction(
    terminalStep("planRouteToSosVictim", (ctx) => ({
      sessionId: ctx.slots.sosSessionId,
      ...(ctx.slots.mode ? { mode: String(ctx.slots.mode) } : {}),
    })),
  ),

  "weather.query": {
    requiredSlots: (ctx) => (ctx.slots.query || ctx.location ? [] : ["query"]),
    askFor: { query: "請問要查哪個地區的天氣？" },
    allowList: ["getEnvironmentInfo"],
    needsUserLocation: true,
    steps: [
      terminalStep("getEnvironmentInfo", (ctx) =>
        ctx.slots.query
          ? { query: String(ctx.slots.query) }
          : { ...coords(ctx) },
      ),
    ],
  },
  "air.query": {
    requiredSlots: (ctx) => (ctx.location ? [] : ["location"]),
    askFor: { location: "請傳送您的位置訊息，或改問某地區的天氣。" },
    allowList: ["getAirQuality"],
    needsUserLocation: true,
    steps: [terminalStep("getAirQuality", (ctx) => ({ ...coords(ctx) }))],
  },
  "place.find": {
    requiredSlots: (ctx) => (ctx.slots.query ? [] : ["query"]),
    askFor: { query: "請問要找什麼地點？" },
    allowList: ["findGooglePlaces"],
    needsUserLocation: true,
    steps: [
      terminalStep("findGooglePlaces", (ctx) => ({
        query: String(ctx.slots.query ?? ""),
        ...coords(ctx),
      })),
    ],
  },
  "a11y.find": {
    requiredSlots: (ctx) => (ctx.slots.query || ctx.location ? [] : ["query"]),
    askFor: { query: "請問要查哪裡的無障礙設施？" },
    allowList: ["findA11yPlaces"],
    needsUserLocation: true,
    steps: [
      terminalStep("findA11yPlaces", (ctx) =>
        ctx.slots.query
          ? { query: String(ctx.slots.query), ...coords(ctx) }
          : { query: "附近無障礙設施", ...coords(ctx) },
      ),
    ],
  },
  "a11y.detail": {
    requiredSlots: () => ["osmId"],
    askFor: { osmId: "請提供設施的 OSM ID。" },
    allowList: ["getA11yFacilityDetails"],
    steps: [
      terminalStep("getA11yFacilityDetails", (ctx) => ({
        osmId: String(ctx.slots.osmId),
      })),
    ],
  },
  "parking.find": {
    requiredSlots: (ctx) => (ctx.slots.query || ctx.location ? [] : ["query"]),
    askFor: { query: "請問要查哪裡附近的身障停車位？" },
    allowList: ["findNearbyParking"],
    needsUserLocation: true,
    steps: [
      terminalStep("findNearbyParking", (ctx) =>
        ctx.slots.query
          ? { query: String(ctx.slots.query), ...coords(ctx) }
          : { ...coords(ctx) },
      ),
    ],
  },
  "campus.find": {
    requiredSlots: (ctx) => (ctx.slots.query || ctx.location ? [] : ["query"]),
    askFor: { query: "請問要查哪間學校或校區的無障礙設施？" },
    allowList: ["findCampusAccessibility"],
    needsUserLocation: true,
    steps: [
      terminalStep("findCampusAccessibility", (ctx) => ({
        ...(ctx.slots.query ? { query: String(ctx.slots.query) } : {}),
        ...coords(ctx),
      })),
    ],
  },
  "campus.detail": {
    requiredSlots: () => ["campusId"],
    askFor: { campusId: "請提供校區 campusId。" },
    allowList: ["getCampusAccessibilityDetails"],
    steps: [
      terminalStep("getCampusAccessibilityDetails", (ctx) => ({
        campusId: toNum(ctx.slots.campusId),
      })),
    ],
  },

  "bus.route_info": {
    requiredSlots: (ctx) =>
      busNeedsCity(ctx) ? ["routeName", "city"] : ["routeName"],
    askFor: {
      routeName: "請問是哪一條公車路線？",
      city: "請問是哪個縣市的公車？",
    },
    allowList: ["getBusRoute", "getBusRouteDetail"],
    steps: [
      {
        name: "getBusRoute",
        buildArgs: (ctx) => ({
          routeName: String(ctx.slots.routeName),
          ...(ctx.slots.city ? { city: String(ctx.slots.city) } : {}),
        }),
        onResult: (): StepOutcome => ({ kind: "continue" }),
      },
      terminalStep("getBusRouteDetail", (ctx) => ({
        routeName: String(ctx.slots.routeName),
        ...(ctx.slots.city ? { city: String(ctx.slots.city) } : {}),
      })),
    ],
  },
  "bus.arrival": {
    requiredSlots: (ctx) =>
      busNeedsCity(ctx)
        ? ["routeName", "stopName", "city"]
        : ["routeName", "stopName"],
    askFor: {
      routeName: "請問是哪一條公車路線？",
      stopName: "請問要查哪個站牌？",
      city: "請問是哪個縣市的公車？",
    },
    allowList: ["getBusArrival"],
    steps: [
      terminalStep("getBusArrival", (ctx) => ({
        routeName: String(ctx.slots.routeName),
        stopName: String(ctx.slots.stopName),
        ...(ctx.slots.city ? { city: String(ctx.slots.city) } : {}),
      })),
    ],
  },
  "bus.timetable": {
    requiredSlots: (ctx) =>
      busNeedsCity(ctx) ? ["routeName", "city"] : ["routeName"],
    askFor: {
      routeName: "請問是哪一條公車路線？",
      city: "請問是哪個縣市的公車？",
    },
    allowList: ["getBusTimetable"],
    steps: [
      terminalStep("getBusTimetable", (ctx) => ({
        routeName: String(ctx.slots.routeName),
        ...(ctx.slots.city ? { city: String(ctx.slots.city) } : {}),
      })),
    ],
  },
  "bus.nearby_stops": {
    requiredSlots: (ctx) => (ctx.location ? [] : ["location"]),
    askFor: { location: "請傳送您的位置訊息，我才能找附近的公車站牌。" },
    allowList: ["findNearbyBusStops"],
    needsUserLocation: true,
    steps: [terminalStep("findNearbyBusStops", (ctx) => ({ ...coords(ctx) }))],
  },
  "bus.track": {
    requiredSlots: (ctx) =>
      busNeedsCity(ctx) ? ["routeName", "city"] : ["routeName"],
    askFor: {
      routeName: "請問是哪一條公車路線？",
      city: "請問是哪個縣市的公車？",
    },
    allowList: ["trackBuses"],
    steps: [
      terminalStep("trackBuses", (ctx) => ({
        routeName: String(ctx.slots.routeName),
        ...(ctx.slots.city ? { city: String(ctx.slots.city) } : {}),
      })),
    ],
  },
  "train.od": {
    requiredSlots: () => ["originStation", "destinationStation"],
    askFor: {
      originStation: "請問從哪一站出發？",
      destinationStation: "請問要到哪一站？",
    },
    allowList: ["getTrainTimetable"],
    steps: [
      terminalStep("getTrainTimetable", (ctx) => ({
        originStation: String(ctx.slots.originStation),
        destinationStation: String(ctx.slots.destinationStation),
        ...(ctx.slots.date ? { date: String(ctx.slots.date) } : {}),
        ...(ctx.slots.departAfter
          ? { departAfter: String(ctx.slots.departAfter) }
          : {}),
        ...(ctx.slots.arriveBy ? { arriveBy: String(ctx.slots.arriveBy) } : {}),
        ...(ctx.slots.railSystem
          ? { railSystem: String(ctx.slots.railSystem) }
          : {}),
      })),
    ],
  },
  "train.station": {
    requiredSlots: () => ["station"],
    askFor: { station: "請問要查哪一個車站？" },
    allowList: ["getStationTimetable"],
    steps: [
      terminalStep("getStationTimetable", (ctx) => ({
        station: String(ctx.slots.station),
        ...(ctx.slots.date ? { date: String(ctx.slots.date) } : {}),
        ...(ctx.slots.departAfter
          ? { departAfter: String(ctx.slots.departAfter) }
          : {}),
        ...(ctx.slots.railSystem
          ? { railSystem: String(ctx.slots.railSystem) }
          : {}),
      })),
    ],
  },
  "route.plan": {
    requiredSlots: (ctx) => (ctx.slots.destination ? [] : ["destination"]),
    askFor: { destination: "請問要規劃到哪裡的路線？" },
    allowList: ["planAccessibleRoute"],
    needsUserLocation: true,
    steps: [
      terminalStep("planAccessibleRoute", (ctx) => ({
        origin: ctx.slots.origin ? String(ctx.slots.origin) : "current_location",
        destination: String(ctx.slots.destination),
        ...(ctx.slots.mode ? { mode: String(ctx.slots.mode) } : {}),
        ...(ctx.slots.departureTime
          ? { departureTime: String(ctx.slots.departureTime) }
          : {}),
      })),
    ],
  },
  "nav.instructions": {
    requiredSlots: (ctx) => (ctx.slots.destination ? [] : ["destination"]),
    askFor: { destination: "請問要導航到哪裡？" },
    allowList: ["getNavInstructions"],
    needsUserLocation: true,
    steps: [
      terminalStep("getNavInstructions", (ctx) => ({
        origin: ctx.slots.origin ? String(ctx.slots.origin) : "current_location",
        destination: String(ctx.slots.destination),
        ...(ctx.slots.mode ? { mode: String(ctx.slots.mode) } : {}),
      })),
    ],
  },
  "hazard.nearby": {
    requiredSlots: (ctx) => (ctx.slots.query || ctx.location ? [] : ["query"]),
    askFor: { query: "請問要查哪裡附近的路況危險？" },
    allowList: ["getNearbyHazards"],
    needsUserLocation: true,
    steps: [
      terminalStep("getNearbyHazards", (ctx) => ({
        ...(ctx.slots.query ? { query: String(ctx.slots.query) } : {}),
        ...coords(ctx),
      })),
    ],
  },
  "guide.search": {
    requiredSlots: () => ["query"],
    askFor: { query: "請問想了解什麼無障礙相關資訊？" },
    allowList: ["searchAccessibilityGuide"],
    steps: [
      terminalStep("searchAccessibilityGuide", (ctx) => ({
        query: String(ctx.slots.query),
      })),
    ],
  },
  "web.search": {
    requiredSlots: () => ["query"],
    askFor: { query: "請問要搜尋什麼？" },
    allowList: ["webSearch"],
    steps: [
      terminalStep("webSearch", (ctx) => ({ query: String(ctx.slots.query) })),
    ],
  },

  app_info: {
    requiredSlots: () => [],
    askFor: {},
    allowList: [],
    steps: [],
  },
  smalltalk: {
    requiredSlots: () => [],
    askFor: {},
    allowList: [],
    steps: [],
  },
  unknown: {
    requiredSlots: () => [],
    askFor: {},
    allowList: [],
    steps: [],
  },
};

/**
 * @param action The classified action.
 * @returns The ActionSpec for that action.
 */
export function getActionSpec(action: Action): ActionSpec {
  return ACTIONS[action];
}
