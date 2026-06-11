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
 *    chosen by the TDX system code — GTFS legs carry it in the stop-id
 *    prefix ("TXG2646"), MaaS legs in cityCode (from agency_id): THB →
 *    intercity (公路客運), city codes (TPE/NWT/TXG/…) → per-city ETA.
 *  • TRA — v3 TrainLiveBoard reports the delay of every currently-running
 *    train. MaaS legs have no train number (only a line name) — their real
 *    TrainNo is first recovered from the OD daily timetable (departure
 *    station + scheduled "HH:mm", both cached) and backfilled onto the leg.
 *    Delays follow the train, so they apply to EVERY TRA leg whose
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
 * MaaS THSR legs stay schedule-only (no realtime API to overlay anyway).
 *
 * Realtime only makes sense for "departing now": the overlay is skipped when
 * the requested departureTime is more than 15 minutes from now, and for
 * routes rolled to the next service day (departureDate set). Entirely
 * fail-soft: responses are cached 30 s, every error is swallowed — a TDX
 * outage never degrades routing. Disable with USE_REALTIME_TRANSIT=false.
 */

import { tdxFetch } from "../config/fetch";
import { busUrl, trainUrl, traUrl } from "../config/transit";
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

function cachedEntry<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string
): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.data;
}

// Routes are overlaid in parallel and often share lookups (same OD pair, the
// one live board, the one station list). TDX quota is tight — collapse
// concurrent identical fetches into a single in-flight call.
const inflight = new Map<string, Promise<unknown>>();
function dedup<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const current = inflight.get(key);
  if (current) return current as Promise<T>;
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ── BUS: first-leg ETA ───────────────────────────────────────────────────────

/** Leading system code of a GTFS bus stop id — no separator ("TXG2646" → "TXG"). */
function stopPrefix(id: string | undefined): string | null {
  if (!id) return null;
  const m = id.match(/^[A-Z]+/);
  return m ? m[0] : null;
}

/**
 * TDX system code of a bus leg: GTFS legs carry it in the stop-id prefix,
 * TDX MaaS legs in cityCode (derived from agency_id — MaaS has no stop ids).
 */
function busSystemCode(leg: BusLeg): string | null {
  return stopPrefix(leg.departureStopId) ?? leg.cityCode ?? null;
}

/**
 * ETA endpoint for a GTFS-built bus leg, or null when it cannot be derived.
 * Queries BOTH stops and BOTH directions: GTFS direction_id does not reliably
 * map onto TDX Direction (verified live: 860 at 三芝 — GTFS says 0, the bus
 * actually heading there is TDX Direction 1), so the direction is resolved
 * from the data instead (board ETA < alight ETA for the same run).
 */
