import BusStopModel from "../../model/bus-stop.model";
import { getCity, getCoordinates } from "../../adapters/google.adapter";
import { parseRouteIntent } from "../ai/ai.service";
import type { RouteIntent } from "../../types/ai";
import { ResponseCode } from "../../types/code";
import { ERROR_MESSAGE } from "../../constants/messages";
import type {
  FindAccessibleRoutesOptions,
  PlanRouteRequest,
  PlanRouteResult,
} from "./accessible-route.types";
export type { FindAccessibleRoutesOptions, PlanRouteRequest, PlanRouteResult };

import type { IOsmA11y } from "../../types";
import { TaiwanCityEn } from "../../types/transit";
import { slimRoutes, compactRoutes } from "./facility-slim";
import { scoreRoute, routeCost, prerankCost, MODE_PROFILES } from "./scoring";

import type {
  AccessibilityMode,
  SlimA11y,
  WalkLeg,
  BusLeg,
  MetroLeg,
  ThsrLeg,
  TraLeg,
  AccessibleRoute,
} from "../../types/route";
export type {
  SlimA11y,
  WalkLeg,
  BusLeg,
  MetroLeg,
  ThsrLeg,
  TraLeg,
  AccessibleRoute,
} from "../../types/route";

function nearQuery(coords: [number, number], maxDistM: number) {
  return {
    location: {
      $near: {
        $geometry: { type: "Point", coordinates: coords },
        $maxDistance: maxDistM,
      },
    },
  };
}

function collectRouteFacilities(r: AccessibleRoute): IOsmA11y[] {
  return r.legs.flatMap((leg) => {
    if (leg.type === "WALK") return leg.a11yFacilities;
    if (leg.type === "BUS")
      return [...leg.departureStopA11y, ...leg.arrivalStopA11y];
    if (leg.type === "METRO")
      return [...leg.departureStationA11y, ...leg.arrivalStationA11y];
    if (leg.type === "THSR")
      return [...leg.departureStationA11y, ...leg.arrivalStationA11y];
    if (leg.type === "TRA")
      return [...leg.departureStationA11y, ...leg.arrivalStationA11y];
    return [];
  });
}

/**
 * Total walking distance across all WALK legs, in metres — drives the
 * walk-distance penalty in scoring/ranking and is surfaced on the route.
 *
 * @param r Route to measure.
 * @returns Total walk distance in metres.
 */
function totalWalkDistanceM(r: AccessibleRoute): number {
  return r.legs.reduce(
    (sum, leg) => (leg.type === "WALK" ? sum + leg.distanceM : sum),
    0,
  );
}

/**
 * Fraction of legs that carry ANY accessibility evidence (OSM a11y nodes or
 * facility highlights) — feeds dataConfidence so missing data is flagged as
 * uncertainty, not scored as bad.
 *
 * @param r Route to inspect.
 * @returns Coverage ratio in [0, 1].
 */
function legDataCoverageRatio(r: AccessibleRoute): number {
  if (!r.legs.length) return 1;
  let withData = 0;
  for (const leg of r.legs) {
    if (leg.type === "WALK") {
      if (leg.a11yFacilities.length) withData++;
    } else if (leg.type === "BUS") {
      if (leg.departureStopA11y.length || leg.arrivalStopA11y.length)
        withData++;
    } else if (
      leg.departureStationA11y.length ||
      leg.arrivalStationA11y.length ||
      leg.facilityHighlights.length
    ) {
      withData++;
    }
  }
  return withData / r.legs.length;
}

/**
 * Score every candidate route with the evidence-based scoring engine
 * (accessibility 65% / travel time 35%) and rank them by mode-aware route cost.
 *
 * @param routes Candidate routes to score and rank.
 * @param mode Accessibility mode driving the cost weights. Default "normal".
 * @returns The routes sorted by ascending cost (best first), with score
 *   metadata attached to each.
 */
export function scoreAndRank(
  routes: AccessibleRoute[],
  mode: AccessibilityMode = "normal",
): AccessibleRoute[] {
  const maxTime = Math.max(...routes.map((r) => r.totalMinutes), 1);
  const minTime = Math.min(...routes.map((r) => r.totalMinutes), maxTime);

  return routes
    .map((r) => {
      const facilities = collectRouteFacilities(r);
      const walkDistanceM = totalWalkDistanceM(r);
      const result = scoreRoute(
        facilities,
        r.totalMinutes,
        maxTime,
        minTime,
        r.accessibilityHighlights.length,
        mode,
        walkDistanceM,
        legDataCoverageRatio(r),
      );
      r.accessibilityScore = result.totalScore;
      r.accessibilityLabel = result.label;
      r.scoreComponents = result.components;
      r.dataConfidence = result.dataConfidence;
      r.scoreWarnings = result.warnings;
      r.totalWalkDistanceM = walkDistanceM;
      return {
        route: r,
        cost: routeCost(
          r.totalMinutes,
          r.transferCount,
          result.totalScore,
          mode,
          walkDistanceM,
        ),
      };
    })
    .sort((a, b) => a.cost - b.cost)
    .map((s) => s.route);
}

