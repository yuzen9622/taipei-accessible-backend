/**
 * Realtime transit overlay (Functional Spec Phase 15).
 *
 * After route planning has produced the final top-3, this service overlays
 * live TDX data onto transit legs — schedule-built routes become realtime:
 *
 *  • BUS — the FIRST transit leg of each route gets its scheduled wait
 *    replaced by the TDX EstimatedTimeOfArrival for that stop (the rider is
 *    standing there NOW; later legs board in the future, where an ETA is
 *    meaningless and the timetable stays authoritative). The endpoint is
 *    chosen by the GTFS stop-id prefix: THB_ → intercity (公路客運),
 *    city codes (TPE/NWT/TXG/…) → the per-city ETA endpoint.
 *  • TRA — v3 TrainLiveBoard reports the delay of every currently-running
 *    train. Delays follow the train, so they apply to EVERY TRA leg whose
 *    TrainNo is on the board: waitInfo gains the delay (source "realtime"),
 *    the leg and route get a「列車誤點」warning, and the route's totalMinutes
 *    absorbs the first delayed leg's delay (downstream legs ride the same
 *    shifted timetable). A train on the board with DelayTime 0 upgrades its
 *    legs to source "realtime" — the schedule is live-confirmed.
 *
 * Honest limits (spec Phase 15): TDX exposes no per-train realtime ETA/delay
 * for metro or THSR — metro headways (2–6 min) are already approximated by
 * headway/2 and THSR is near-punctual; disruptions there surface via the
 * Phase 13 Alert overlay. Legacy-path BUS legs already carry a live ETA
 * (fetchWaitInfo) — legs whose waitInfo.source is "realtime" are skipped.
 *
 * Realtime only makes sense for "departing now": the overlay is skipped when
 * the requested departureTime is more than 15 minutes from now, and for
 * routes rolled to the next service day (departureDate set). Entirely
 * fail-soft: responses are cached 30 s, every error is swallowed — a TDX
 * outage never degrades routing. Disable with USE_REALTIME_TRANSIT=false.
 */

import { tdxFetch } from "../config/fetch";
import { busUrl, trainUrl } from "../config/transit";
import type {
  AccessibleRoute,
  BusLeg,
  TraLeg,
} from "../modules/accessible-route/accessible-route.service";

const CACHE_TTL_MS = 30 * 1000;
const MAX_DEPARTURE_SKEW_MS = 15 * 60 * 1000;

/** GTFS stop-id prefix → TDX City path segment (THB is handled separately). */
const CITY_BY_STOP_PREFIX: Record<string, string> = {
  TPE: "Taipei",
  NWT: "NewTaipei",
  TAO: "Taoyuan",
  TXG: "Taichung",
  TNN: "Tainan",
  KHH: "Kaohsiung",
  KEE: "Keelung",
  HSZ: "Hsinchu",
  HSQ: "HsinchuCounty",
  MIA: "MiaoliCounty",
  CHA: "ChanghuaCounty",
  NAN: "NantouCounty",
  YUN: "YunlinCounty",
  CYQ: "ChiayiCounty",
  CYI: "Chiayi",
  PIF: "PingtungCounty",
  ILA: "YilanCounty",
  HUA: "HualienCounty",
  TTT: "TaitungCounty",
  KIN: "KinmenCounty",
  PEN: "PenghuCounty",
  LIE: "LienchiangCounty",
};

// ── TDX shapes ────────────────────────────────────────────────────────────────

interface TdxEtaRecord {
  EstimateTime?: number | null; // seconds
  StopStatus?: number; // 3 = 末班車已過, 4 = 今日未營運
  StopName?: { Zh_tw?: string };
  Direction?: number;
}

/** One train of /v3/Rail/TRA/TrainLiveBoard (v3 wraps items in an envelope). */
interface TdxTrainLiveBoardItem {
  TrainNo?: string;
  DelayTime?: number; // minutes
}
interface TdxTrainLiveBoardEnvelope {
  TrainLiveBoards?: TdxTrainLiveBoardItem[];
}

// ── Caches ───────────────────────────────────────────────────────────────────

type CacheEntry<T> = { data: T; expiresAt: number };
const etaCache = new Map<string, CacheEntry<TdxEtaRecord[]>>();
let liveBoardCache: CacheEntry<Map<string, number>> | null = null;

