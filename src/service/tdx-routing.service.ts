/**
 * TDX MaaS Routing API client (hybrid coverage for Phase 7).
 *
 * The GTFS router (gtfs-router.service.ts) only covers systems whose schedules
 * exist in the imported GTFS feed (TRTC/KRTC/THSR/TYMC/KLRT + bus). TRA (台鐵),
 * intercity rail, and other gaps are not in that feed. This service calls TDX's
 * hosted multimodal routing engine to fill those gaps, then maps its itineraries
 * into the same AccessibleRoute shape and enriches stops with OsmA11y so the
 * results compete fairly in scoreAndRank().
 *
 * Endpoint (verified live):
 *   GET https://tdx.transportdata.tw/api/maas/routing
 *   ?origin={lat},{lng}&destination={lat},{lng}&gc=1&top=5&transit=3,4,5,6,7,8,9
 *   &depart=yyyy-mm-ddTHH:mm:ss&first_mile_mode=0&last_mile_mode=0
 *
 * Response is HERE-style: data.routes[].sections[], each section either
 * type="pedestrian" or type="transit" with transport.{mode,category,agency} etc.
 * Note: the API returns NO geometry — polylines are approximated from
 * departure → intermediateStops → arrival coordinates.
 */

import { tdxFetch } from "../config/fetch";
import {
  nearbyA11y,
  deriveHighlights,
  attachA11yToLeg,
} from "./gtfs-router.service";
import type {
  AccessibleRoute,
  WalkLeg,
  BusLeg,
  MetroLeg,
  ThsrLeg,
  TraLeg,
} from "../modules/accessible-route/accessible-route.service";

const ROUTING_URL = "https://tdx.transportdata.tw/api/maas/routing";
const METRO_AGENCIES = new Set([
  "TRTC",
  "KRTC",
  "TMRT",
  "NTMC",
  "KLRT",
  "TYMC",
  "NTDLRT",
  "NTALRT",
  "TRTCMG",
]);

// ── Raw response shapes (only fields we consume) ──
interface TdxPlace {
  name?: string;
  type?: string;
  location: { lat: number; lng: number };
}
interface TdxSection {
  type: "pedestrian" | "transit";
  travelSummary?: { duration: number; length: number };
  departure: { time: string; place: TdxPlace };
  arrival: { time: string; place: TdxPlace };
  transport?: {
    mode?: string;
    name?: string;
    category?: string;
    headsign?: string;
    shortName?: string;
    longName?: string;
    number?: string;
    type?: string;
  };
  intermediateStops?: { departure?: { place?: TdxPlace } }[];
  agency?: { agency_id?: string; name?: string };
}
interface TdxRoute {
  travel_time: number;
  start_time: string;
  end_time: string;
  transfers: number;
  sections: TdxSection[];
}

export interface PlanTdxRouteOptions {
  departureTime?: Date;
  /** 0=cheapest … 1=fastest (TDX `gc`). Default 1. */
  preferFastest?: number;
  top?: number;
  /** TDX transit mode codes; default all public modes. */
  transitModes?: string;
}

