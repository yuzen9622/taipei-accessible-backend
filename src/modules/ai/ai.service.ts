import { googleGenAi, model } from "../../config/ai";
import { intentConfig, explainConfig } from "../../config/ai/config";
import { intentContents, explainContents } from "../../config/ai/contents";

// ─── Types ─────────────────────────────────────────────────────────────────

export type AccessibilityMode =
  | "wheelchair"
  | "elderly"
  | "visual_impaired"
  | "normal";

/** Structured travel intent extracted from a natural-language query (spec §12.3). */
export interface RouteIntent {
  /** Origin place name, or "current_location". */
  from: string;
  to: string;
  mode: AccessibilityMode;
  /** "now" or "HH:mm" / ISO8601. */
  departureTime: string;
  preferences: {
    minimizeTransfers: boolean;
    preferElevator: boolean;
  };
}

/** Human-readable explanation of a planned route (spec §12.4). */
export interface RouteExplanation {
  /** One-sentence route summary. */
  summary: string;
  /** Verified accessibility highlights, rephrased from route data. */
  accessibilityHighlights: string[];
  /** Risks / caveats (elevator outage, next-day departure, low score…). */
  warnings: string[];
  /** Concrete fallback suggestion; null when there are no warnings. */
  alternatives: string | null;
}

// ─── Intent parsing (Gemini) ─────────────────────────────────────────────────

const VALID_MODES: AccessibilityMode[] = [
  "wheelchair",
  "elderly",
  "visual_impaired",
  "normal",
];

/**
 * Parse a free-form travel query into a RouteIntent via a single structured
 * Gemini call. Returns null when the model produces no usable JSON or the
 * essential fields (from/to) are missing. Reusable by other modules
 * (e.g. accessible-route's optional intent switch).
 */
export async function parseRouteIntent(
  query: string
): Promise<RouteIntent | null> {
  const aiResponse = await googleGenAi.models.generateContent({
    model,
    contents: [
      ...intentContents,
      { role: "user", parts: [{ text: JSON.stringify({ query }) }] },
    ],
    config: intentConfig,
  });

  const text = aiResponse?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return null;

  let parsed: Partial<RouteIntent>;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (!parsed.from || !parsed.to) return null;

  const mode: AccessibilityMode = VALID_MODES.includes(
    parsed.mode as AccessibilityMode
  )
    ? (parsed.mode as AccessibilityMode)
    : "normal";

  return {
    from: parsed.from,
    to: parsed.to,
    mode,
    departureTime: parsed.departureTime || "now",
    preferences: {
      minimizeTransfers: parsed.preferences?.minimizeTransfers ?? false,
      // Wheelchair users default to preferring elevators.
      preferElevator:
        parsed.preferences?.preferElevator ?? mode === "wheelchair",
    },
  };
}

// ─── Route explanation (Gemini) ──────────────────────────────────────────────

/**
 * Strip bulky fields (polylines, raw OSM facility arrays) from an
 * AccessibleRoute before sending it to Gemini — only what the explanation
 * prompt actually reads. Tolerates arbitrary route shapes (route comes from
 * the client in /ai/explain).
 */
function compactRoute(route: Record<string, any>): Record<string, any> {
  const legs = Array.isArray(route.legs)
    ? route.legs.map((leg: Record<string, any>) => {
        const {
          polyline: _polyline,
          a11yFacilities: _a11yFacilities,
          departureStopA11y: _depStopA11y,
          arrivalStopA11y: _arrStopA11y,
          departureStationA11y: _depStaA11y,
          arrivalStationA11y: _arrStaA11y,
          ...rest
        } = leg ?? {};
        return rest;
      })
    : [];
  return {
    routeName: route.routeName,
    totalMinutes: route.totalMinutes,
    transferCount: route.transferCount,
    departureDate: route.departureDate,
    accessibilityScore: route.accessibilityScore,
    accessibilityLabel: route.accessibilityLabel,
    accessibilityHighlights: route.accessibilityHighlights,
    legs,
  };
}

/**
 * Generate a RouteExplanation for a planned route via a single structured
 * Gemini call. Returns null when the model produces no usable JSON.
 * Reusable by other modules (e.g. accessible-route optional explanation).
 */
export async function generateRouteExplanation(
  route: Record<string, any>,
  mode: AccessibilityMode = "normal",
  language: "zh-TW" | "en" = "zh-TW"
): Promise<RouteExplanation | null> {
  const aiResponse = await googleGenAi.models.generateContent({
    model,
    contents: [
      ...explainContents,
      {
        role: "user",
        parts: [
          { text: JSON.stringify({ route: compactRoute(route), mode, language }) },
        ],
      },
    ],
    config: explainConfig,
  });

  const text = aiResponse?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return null;

  let parsed: Partial<RouteExplanation> & { alternatives?: string };
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed.summary) return null;

  return {
    summary: parsed.summary,
    accessibilityHighlights: Array.isArray(parsed.accessibilityHighlights)
      ? parsed.accessibilityHighlights
      : [],
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
    // schema forces a string; empty string means "no suggestion" → null
    alternatives: parsed.alternatives?.trim() ? parsed.alternatives : null,
  };
}