function etaUrl(leg: BusLeg): string | null {
  const prefix = busSystemCode(leg);
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
  const hit = cachedEntry(etaCache, url);
  if (hit) return hit;
  return dedup(`eta|${url}`, async () => {
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
  });
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

// ── TRA: MaaS trainNo recovery ───────────────────────────────────────────────
//
// MaaS-built TRA legs have no train number (transport.number is empty; trainNo
// falls back to the line name, e.g. "潮州-七堵"). They DO carry station names
// and the scheduled departure time, which identify the train uniquely in the
// TRA OD daily timetable — recover the TrainNo from there.

const STATION_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const OD_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
// An empty result usually means a TDX failure (429/outage) — cache it briefly
// so one bad call doesn't blind TRA realtime for the full 6 h TTL.
const FAILURE_CACHE_TTL_MS = 60 * 1000;

interface TdxTraStation {
  StationID: string;
  StationName?: { Zh_tw?: string };
}
interface TdxTraOdItem {
  DailyTrainInfo?: { TrainNo?: string };
  OriginStopTime?: { DepartureTime?: string };
}

let traStationCache: CacheEntry<Map<string, string>> | null = null;
const odCache = new Map<string, CacheEntry<TdxTraOdItem[]>>();

/** "台中" and "臺中" must hit the same index entry. */
function normStation(name: string): string {
  return name.replace(/台/g, "臺").trim();
}

/** TRA station name → StationID (245 stations, one cached call). */
async function traStationIndex(): Promise<Map<string, string>> {
  if (traStationCache && Date.now() < traStationCache.expiresAt) {
    return traStationCache.data;
  }
  return dedup("tra-stations", async () => {
    const index = new Map<string, string>();
    try {
      const resp = await tdxFetch(
        `${traUrl.stationUrl}?$format=JSON&$select=StationID,StationName`
      );
      if (resp.ok) {
        const items = (await resp.json()) as TdxTraStation[];
        if (Array.isArray(items)) {
          for (const s of items) {
            if (s.StationName?.Zh_tw) {
              index.set(normStation(s.StationName.Zh_tw), s.StationID);
            }
          }
        }
      }
    } catch {
      /* fail-soft: empty index */
    }
    traStationCache = {
      data: index,
      expiresAt:
        Date.now() + (index.size ? STATION_CACHE_TTL_MS : FAILURE_CACHE_TTL_MS),
    };
    return index;
  });
}

async function fetchOdTimetable(
  from: string,
  to: string,
  date: string
): Promise<TdxTraOdItem[]> {
  const key = `${from}|${to}|${date}`;
  const hit = cachedEntry(odCache, key);
  if (hit) return hit;
  return dedup(`od|${key}`, async () => {
    let items: TdxTraOdItem[] = [];
    try {
      const resp = await tdxFetch(
        `${traUrl.dailyTimetableOdUrl(from, to, date)}?$format=JSON`
      );
      if (resp.ok) {
        const data = (await resp.json()) as TdxTraOdItem[];
        if (Array.isArray(data)) items = data;
      }
    } catch {
      /* fail-soft: empty timetable */
    }
    odCache.set(key, {
      data: items,
      expiresAt:
        Date.now() + (items.length ? OD_CACHE_TTL_MS : FAILURE_CACHE_TTL_MS),
    });
    return items;
  });
}

/**
 * Real TrainNo of a TRA leg: GTFS legs already carry it (numeric); MaaS legs
 * are recovered via the OD timetable (departure station + "HH:mm"). Null when
 * unresolvable — the leg then keeps its schedule untouched.
 */
async function resolveTraTrainNo(leg: TraLeg): Promise<string | null> {
  if (/^\d+$/.test(leg.trainNo)) return leg.trainNo;
  if (!leg.departureStation || !leg.arrivalStation || !leg.departureTime) {
    return null;
  }
  const index = await traStationIndex();
  const from = index.get(normStation(leg.departureStation));
  const to = index.get(normStation(leg.arrivalStation));
  if (!from || !to) return null;
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const timetable = await fetchOdTimetable(from, to, date);
  const match = timetable.find(
    (t) => t.OriginStopTime?.DepartureTime === leg.departureTime
  );
  return match?.DailyTrainInfo?.TrainNo ?? null;
}

// ── TRA: TrainLiveBoard delays ───────────────────────────────────────────────

/** TrainNo → DelayTime (minutes) for every currently-running TRA train. */
async function fetchTrainDelays(): Promise<Map<string, number>> {
  if (liveBoardCache && Date.now() < liveBoardCache.expiresAt) {
    return liveBoardCache.data;
  }
  return dedup("tra-live-board", async () => {
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
  });
}

async function applyTraDelays(
  route: AccessibleRoute,
  delays: Map<string, number>,
): Promise<void> {
  let totalAdjusted = false;
  for (const leg of route.legs) {
    if (leg.type !== "TRA") continue;
    const trainNo = await resolveTraTrainNo(leg).catch(() => null);
    if (!trainNo) continue; // unresolvable (MaaS line-name fallback) — no signal
    leg.trainNo = trainNo; // backfill the real number on MaaS legs
    const delay = delays.get(trainNo);
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
    await Promise.all(
      live.map((route) => applyTraDelays(route, delays).catch(() => undefined)),
    );
  }
}