/**
 * Stage-1 pre-ranking for the two-stage pipeline: order candidates by a cheap,
 * accessibility-aware proxy (time + transfers + walk distance) that needs NO OSM
 * data, so the top-N can be enriched before the real scoreRoute runs. Without
 * this, scoring ran on the un-enriched candidate set (facility data still empty)
 * and the accessibility budget collapsed to pure travel time.
 *
 * @param routes Candidate routes.
 * @param mode Accessibility mode driving the proxy penalties.
 * @returns Routes sorted by ascending proxy cost (best first).
 */
function prerankByProxy(
  routes: AccessibleRoute[],
  mode: AccessibilityMode,
): AccessibleRoute[] {
  return routes
    .map((r) => ({
      route: r,
      cost: prerankCost(
        r.totalMinutes,
        r.transferCount,
        totalWalkDistanceM(r),
        mode,
      ),
    }))
    .sort((a, b) => a.cost - b.cost)
    .map((s) => s.route);
}

/**
 * True when a walk leg passes a confirmed stairs-only barrier.
 *
 * @param leg Walk leg to inspect.
 * @returns Whether the leg crosses a stairs-only barrier.
 */
function walkLegHasStairsBarrier(leg: WalkLeg): boolean {
  return leg.a11yFacilities.some(
    (f) =>
      f.tags?.["highway"] === "steps" &&
      f.tags?.["ramp:wheelchair"] !== "yes" &&
      f.tags?.["wheelchair"] !== "yes",
  );
}

/**
 * Tier-1 exclusion for wheelchair mode: a route is excluded when a rail leg has
 * facility data but no elevator mention, or a walk leg passes a stairs-only
 * barrier. Legs with NO facility data are tolerated (unknown ≠ inaccessible) —
 * over-excluding on missing data would 404 most queries.
 *
 * @param route Route to evaluate.
 * @param mode Accessibility mode; exclusion only applies when its profile
 *   requires Tier 1 features.
 * @returns Whether the route should be excluded.
 */
function isRouteExcluded(
  route: AccessibleRoute,
  mode: AccessibilityMode,
): boolean {
  if (!(MODE_PROFILES[mode] ?? MODE_PROFILES.normal).tier1Required)
    return false;

  for (const leg of route.legs) {
    if (leg.type === "WALK") {
      if (walkLegHasStairsBarrier(leg)) return true;
      continue;
    }
    if (leg.type === "BUS") continue;
    if (leg.facilityHighlights.length > 0) {
      const text = leg.facilityHighlights.join("|");
      if (!text.includes("電梯")) return true;
      if (/電梯[^|]*(維修|故障|暫停)/.test(text)) return true;
    }
  }
  return false;
}

/**
 * Apply wheelchair Tier-1 exclusion with a graceful fallback: when EVERY
 * candidate would be excluded, return the originals (a risky route beats a
 * 404) — the low accessibility score + warnings still signal the risk.
 *
 * @param routes Candidate routes to filter.
 * @param mode Accessibility mode driving the exclusion.
 * @returns The kept routes, or all originals when none survive.
 */
function applyModeExclusion(
  routes: AccessibleRoute[],
  mode: AccessibilityMode,
): AccessibleRoute[] {
  const kept = routes.filter((r) => !isRouteExcluded(r, mode));
  return kept.length ? kept : routes;
}

function transitLegKey(leg: BusLeg | MetroLeg | ThsrLeg | TraLeg): string {
  switch (leg.type) {
    case "BUS":
      return `BUS|${leg.routeName}|${leg.departureStop}|${leg.arrivalStop}|${leg.direction}`;
    case "METRO":
      return `METRO|${leg.railSystem}|${leg.departureStationUid}|${leg.arrivalStationUid}`;
    case "THSR":
      return `THSR|${leg.departureStationUID}|${leg.arrivalStationUID}`;
    case "TRA":
      return `TRA|${leg.departureStationUID}|${leg.arrivalStationUID}`;
  }
}

