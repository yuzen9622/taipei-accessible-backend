/**
 * Shared, framework- and surface-neutral types for the deterministic agent
 * routing pipeline (intent classifier → action registry → action executor).
 * This module must never import from `modules/line/*`; the dependency direction
 * is line → agent (forward). LINE-specific shapes (e.g. SharedLocation) live in
 * `modules/line/line-state.ts` and extend the neutral types defined here.
 */

/** Agent-neutral coordinate pair. LINE's SharedLocation extends this. */
export interface GeoLocation {
  lat: number;
  lng: number;
}

/**
 * Sub-intent granularity. Classification resolves to an action (not merely a
 * domain) so the registry can pick an exact first tool + arg builder.
 */
export type Action =
  | "bind.code"
  | "sos.location"
  | "sos.environment"
  | "sos.nearby"
  | "sos.nearby_a11y"
  | "sos.route"
  | "weather.query"
  | "air.query"
  | "place.find"
  | "a11y.find"
  | "a11y.detail"
  | "parking.find"
  | "campus.find"
  | "campus.detail"
  | "bus.route_info"
  | "bus.arrival"
  | "bus.timetable"
  | "bus.nearby_stops"
  | "bus.track"
  | "train.od"
  | "train.station"
  | "route.plan"
  | "nav.instructions"
  | "hazard.nearby"
  | "guide.search"
  | "web.search"
  | "app_info"
  | "smalltalk"
  | "unknown";

/** Full set of valid actions, for runtime validation of LLM output. */
export const ALL_ACTIONS: readonly Action[] = [
  "bind.code",
  "sos.location",
  "sos.environment",
  "sos.nearby",
  "sos.nearby_a11y",
  "sos.route",
  "weather.query",
  "air.query",
  "place.find",
  "a11y.find",
  "a11y.detail",
  "parking.find",
  "campus.find",
  "campus.detail",
  "bus.route_info",
  "bus.arrival",
  "bus.timetable",
  "bus.nearby_stops",
  "bus.track",
  "train.od",
  "train.station",
  "route.plan",
  "nav.instructions",
  "hazard.nearby",
  "guide.search",
  "web.search",
  "app_info",
  "smalltalk",
  "unknown",
] as const;

/** The coarse grouping used only by Tier1 rules and short-reply inheritance. */
export type Domain =
  | "bind"
  | "sos"
  | "weather"
  | "air"
  | "place"
  | "a11y"
  | "parking"
  | "campus"
  | "bus"
  | "train"
  | "route"
  | "nav"
  | "hazard"
  | "guide"
  | "web"
  | "app"
  | "smalltalk"
  | "unknown";

/**
 * @param action The resolved action.
 * @returns The coarse domain the action belongs to.
 */
export function domainOf(action: Action): Domain {
  const [head] = action.split(".");
  switch (head) {
    case "bind":
      return "bind";
    case "sos":
      return "sos";
    case "weather":
      return "weather";
    case "air":
      return "air";
    case "place":
      return "place";
    case "a11y":
      return "a11y";
    case "parking":
      return "parking";
    case "campus":
      return "campus";
    case "bus":
      return "bus";
    case "train":
      return "train";
    case "route":
      return "route";
    case "nav":
      return "nav";
    case "hazard":
      return "hazard";
    case "guide":
      return "guide";
    case "web":
      return "web";
    case "app_info":
      return "app";
    case "smalltalk":
      return "smalltalk";
    default:
      return "unknown";
  }
}

/** Classifier output: an action plus any scalar slots and a confidence flag. */
export interface IntentResult {
  action: Action;
  slots: Record<string, string | number>;
  confidence: "high" | "low";
}

/**
 * A tool result after normalization: always carries a boolean `ok`, optionally
 * a machine-readable `errorCode`, plus every other field the tool returned.
 */
export interface NormalizedToolResult {
  ok: boolean;
  errorCode?: string;
  [key: string]: unknown;
}

/** Execution context threaded through a forced step's arg builder + guard. */
export interface ActionCtx {
  slots: Record<string, string | number>;
  location?: GeoLocation;
  prev: NormalizedToolResult[];
}

/** A candidate offered to the user when a slot needs an explicit choice. */
export interface SlotCandidate {
  id: string;
  label: string;
}

/** Persisted follow-up state a clarify outcome wants the dispatcher to store. */
export interface ClarifyPersist {
  awaitingSlot: string;
  candidates: SlotCandidate[];
}

/** The verdict of a single forced step, driving the executor state machine. */
export type StepOutcome =
  | { kind: "continue" }
  | { kind: "stop_success" }
  | { kind: "stop_canned"; message: string }
  | { kind: "fallback"; toStepIndex: number }
  | { kind: "clarify"; message: string; persist?: ClarifyPersist };

/** One deterministic step: fixed tool name + arg builder + result guard. */
export interface ForcedStep {
  name: string;
  buildArgs: (ctx: ActionCtx) => Record<string, unknown>;
  onResult: (result: NormalizedToolResult, ctx: ActionCtx) => StepOutcome;
}

/** The deterministic plan for one action. */
export interface ActionSpec {
  requiredSlots: (ctx: ActionCtx) => string[];
  askFor: Record<string, string>;
  steps: ForcedStep[];
  /**
   * Execution-layer allow-list. `[]` = deny-all (no-tool action). Membership is
   * always checked when an array is supplied (contrast: `undefined` upstream
   * keeps the legacy AUTO path).
   */
  allowList: string[];
  needsUserLocation?: boolean;
}

/** A collected tool result entry, used to build the LINE route card. */
export interface ToolResultEntry {
  name: string;
  args: object;
  result: NormalizedToolResult;
}

/** The outcome of running an action end-to-end. */
export type ActionExecOutcome =
  | { kind: "speech"; speech: string; toolResults: ToolResultEntry[] }
  | { kind: "canned"; speech: string }
  | { kind: "clarify"; message: string; persist?: ClarifyPersist };

/**
 * Agent-neutral projection of pending conversation state the classifier reads
 * for Tier1 short-reply inheritance and bind context. LINE maps its richer
 * PendingIntent into this before calling the classifier.
 */
export type ClassifierPending =
  | {
      kind: "collecting_slots";
      action: Action;
      awaitingSlot: string;
      candidates?: SlotCandidate[];
    }
  | { kind: "awaiting_bind_code" }
  | { kind: "awaiting_domain_choice" };