function hhmm(iso: string): string {
  // "2026-06-10T09:01:00" → "09:01"
  const m = iso.match(/T(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : "";
}

function minutesBetween(a: string, b: string): number {
  const t = (s: string) => new Date(s).getTime();
  return Math.max(1, Math.round((t(b) - t(a)) / 60000));
}

function coord(p: TdxPlace): [number, number] {
  return [p.location.lng, p.location.lat];
}

/** A TDX "transfer wait" placeholder section (same stop, no real ride). */
function isWaitingSection(s: TdxSection): boolean {
  const name = (s.transport?.name ?? s.transport?.shortName ?? "").toUpperCase();
  if (name === "WAITING") return true;
  const len = s.travelSummary?.length ?? 0;
  return len === 0 && s.departure.place.name === s.arrival.place.name;
}

/** A walking segment, even when TDX tags it type="transit" with a pedestrian mode. */
function isPedestrianSection(s: TdxSection): boolean {
  if (s.type === "pedestrian") return true;
  const tag = `${s.transport?.mode ?? ""} ${s.transport?.category ?? ""} ${
    s.transport?.name ?? ""
  }`.toUpperCase();
  return /PEDESTRIAN|WALK|FOOT/.test(tag);
}

/** Approximate a transit polyline from departure → intermediate stops → arrival. */
function sectionPolyline(s: TdxSection): [number, number][] {
  const pts: [number, number][] = [coord(s.departure.place)];
  for (const is of s.intermediateStops ?? []) {
    if (is.departure?.place) pts.push(coord(is.departure.place));
  }
  pts.push(coord(s.arrival.place));
  return pts;
}

/** Build the transit leg variant for a transit section (a11y arrays filled later). */
function transitSectionToLeg(
  s: TdxSection
): BusLeg | MetroLeg | ThsrLeg | TraLeg {
  const t = s.transport ?? {};
  const agencyId = s.agency?.agency_id ?? "";
  const cat = (t.category ?? t.mode ?? t.type ?? "").toUpperCase();
  const fromName = s.departure.place.name ?? "";
  const toName = s.arrival.place.name ?? "";
  const depTime = hhmm(s.departure.time);
  const arrTime = hhmm(s.arrival.time);
  const rideMinutes = minutesBetween(s.departure.time, s.arrival.time);
  const polyline = sectionPolyline(s);
  const lineName = t.name || t.shortName || t.longName || t.number || cat;

  const isThsr = agencyId === "THSR" || cat === "HSR" || cat === "THSR";
  const isTra = agencyId === "TRA" || cat === "TRA" || cat === "RAIL";
  const isMetro = METRO_AGENCIES.has(agencyId) || cat === "MRT" || cat === "METRO" || cat === "LRT";

  if (isThsr) {
    return {
      type: "THSR",
      trainNo: t.number || t.headsign || lineName,
      departureStation: fromName,
      arrivalStation: toName,
      departureStationUID: fromName,
      arrivalStationUID: toName,
      departureTime: depTime,
      arrivalTime: arrTime,
      rideMinutes,
      waitInfo: { minutes: null, source: "schedule" },
      estimatedWaitMinutes: 0,
      polyline,
      departureStationA11y: [],
      arrivalStationA11y: [],
      facilityHighlights: [],
    };
  }
  if (isTra) {
    return {
      type: "TRA",
      trainNo: t.number || lineName,
      trainTypeName: t.name || t.longName || "",
      departureStation: fromName,
      arrivalStation: toName,
      departureStationUID: fromName,
      arrivalStationUID: toName,
      departureTime: depTime,
      arrivalTime: arrTime,
      rideMinutes,
      waitInfo: { minutes: null, source: "schedule" },
      estimatedWaitMinutes: 0,
      polyline,
      departureStationA11y: [],
      arrivalStationA11y: [],
      facilityHighlights: [],
    };
  }
  if (isMetro) {
    return {
      type: "METRO",
      railSystem: agencyId,
      lineName,
      lineUid: t.number || lineName,
      departureStation: fromName,
      arrivalStation: toName,
      departureStationUid: fromName,
      arrivalStationUid: toName,
      direction: 0,
      stopsCount: (s.intermediateStops?.length ?? 0) + 1,
      rideMinutes,
      waitInfo: { minutes: null, source: "schedule" },
      estimatedWaitMinutes: 0,
      polyline,
      departureStationA11y: [],
      arrivalStationA11y: [],
      facilityHighlights: [],
    };
  }
  // default: bus
  return {
    type: "BUS",
    routeName: lineName,
    departureStop: fromName,
    arrivalStop: toName,
    waitInfo: { minutes: null, source: "schedule" },
    estimatedWaitMinutes: 0,
    direction: 0,
    polyline,
    departureStopA11y: [],
    arrivalStopA11y: [],
  };
}

function pedestrianToWalkLeg(s: TdxSection): WalkLeg {
  return {
    type: "WALK",
    from: s.departure.place.name ?? "出發地",
    to: s.arrival.place.name ?? "目的地",
    distanceM: Math.round(s.travelSummary?.length ?? 0),
    minutesEst: Math.max(1, Math.round((s.travelSummary?.duration ?? 0) / 60)),
    polyline: [coord(s.departure.place), coord(s.arrival.place)],
    a11yFacilities: [],
    exitInfo: null,
  };
}

function toIsoLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(
    d.getHours()
  )}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Plan accessible routes via the TDX hosted routing engine, mapped into
 * AccessibleRoute objects and enriched with nearby OsmA11y facilities.
 */
function ymdDash(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export async function planTdxRoute(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  opts?: PlanTdxRouteOptions
): Promise<AccessibleRoute[]> {
  const runOnce = async (
    depart: Date | undefined,
    isNextDay: boolean
  ): Promise<AccessibleRoute[]> => {
  const params = new URLSearchParams({
    origin: `${origin.lat},${origin.lng}`,
    destination: `${destination.lat},${destination.lng}`,
    gc: String(opts?.preferFastest ?? 1),
    top: String(opts?.top ?? 5),
    transit: opts?.transitModes ?? "3,4,5,6,7,8,9",
    first_mile_mode: "0",
    last_mile_mode: "0",
  });
  if (depart) params.set("depart", toIsoLocal(depart));

  const res = await tdxFetch(`${ROUTING_URL}?${params.toString()}`);
  if (!res.ok) return [];
  const json = (await res.json()) as { data?: { routes?: TdxRoute[] } };
  const routes = json.data?.routes ?? [];
  const dateStr = depart ? ymdDash(depart) : "";

  const out: AccessibleRoute[] = [];
  for (const [i, r] of routes.entries()) {
    const legs: (WalkLeg | BusLeg | MetroLeg | ThsrLeg | TraLeg)[] = [];
    const transitLegs: (BusLeg | MetroLeg | ThsrLeg | TraLeg)[] = [];
    const realTransitSections: TdxSection[] = [];

    for (const s of r.sections) {
      if (isWaitingSection(s)) continue; // TDX transfer-wait placeholder, not a leg
      if (isPedestrianSection(s)) {
        // Skip zero-length pedestrian stubs (transfer connectors, no real walk).
        if ((s.travelSummary?.length ?? 0) > 0) legs.push(pedestrianToWalkLeg(s));
        continue;
      }
      const leg = transitSectionToLeg(s);
      legs.push(leg);
      transitLegs.push(leg);
      realTransitSections.push(s);
    }
    if (!transitLegs.length) continue;

    // Enrich each transit leg's board/alight with nearby OsmA11y facilities.
    await Promise.all(
      realTransitSections.map(async (s, idx) => {
        const leg = transitLegs[idx];
        const [boardA11y, alightA11y] = await Promise.all([
          nearbyA11y(coord(s.departure.place)),
          nearbyA11y(coord(s.arrival.place)),
        ]);
        attachA11yToLeg(leg, boardA11y, alightA11y);
      })
    );

    // Route-level highlights from first board + last alight transit stops.
    const firstTransit = realTransitSections[0];
    const lastTransit = realTransitSections[realTransitSections.length - 1];
    const [boardA11y, alightA11y] = await Promise.all([
      nearbyA11y(coord(firstTransit.departure.place)),
      nearbyA11y(coord(lastTransit.arrival.place)),
    ]);

    const routeName = transitLegs
      .map((l) =>
        l.type === "BUS"
          ? l.routeName
          : l.type === "METRO"
          ? l.lineName
          : l.trainNo
      )
      .join(" → ");

    const highlights = deriveHighlights(boardA11y, alightA11y);
    if (isNextDay && dateStr)
      highlights.unshift(`🕒 今日班次已過，顯示 ${dateStr} 最早班次`);

    out.push({
      routeId: `tdx-${i}-${r.start_time}`,
      routeName: routeName || "TDX Route",
      totalMinutes: Math.max(1, Math.round(r.travel_time / 60)),
      transferCount: r.transfers,
      legs,
      accessibilityHighlights: highlights,
      ...(isNextDay && dateStr ? { departureDate: dateStr } : {}),
    });
  }
  return out;
  };

  // Try the caller's time (or now). If nothing comes back, retry at the next
  // service-day morning (05:00). When `now` is before 05:00 that morning is
  // still TODAY (not tomorrow) — so an overnight gap doesn't wrongly skip a day.
  const base = opts?.departureTime ?? new Date();
  const todayRoutes = await runOnce(opts?.departureTime, false);
  if (todayRoutes.length) return todayRoutes;

  const morning = new Date(base);
  morning.setHours(5, 0, 0, 0);
  let isNextDay = false;
  if (morning.getTime() <= base.getTime()) {
    morning.setDate(morning.getDate() + 1);
    isNextDay = true;
  }
  return runOnce(morning, isNextDay);
}
