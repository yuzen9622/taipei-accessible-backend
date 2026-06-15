/**
 * Realtime transit overlay (Functional Spec Phase 15).
 *
 * After route planning has produced the final top-3, this service overlays
 * live TDX data onto transit legs — schedule-built routes become realtime:
 *
 *  • BUS — the FIRST transit leg of each route gets its scheduled wait
 *    replaced by the TDX EstimatedTimeOfArrival for that stop (the rider is
 *    standing there NOW; later legs board in the future, where an ETA is
 *    meaningless and the timetable stays authoritative). departureTime /
 *    arrivalTime shift to now + ETA (scheduled ride duration preserved) so
 *    the leg never mixes schedule clock times with a realtime wait; without
 *    a live ETA the leg stays fully schedule-based. The endpoint is
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
 * MaaS rail legs (TRA + THSR) have no realtime delay API, but their train
 * number, type and real schedule are recovered from the OD daily timetable by
 * recoverRailTrainNos — a separate schedule-based pass that runs even outside
 * the realtime window (it also snaps MaaS schedule drift to the real train).
 *
 * Realtime only makes sense for "departing now": the overlay is skipped when
 * the requested departureTime is more than 15 minutes from now, and for
 * routes rolled to the next service day (departureDate set). Entirely
 * fail-soft: responses are cached 30 s, every error is swallowed — a TDX
 * outage never degrades routing. Disable with USE_REALTIME_TRANSIT=false.
 */

import { tdxFetch } from "../../../config/fetch";
import { busUrl, trainUrl, traUrl, thsrUrl } from "../../../config/transit";
import { fetchRailLegGeometry } from "./otp-routing";
import { gtfsTimeToSeconds, secondsToHHmm } from "./gtfs-time";
import { taipeiSecondsOfDay, taipeiYmdDash } from "../../../config/taipei-time";
import type {
  AccessibleRoute,
  BusLeg,
  TraLeg,
  ThsrLeg,
} from "../../../types/route";

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

// Entries are only lazily expired on read (cachedEntry above), so a key that is
// written once and never read again would live forever — over a long-running
// process the high-cardinality caches (etaCache keyed by route×stop URL,
// odCache by from|to|date) grow without bound. Cap the size and evict the
// oldest on write; Map keeps insertion order, and deleting-then-setting an
// existing key moves it to the most-recent slot (LRU-ish).
const MAX_CACHE_ENTRIES = 5_000;