// ── BUS: first-leg ETA ───────────────────────────────────────────────────────

/** Leading system code of a GTFS bus stop id — no separator ("TXG2646" → "TXG"). */
function stopPrefix(id: string | undefined): string | null {
  if (!id) return null;
  const m = id.match(/^[A-Z]+/);
  return m ? m[0] : null;
}

/**
 * ETA endpoint for a GTFS-built bus leg, or null when it cannot be derived.
 * Queries BOTH stops and BOTH directions: GTFS direction_id does not reliably
 * map onto TDX Direction (verified live: 860 at 三芝 — GTFS says 0, the bus
 * actually heading there is TDX Direction 1), so the direction is resolved
 * from the data instead (board ETA < alight ETA for the same run).
 */
function etaUrl(leg: BusLeg): string | null {
  const prefix = stopPrefix(leg.departureStopId);
  if (!prefix || !leg.routeName || !leg.departureStop || !leg.arrivalStop) {
    return null;
  }
  // stopName must NOT be encodeURIComponent'd — TDX OData filter expects raw UTF-8
  const query =
    `?$format=JSON&$filter=contains(StopName/Zh_tw,'${leg.departureStop}')` +
    ` or contains(StopName/Zh_tw,'${leg.arrivalStop}')`;
  if (prefix === "THB") {
    return `${busUrl.interCityEstimatedTimeOfArrivalUrl}/${leg.routeName}${query}`;
  }
  const city = CITY_BY_STOP_PREFIX[prefix];
  if (!city) return null;
  return `${busUrl.cityEstimatedTimeOfArrivalUrl}/${city}/${leg.routeName}${query}`;
}

async function fetchEtaRecords(url: string): Promise<TdxEtaRecord[]> {
  const hit = etaCache.get(url);
  if (hit && Date.now() < hit.expiresAt) return hit.data;
  let records: TdxEtaRecord[] = [];
  try {
    const resp = await tdxFetch(url);
    if (resp.ok) {
      const data = (await resp.json()) as TdxEtaRecord[];
      if (Array.isArray(data)) records = data;
    }
  } catch {
    /* fail-soft: empty list */
  }
  etaCache.set(url, { data: records, expiresAt: Date.now() + CACHE_TTL_MS });
  return records;
}

function pushUnique(arr: string[], text: string): void {
  if (!arr.includes(text)) arr.push(text);
}

/** First non-WALK leg — the only boarding that happens "now". */
function firstTransitLeg(route: AccessibleRoute) {
  return route.legs.find((l) => l.type !== "WALK");
}

/** Record for `name`, preferring an exact StopName match over contains(). */
function recordForStop(
  records: TdxEtaRecord[],
  name: string,
  direction: number,
): TdxEtaRecord | undefined {
  const inDir = records.filter((r) => r.Direction === direction);
  return (
    inDir.find((r) => r.StopName?.Zh_tw === name) ??
    inDir.find((r) => r.StopName?.Zh_tw?.includes(name))
  );
}

async function overlayBusEta(route: AccessibleRoute): Promise<void> {
  const leg = firstTransitLeg(route);
  if (!leg || leg.type !== "BUS") return;
  if (leg.waitInfo.source === "realtime") return; // legacy path already live
  const url = etaUrl(leg);
  if (!url) return;

  const records = await fetchEtaRecords(url);
  if (!records.length) return;

  // Resolve the true direction: a bus we can board has an ETA at the board
  // stop AND a larger one at the alight stop (same run, downstream).
  const candidates: { est: number; dir: number }[] = [];
  const boards: TdxEtaRecord[] = [];
  for (const dir of [0, 1]) {
    const board = recordForStop(records, leg.departureStop, dir);
    if (!board) continue;
    boards.push(board);
    if (board.EstimateTime == null || board.EstimateTime < 0) continue;
    const alight = recordForStop(records, leg.arrivalStop, dir);
    if (
      alight &&
      alight.EstimateTime != null &&
      alight.EstimateTime <= board.EstimateTime
    ) {
      continue; // bus passes the alight stop first — opposite direction
    }
    candidates.push({ est: board.EstimateTime, dir });
  }

  if (candidates.length) {
    // Both plausible (circular route / missing alight data): trust GTFS.
    const pick =
      candidates.find((c) => c.dir === leg.direction) ?? candidates[0];
    const minutes = Math.round(pick.est / 60);
    leg.waitInfo = { minutes, source: "realtime" };
    leg.estimatedWaitMinutes = minutes;
    return;
  }

  // No live bus in any direction. StopStatus 3 = 末班車已過, 4 = 今日未營運 —
  // warn only when every direction agrees (a one-sided 3/4 might be the
  // opposite direction's record). StopStatus 1 (尚未發車) → schedule stays.
  if (
    boards.length &&
    boards.every((b) => b.StopStatus === 3 || b.StopStatus === 4)
  ) {
    leg.waitInfo = { minutes: null, source: "unavailable" };
    leg.estimatedWaitMinutes = 0;
    pushUnique(
      route.accessibilityHighlights,
      `⚠️ 公車「${leg.routeName}」即時資訊顯示${
        boards[0].StopStatus === 3 ? "末班車已過" : "今日未營運"
      }，請確認時刻表`,
    );
  }
}