function buildRouteKey(r: AccessibleRoute): string {
  const transitLegs = r.legs.filter(
    (l): l is BusLeg | MetroLeg | ThsrLeg | TraLeg => l.type !== "WALK",
  );
  if (transitLegs.length === 0) return "";
  return transitLegs.map(transitLegKey).join("::");
}

function deduplicateRoutes(routes: AccessibleRoute[]): AccessibleRoute[] {
  const seen = new Set<string>();
  return routes.filter((r) => {
    const key = buildRouteKey(r);
    if (key === "") return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Cross-planner normalization key: the GTFS graph and the TDX hosted engine can
 * emit the SAME bus line snapped to different stop pairs, which survives the
 * stop-level dedup above as two near-identical candidates. Keys a bus leg at the
 * line level (routeName + direction); rail legs keep their stop-pair identity.
 *
 * @param leg Transit leg to derive a logical key for.
 * @returns The logical leg key.
 */
function logicalLegKey(leg: BusLeg | MetroLeg | ThsrLeg | TraLeg): string {
  return leg.type === "BUS"
    ? `BUS|${leg.routeName}|${leg.direction}`
    : transitLegKey(leg);
}

function collapseLogicalDuplicates(
  routes: AccessibleRoute[],
): AccessibleRoute[] {
  const best = new Map<string, AccessibleRoute>();
  const walkOnly: AccessibleRoute[] = [];
  for (const r of routes) {
    const transitLegs = r.legs.filter(
      (l): l is BusLeg | MetroLeg | ThsrLeg | TraLeg => l.type !== "WALK",
    );
    if (!transitLegs.length) {
      walkOnly.push(r);
      continue;
    }
    const key = transitLegs.map(logicalLegKey).join("::");
    const prev = best.get(key);
    if (!prev || r.totalMinutes < prev.totalMinutes) best.set(key, r);
  }
  return [...best.values(), ...walkOnly];
}

/**
 * Unified a11y enrichment over the FINAL top routes. Planners that skip internal
 * enrichment (OTP) get their transit legs' OsmA11y arrays, route highlights and
 * rail-leg indoor guidance filled here, so per-request Mongo work is top-3 ×
 * stops instead of every-candidate × stops. Legs already enriched by their
 * planner are left untouched. Best-effort and non-throwing.
 *
 * @param routes Top routes to enrich in place.
 * @param origin Journey origin coordinates.
 * @param destination Journey destination coordinates.
 * @param mode Accessibility mode used for indoor guidance.
 */
async function enrichTopRoutes(
  routes: AccessibleRoute[],
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  mode: AccessibilityMode,
): Promise<void> {
  const { nearbyA11y, attachA11yToLeg, deriveHighlights, enrichLegIndoor } =
    await import("./planners/route-a11y");

  const originCoords: [number, number] = [origin.lng, origin.lat];
  const destCoords: [number, number] = [destination.lng, destination.lat];

  const legA11y = (leg: BusLeg | MetroLeg | ThsrLeg | TraLeg) =>
    leg.type === "BUS"
      ? { board: leg.departureStopA11y, alight: leg.arrivalStopA11y }
      : { board: leg.departureStationA11y, alight: leg.arrivalStationA11y };

  await Promise.all(
    routes.map(async (route) => {
      const transitLegs = route.legs.filter(
        (l): l is BusLeg | MetroLeg | ThsrLeg | TraLeg => l.type !== "WALK",
      );
      if (!transitLegs.length) return;

      await Promise.all(
        transitLegs.map(async (leg) => {
          const { board, alight } = legA11y(leg);
          const boardCoords = leg.polyline[0];
          const alightCoords = leg.polyline[leg.polyline.length - 1];
          if (
            (!board.length || !alight.length) &&
            boardCoords &&
            alightCoords
          ) {
            const [boardA11y, alightA11y] = await Promise.all([
              board.length ? Promise.resolve(board) : nearbyA11y(boardCoords),
              alight.length
                ? Promise.resolve(alight)
                : nearbyA11y(alightCoords),
            ]);
            attachA11yToLeg(leg, boardA11y, alightA11y);
          }

          if (
            leg.type !== "BUS" &&
            leg.facilityHighlights.length === 0 &&
            boardCoords &&
            alightCoords
          ) {
            const legIdx = route.legs.indexOf(leg);
            const prev = route.legs[legIdx - 1];
            const next = route.legs[legIdx + 1];
            await enrichLegIndoor(
              leg,
              prev?.type === "WALK" ? prev : null,
              next?.type === "WALK" ? next : null,
              originCoords,
              destCoords,
              boardCoords,
              alightCoords,
              mode,
            );
          }
        }),
      );

      if (!route.accessibilityHighlights.length) {
        const { board } = legA11y(transitLegs[0]);
        const { alight } = legA11y(transitLegs[transitLegs.length - 1]);
        route.accessibilityHighlights = deriveHighlights(board, alight);
      }
    }),
  );
}

/**
 * Shared finalization: dedupe → cross-planner line-level collapse → mode
 * exclusion → mode-aware score + cost ranking → top 3 → unified a11y enrichment
 * (fail-soft) → realtime facility overlay (fail-soft) → realtime transit overlay
 * (bus ETA + TRA delays, fail-soft) → facility slimming (runs LAST so scoring
 * and the overlays see full documents).
 *
 * @param routes Candidate routes to finalize.
 * @param origin Journey origin coordinates.
 * @param destination Journey destination coordinates.
 * @param mode Accessibility mode for exclusion and scoring.
 * @param format Response shape; "compact" dedupes facilities route-level.
 * @param departureTime Departure time used by the realtime transit overlay.
 * @returns The top-3 finalized routes.
 */
async function finalizeRoutes(
  routes: AccessibleRoute[],
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  mode: AccessibilityMode,
  format: "standard" | "compact" = "standard",
  departureTime?: Date,
): Promise<AccessibleRoute[]> {
  const PRERANK_N = 8;
  const t: Record<string, number> = {};
  let t0 = Date.now();
  // Stage 1: cheap accessibility-aware proxy pre-rank (no OSM data) → top-N.
  const candidates = applyModeExclusion(
    collapseLogicalDuplicates(deduplicateRoutes(routes)),
    mode,
  );
  const topN = prerankByProxy(candidates, mode).slice(0, PRERANK_N);
  t.prerank = Date.now() - t0;
  t0 = Date.now();
  // Stage 2: a11y enrichment (Mongo) BEFORE scoring, so facility data is real
  // when scoreRoute runs — otherwise the accessibility budget collapses to 0.
  try {
    await enrichTopRoutes(topN, origin, destination, mode);
  } catch (err) {
    console.warn("[accessible-route] top-N a11y enrichment failed", err);
  }
  t.enrich = Date.now() - t0;
  t0 = Date.now();
  // Stage 3: score with the enriched facility data + rank → final top-3.
  const top = scoreAndRank(topN, mode).slice(0, 3);
  t.rank = Date.now() - t0;
  t0 = Date.now();
  try {
    const { overlayFacilityStatus } =
      await import("./planners/facility-status");
    await overlayFacilityStatus(top, mode);
  } catch (err) {
    console.warn("[accessible-route] facility status overlay failed", err);
  }
  t.facilityOverlay = Date.now() - t0;
  t0 = Date.now();
  try {
    const { overlayRealtimeTransit, recoverRailTrainNos, annotateBusTdxCity } =
      await import("./planners/realtime-transit");
    annotateBusTdxCity(top);
    await recoverRailTrainNos(top).catch(() => undefined);
    await overlayRealtimeTransit(top, { departureTime });
  } catch (err) {
    console.warn("[accessible-route] realtime transit overlay failed", err);
  }
  t.realtimeOverlay = Date.now() - t0;
  slimRoutes(top);
  if (format === "compact") compactRoutes(top);
  console.log("[route-timing] finalize", JSON.stringify(t));
  return top;
}

/**
 * City of a coordinate from the nearest imported bus stop (~10ms local Mongo
 * lookup) instead of Google reverse geocoding (~200–800ms external call).
 *
 * @param lat Latitude.
 * @param lng Longitude.
 * @returns The city name, or null when the DB has no stops (caller falls back
 *   to Google).
 */
export async function resolveCityFromStops(
  lat: number,
  lng: number,
): Promise<string | null> {
  try {
    const stop = await BusStopModel.findOne(nearQuery([lng, lat], 50_000))
      .select("city")
      .lean<{ city?: string }>();
    return stop?.city ?? null;
  } catch {
    return null;
  }
}

export async function planAccessibleRouteFromRequest(
  body: PlanRouteRequest,
): Promise<PlanRouteResult> {
  let { origin, destination } = body;
  const { query, userLocation, maxTransfers, departureTime, format } = body;
  let mode = body.mode;

  let intent: RouteIntent | null = null;
  if (query && (!origin || !destination)) {
    try {
      intent = await parseRouteIntent(query);
    } catch (err) {
      console.error("[accessible-route] intent parsing failed", err);
      return {
        ok: false,
        status: ResponseCode.INTERNAL_ERROR,
        error:
          "語意解析服務暫時無法使用，請稍後再試或直接提供 origin/destination",
      };
    }
    if (!intent) {
      return {
        ok: false,
        status: ResponseCode.INVALID_INPUT,
        error: ERROR_MESSAGE.INTENT_PARSE_FAILED,
      };
    }
    origin =
      intent.from === "current_location"
        ? (userLocation ?? undefined)
        : intent.from;
    destination = intent.to;
    mode = mode ?? intent.mode;
    if (!origin) {
      return {
        ok: false,
        status: ResponseCode.INVALID_INPUT,
        error: "查詢使用了『目前位置』，請一併提供 userLocation 座標",
      };
    }
  }

  if (!origin || !destination) {
    return {
      ok: false,
      status: ResponseCode.INVALID_INPUT,
      error: `${ERROR_MESSAGE.MISSING_PARAMS}：origin, destination`,
    };
  }

  const tGeo = Date.now();
  const [originCoords, destCoords] = await Promise.all([
    typeof origin === "string"
      ? getCoordinates(origin)
      : Promise.resolve(origin as { latitude: number; longitude: number }),
    typeof destination === "string"
      ? getCoordinates(destination)
      : Promise.resolve(destination as { latitude: number; longitude: number }),
  ]);
  const geocodeMs = Date.now() - tGeo;
  if (!originCoords || !destCoords) {
    return {
      ok: false,
      status: ResponseCode.INVALID_INPUT,
      error: "無法解析出發地或目的地座標",
    };
  }

  const lat = originCoords.latitude;
  const lng = originCoords.longitude;

  const tCity = Date.now();
  const city = ((await resolveCityFromStops(lat, lng)) ??
    (await getCity(lat, lng))) as TaiwanCityEn;
  const cityMs = Date.now() - tCity;

  const parsedDeparture = departureTime ? new Date(departureTime) : undefined;
  const futureDeparture =
    parsedDeparture &&
    !isNaN(parsedDeparture.getTime()) &&
    parsedDeparture.getTime() > Date.now()
      ? parsedDeparture
      : undefined;

  const tPlan = Date.now();
  const routes = await findAccessibleRoutes(
    { lat, lng },
    { lat: destCoords.latitude, lng: destCoords.longitude },
    city,
    {
      mode: mode ?? "normal",
      maxTransfers: (maxTransfers ?? 2) as 0 | 1 | 2,
      departureTime: futureDeparture,
      format: format === "compact" ? "compact" : "standard",
    },
  );
  console.log(
    "[route-timing] request",
    JSON.stringify({
      geocode: geocodeMs,
      city: cityMs,
      plan: Date.now() - tPlan,
    }),
  );

  if (!routes.length) {
    const { isOtpCircuitOpen } = await import("./planners/otp-routing");
    if (isOtpCircuitOpen()) {
      return {
        ok: false,
        status: ResponseCode.SERVICE_UNAVAILABLE,
        error: "路線規劃服務暫時忙線，請稍後再試",
      };
    }
    return {
      ok: false,
      status: ResponseCode.NOT_FOUND,
      error:
        "找不到連通的公車或捷運路線，請嘗試擴大搜尋範圍或確認出發地/目的地",
    };
  }

  return {
    ok: true,
    data: {
      origin: { lat, lng },
      destination: { lat: destCoords.latitude, lng: destCoords.longitude },
      city,
      routes,
      ...(intent ? { intent } : {}),
    },
  };
}

export async function findAccessibleRoutes(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  _city: TaiwanCityEn,
  opts: FindAccessibleRoutesOptions = {},
): Promise<AccessibleRoute[]> {
  const mode = opts.mode ?? "normal";
  const maxTransfers = opts.maxTransfers ?? 1;
  const planT: Record<string, number> = {};
  const t0 = Date.now();

  const otpRoutes = await import("./planners/otp-routing")
    .then((m) =>
      m.planOtpRoute(origin, destination, {
        maxTransfers,
        mode,
        departureTime: opts.departureTime,
      }),
    )
    .catch((): AccessibleRoute[] => []);

  planT.otp = Date.now() - t0;
  console.log("[route-timing] planners", JSON.stringify(planT));
  if (!otpRoutes.length) return [];

  return finalizeRoutes(
    otpRoutes,
    origin,
    destination,
    mode,
    opts.format,
    opts.departureTime,
  );
}