function cacheSet<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  entry: CacheEntry<T>
): void {
  cache.delete(key);
  cache.set(key, entry);
  if (cache.size > MAX_CACHE_ENTRIES) {
    for (const oldest of cache.keys()) {
      cache.delete(oldest);
      if (cache.size <= MAX_CACHE_ENTRIES) break;
    }
  }
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
    cacheSet(etaCache, url, {
      data: records,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
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

/**
 * Once the wait is live, the scheduled clock times no longer describe the bus
 * the rider will actually board — shift departure to now + ETA and preserve
 * the scheduled ride duration, so a leg is either fully schedule-based or
 * fully realtime, never a mix of both.
 */
function shiftLegToLiveEta(leg: BusLeg, etaSec: number): void {
  if (!leg.departureTime || !leg.arrivalTime) return;
  const depSec = gtfsTimeToSeconds(leg.departureTime);
  const arrSec = gtfsTimeToSeconds(leg.arrivalTime);
  if (isNaN(depSec) || isNaN(arrSec)) return;
  const rideSec = arrSec >= depSec ? arrSec - depSec : arrSec + 86400 - depSec;
  const nowSec = taipeiSecondsOfDay();
  leg.departureTime = secondsToHHmm(nowSec + etaSec);
  leg.arrivalTime = secondsToHHmm(nowSec + etaSec + rideSec);
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
    const prevWait = leg.estimatedWaitMinutes;
    const minutes = Math.round(pick.est / 60);
    leg.waitInfo = { time: minutes, source: "realtime" };
    leg.estimatedWaitMinutes = minutes;
    shiftLegToLiveEta(leg, pick.est);
    // Single-leg routes end when this bus does, so the wait delta flows into
    // the total. Transfer routes stay anchored to leg 2's schedule: arriving
    // at the hub earlier just means waiting there longer.
    if (route.transferCount === 0) {
      route.totalMinutes = Math.max(
        1,
        route.totalMinutes - prevWait + minutes,
      );
    }
    return;
  }

  // No live bus in any direction. StopStatus 3 = 末班車已過, 4 = 今日未營運 —
  // warn only when every direction agrees (a one-sided 3/4 might be the
  // opposite direction's record). StopStatus 1 (尚未發車) → schedule stays.
  if (
    boards.length &&
    boards.every((b) => b.StopStatus === 3 || b.StopStatus === 4)
  ) {
    leg.waitInfo = { time: null, source: "unavailable" };
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
  DailyTrainInfo?: { TrainNo?: string; TrainTypeName?: { Zh_tw?: string } };
  OriginStopTime?: { DepartureTime?: string };
  DestinationStopTime?: { ArrivalTime?: string };
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
    cacheSet(odCache, key, {
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
  const timetable = await fetchOdTimetable(from, to, taipeiYmdDash());
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
      const minutes = leg.estimatedWaitMinutes + delay;
      leg.waitInfo = { time: minutes, source: "realtime" };
      leg.estimatedWaitMinutes = minutes;
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
      leg.waitInfo = { time: leg.estimatedWaitMinutes, source: "realtime" };
    }
  }
}

// ── THSR station index + OD timetable (used by recoverRailTrainNos) ──────────

interface TdxThsrStation {
  StationID: string;
  StationName?: { Zh_tw?: string };
}
interface TdxThsrOdItem {
  DailyTrainInfo?: { TrainNo?: string };
  OriginStopTime?: { DepartureTime?: string };
  DestinationStopTime?: { ArrivalTime?: string };
}

let thsrStationCache: CacheEntry<Map<string, string>> | null = null;
const thsrOdCache = new Map<string, CacheEntry<TdxThsrOdItem[]>>();

/** THSR station name → StationID (12 stations, one cached call). */
async function thsrStationIndex(): Promise<Map<string, string>> {
  if (thsrStationCache && Date.now() < thsrStationCache.expiresAt) {
    return thsrStationCache.data;
  }
  return dedup("thsr-stations", async () => {
    const index = new Map<string, string>();
    try {
      const resp = await tdxFetch(
        `${thsrUrl.stationUrl}?$format=JSON&$select=StationID,StationName`
      );
      if (resp.ok) {
        const items = (await resp.json()) as TdxThsrStation[];
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
    thsrStationCache = {
      data: index,
      expiresAt:
        Date.now() + (index.size ? STATION_CACHE_TTL_MS : FAILURE_CACHE_TTL_MS),
    };
    return index;
  });
}

async function fetchThsrOdTimetable(
  from: string,
  to: string,
  date: string
): Promise<TdxThsrOdItem[]> {
  const key = `${from}|${to}|${date}`;
  const hit = cachedEntry(thsrOdCache, key);
  if (hit) return hit;
  return dedup(`thsr-od|${key}`, async () => {
    let items: TdxThsrOdItem[] = [];
    try {
      const resp = await tdxFetch(
        `${thsrUrl.dailyTimetableOdUrl(from, to, date)}?$format=JSON`
      );
      if (resp.ok) {
        const data = (await resp.json()) as TdxThsrOdItem[];
        if (Array.isArray(data)) items = data;
      }
    } catch {
      /* fail-soft: empty timetable */
    }
    cacheSet(thsrOdCache, key, {
      data: items,
      expiresAt:
        Date.now() + (items.length ? OD_CACHE_TTL_MS : FAILURE_CACHE_TTL_MS),
    });
    return items;
  });
}

// ── Rail (TRA + THSR): MaaS trainNo / time / UID recovery ────────────────────
//
// MaaS-built rail legs carry no train number (trainNo falls back to a line
// label like "北湖-嘉義"), hold station NAMES in the UID fields, and — because
// the MaaS engine's internal schedule DRIFTS from TDX's live timetable — often
// quote a departure clock with no matching train (e.g. "21:26" when the real
// trains are 21:22 / 21:30). Recovery: map station names → StationID (fixes the
// UIDs), then snap the MaaS clock to a real train in the OD daily timetable —
// exact minute if it exists, else the nearest BOARDABLE train within ±10 min —
// and adopt that train's number, type and real departure/arrival times. GTFS
// (OTP) legs already carry a numeric trainNo + real UIDs, so are skipped.

const RAIL_DRIFT_WINDOW_MIN = 10;

/** Minutes-of-day of an "HH:mm" clock (NaN-safe via gtfsTimeToSeconds). */
function clockMinutes(hhmm: string): number {
  return Math.round(gtfsTimeToSeconds(hhmm) / 60);
}

// Real track geometry for a rail OD, cached by station pair (geometry is
// stable). Empty array = "OTP had nothing" (cached briefly so one miss doesn't
// re-hit OTP every request); ≥2 points = the corridor to draw.
const railGeometryCache = new Map<string, CacheEntry<[number, number][]>>();

async function railGeometry(
  system: "TRA" | "THSR",
  fromId: string,
  toId: string,
  straight: [number, number][],
  date: string,
): Promise<[number, number][]> {
  const key = `${system}|${fromId}|${toId}`;
  const hit = cachedEntry(railGeometryCache, key);
  if (hit) return hit;
  return dedup(`railgeom|${key}`, async () => {
    // The MaaS leg's straight polyline already starts/ends at the two stations.
    const a = straight[0];
    const b = straight[straight.length - 1];
    const geo =
      (await fetchRailLegGeometry(
        { lat: a[1], lng: a[0] },
        { lat: b[1], lng: b[0] },
        date,
        "12:00", // geometry is time-independent; midday guarantees service
      ).catch(() => null)) ?? [];
    cacheSet(railGeometryCache, key, {
      data: geo,
      expiresAt:
        Date.now() + (geo.length >= 2 ? OD_CACHE_TTL_MS : FAILURE_CACHE_TTL_MS),
    });
    return geo;
  });
}

interface RailOdRow {
  DailyTrainInfo?: { TrainNo?: string; TrainTypeName?: { Zh_tw?: string } };
  OriginStopTime?: { DepartureTime?: string };
  DestinationStopTime?: { ArrivalTime?: string };
}
interface RailMatch {
  trainNo: string;
  trainType?: string;
  dep: string; // "HH:mm"
  arr: string; // "HH:mm"
}

/**
 * Pick the train for a (possibly drifted) MaaS departure clock: an exact minute
 * match always wins; otherwise the nearest train within ±RAIL_DRIFT_WINDOW_MIN,
 * preferring a BOARDABLE one (departing at/after the wanted clock) over an
 * already-departed one. null when nothing is within the window — we never
 * attribute an arbitrary far-off train (spec: no fuzzy match), so the leg then
 * keeps its schedule untouched.
 */
function snapToTrain(rows: RailOdRow[], wantHHmm: string): RailMatch | null {
  const want = clockMinutes(wantHHmm);
  let best: { row: RailOdRow; diff: number } | null = null;
  for (const row of rows) {
    const dep = (row.OriginStopTime?.DepartureTime ?? "").slice(0, 5);
    if (!/^\d\d:\d\d$/.test(dep) || !row.DailyTrainInfo?.TrainNo) continue;
    const diff = clockMinutes(dep) - want;
    if (diff === 0) {
      best = { row, diff };
      break; // exact — can't do better
    }
    if (Math.abs(diff) > RAIL_DRIFT_WINDOW_MIN) continue;
    const better =
      !best ||
      (diff >= 0 && best.diff < 0) || // boardable beats already-departed
      (Math.sign(diff) === Math.sign(best.diff) &&
        Math.abs(diff) < Math.abs(best.diff)); // same side → nearest
    if (better) best = { row, diff };
  }
  if (!best) return null;
  const { DailyTrainInfo, OriginStopTime, DestinationStopTime } = best.row;
  const trainNo = DailyTrainInfo?.TrainNo;
  if (!trainNo) return null;
  return {
    trainNo,
    trainType: DailyTrainInfo?.TrainTypeName?.Zh_tw,
    dep: (OriginStopTime?.DepartureTime ?? "").slice(0, 5),
    arr: (DestinationStopTime?.ArrivalTime ?? "").slice(0, 5),
  };
}

/**
 * Recover one MaaS rail leg in place: fix the station UIDs, then snap trainNo /
 * trainType / times to a real train. Fail-soft — an unresolvable leg is left
 * exactly as it was.
 */
async function recoverRailLeg(
  leg: TraLeg | ThsrLeg,
  date: string,
  index: Map<string, string>,
  fetchOd: (from: string, to: string, date: string) => Promise<RailOdRow[]>,
): Promise<void> {
  if (/^\d+$/.test(leg.trainNo)) return; // GTFS leg — already a real number
  if (!leg.departureStation || !leg.arrivalStation || !leg.departureTime) return;
  const from = index.get(normStation(leg.departureStation));
  const to = index.get(normStation(leg.arrivalStation));
  if (!from || !to) return;
  // MaaS stored station names in the UID fields — backfill the real StationIDs.
  leg.departureStationUID = from;
  leg.arrivalStationUID = to;

  // Replace the MaaS straight-line polyline with the real track corridor from
  // OTP (independent of the train snap below — only needs the station pair).
  if (leg.polyline.length >= 2) {
    const geo = await railGeometry(leg.type, from, to, leg.polyline, date);
    if (geo.length >= 2) leg.polyline = geo;
  }

  const match = snapToTrain(await fetchOd(from, to, date), leg.departureTime);
  if (!match) return;
  leg.trainNo = match.trainNo;
  if (leg.type === "TRA" && match.trainType) leg.trainTypeName = match.trainType;

  // Drift: the MaaS clock had no exact train — adopt the real train's schedule
  // (the rider's actual times) and flag it. Itinerary-level timing/transfers
  // are NOT re-validated — a corrected mid-route leg can desync from neighbours.
  if (match.dep && match.dep !== leg.departureTime) {
    pushUnique(
      leg.facilityHighlights,
      `🕒 已對應實際班次 ${match.trainNo}（表訂 ${leg.departureTime} → 實際 ${match.dep}）`,
    );
    leg.departureTime = match.dep;
    if (match.arr) {
      leg.arrivalTime = match.arr;
      leg.rideMinutes = Math.max(
        1,
        clockMinutes(match.arr) - clockMinutes(match.dep),
      );
    }
    if (leg.waitInfo.source === "schedule") {
      leg.waitInfo = { time: match.dep, source: "schedule" };
    }
  }
}

/**
 * Recover real TRA + THSR train numbers / times / station UIDs on the final
 * routes, in place. Schedule-based (not realtime), so — unlike
 * overlayRealtimeTransit — it runs regardless of how far the departure is from
 * now and for next-day routes (departureDate → that day's OD timetable).
 * Fail-soft; skipped entirely when USE_REALTIME_TRANSIT=false (it hits TDX).
 */
export async function recoverRailTrainNos(
  routes: AccessibleRoute[],
): Promise<void> {
  if (process.env.USE_REALTIME_TRANSIT === "false") return;
  const hasTra = routes.some((r) => r.legs.some((l) => l.type === "TRA"));
  const hasThsr = routes.some((r) => r.legs.some((l) => l.type === "THSR"));
  if (!hasTra && !hasThsr) return;
  // Station indexes are cached 6 h — fetch (at most) once each, up front.
  const [traIdx, thsrIdx] = await Promise.all([
    hasTra ? traStationIndex() : Promise.resolve(null),
    hasThsr ? thsrStationIndex() : Promise.resolve(null),
  ]);
  await Promise.all(
    routes.flatMap((r) => {
      const date = r.departureDate ?? taipeiYmdDash();
      return r.legs.map((leg) => {
        if (leg.type === "TRA" && traIdx) {
          return recoverRailLeg(leg, date, traIdx, fetchOdTimetable).catch(
            () => undefined,
          );
        }
        if (leg.type === "THSR" && thsrIdx) {
          return recoverRailLeg(leg, date, thsrIdx, fetchThsrOdTimetable).catch(
            () => undefined,
          );
        }
        return Promise.resolve();
      });
    }),
  );
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