// ── TRA: TrainLiveBoard delays ───────────────────────────────────────────────

/** TrainNo → DelayTime (minutes) for every currently-running TRA train. */
async function fetchTrainDelays(): Promise<Map<string, number>> {
  if (liveBoardCache && Date.now() < liveBoardCache.expiresAt) {
    return liveBoardCache.data;
  }
  const delays = new Map<string, number>();
  try {
    const resp = await tdxFetch(`${trainUrl.trainLiveBoardUrl}?$format=JSON`);
    if (resp.ok) {
      const data = (await resp.json()) as
        | TdxTrainLiveBoardEnvelope
        | TdxTrainLiveBoardItem[];
      const items = Array.isArray(data) ? data : data?.TrainLiveBoards ?? [];
      for (const item of items) {
        if (item?.TrainNo) delays.set(item.TrainNo, item.DelayTime ?? 0);
      }
    }
  } catch {
    /* fail-soft: empty board */
  }
  liveBoardCache = { data: delays, expiresAt: Date.now() + CACHE_TTL_MS };
  return delays;
}

function applyTraDelays(
  route: AccessibleRoute,
  delays: Map<string, number>,
): void {
  let totalAdjusted = false;
  for (const leg of route.legs) {
    if (leg.type !== "TRA") continue;
    const delay = delays.get((leg as TraLeg).trainNo);
    if (delay === undefined) continue; // not on the board (not running yet) — no signal

    if (delay > 0) {
      leg.waitInfo = {
        minutes: (leg.waitInfo.minutes ?? 0) + delay,
        source: "realtime",
      };
      leg.estimatedWaitMinutes = leg.waitInfo.minutes ?? 0;
      const note = `⚠️ 列車 ${leg.trainNo} 誤點約 ${delay} 分`;
      pushUnique(leg.facilityHighlights, note);
      pushUnique(route.accessibilityHighlights, note);
      // Downstream legs ride the same shifted timetable — count the delay once.
      if (!totalAdjusted) {
        route.totalMinutes += delay;
        totalAdjusted = true;
      }
    } else {
      // On the board with zero delay: the schedule is live-confirmed.
      leg.waitInfo = { ...leg.waitInfo, source: "realtime" };
    }
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Overlay realtime TDX transit data onto the final routes (top-3), in place.
 * Runs in finalizeRoutes() after the facility overlay and before slimming.
 */
export async function overlayRealtimeTransit(
  routes: AccessibleRoute[],
  opts: { departureTime?: Date } = {},
): Promise<void> {
  if (process.env.USE_REALTIME_TRANSIT === "false") return;
  // Realtime is only meaningful for "departing now".
  if (
    opts.departureTime &&
    Math.abs(opts.departureTime.getTime() - Date.now()) > MAX_DEPARTURE_SKEW_MS
  ) {
    return;
  }

  const live = routes.filter((r) => !r.departureDate); // next-day routes: schedule only
  if (!live.length) return;

  const needsTra = live.some((r) => r.legs.some((l) => l.type === "TRA"));
  const [delays] = await Promise.all([
    needsTra ? fetchTrainDelays() : Promise.resolve(null),
    ...live.map((r) => overlayBusEta(r).catch(() => undefined)),
  ]);
  if (delays?.size) {
    for (const route of live) applyTraDelays(route, delays);
  }
}
