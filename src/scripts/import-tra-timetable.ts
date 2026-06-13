/**
 * Import the TRA weekly timetable from the TDX API into the GTFS collections,
 * filling the schedule gap in the GTFS feed (TRA has stops but no stop_times).
 *
 *   TDX /Rail/TRA/GeneralTimetable
 *     → GtfsRoute    TRA_<TrainNo>   (routeType 2, agency TRA)
 *     → GtfsTrip     TRA_<TrainNo>   (one trip per train; weekly service)
 *     → GtfsCalendar TRA_<TrainNo>   (weekday booleans from ServiceDay)
 *     → GtfsStopTime                 (stopId = existing GTFS "TRA_<StationID>")
 *
 * Stop ids align with the stops already imported from the GTFS feed
 * (e.g. "TRA_0900" 基隆), so the GTFS router picks TRA up with NO code
 * changes — findNearestGtfsStops keeps schedule-less stations out via a
 * data-driven stop_times check that now succeeds.
 *
 * Overnight trains: clock times that wrap past midnight are converted to the
 * GTFS convention of times exceeding "24:00:00".
 *
 * Re-runnable: previously imported TRA_* docs are replaced atomically per
 * collection (delete by prefix, then insert).
 *
 * Run: npx dotenvx run -- npx ts-node src/scripts/import-tra-timetable.ts
 */

import "dotenv/config";
import mongoose from "mongoose";
import { tdxFetch } from "../config/fetch";
import { traUrl } from "../config/transit";
import { GtfsRoute } from "../model/gtfs-route.model";
import { GtfsTrip } from "../model/gtfs-trip.model";
import { GtfsCalendar } from "../model/gtfs-calendar.model";
import { GtfsStopTime } from "../model/gtfs-stop-time.model";
import { GtfsStop } from "../model/gtfs-stop.model";
import type { TdxTraGeneralTimetableItem } from "../types/transit";

const TRIP_PREFIX = "TRA_";
const BATCH = 1000;

/** Wide validity window — the weekly pattern is refreshed by re-running this script. */
const START_DATE = "20200101";
const END_DATE = "20991231";

/** "HH:MM" / "HH:MM:SS" → seconds, NaN when malformed. */
function toSec(t: string): number {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t ?? "");
  if (!m) return NaN;
  return (
    parseInt(m[1], 10) * 3600 +
    parseInt(m[2], 10) * 60 +
    (m[3] ? parseInt(m[3], 10) : 0)
  );
}

function toHHmmss(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(
    s
  ).padStart(2, "0")}`;
}

interface RawItem extends TdxTraGeneralTimetableItem {
  EffectiveDate?: string; // "YYYY-MM-DD"
  ExpireDate?: string;
}

/** Keep only the timetable version effective today (TDX ships future versions too). */
function isEffectiveToday(item: RawItem, todayIso: string): boolean {
  if (item.EffectiveDate && item.EffectiveDate.slice(0, 10) > todayIso)
    return false;
  if (item.ExpireDate && item.ExpireDate.slice(0, 10) < todayIso) return false;
  return true;
}

async function fetchAllTimetables(): Promise<RawItem[]> {
  const all: RawItem[] = [];
  const PAGE = 500;
  for (let skip = 0; ; skip += PAGE) {
    const url = `${traUrl.generalTimetableUrl}?$format=JSON&$top=${PAGE}&$skip=${skip}`;
    const resp = await tdxFetch(url);
    if (!resp.ok) throw new Error(`TDX ${resp.status} at $skip=${skip}`);
    const page = (await resp.json()) as RawItem[];
    if (!Array.isArray(page) || !page.length) break;
    all.push(...page);
    console.log(`  fetched ${all.length} timetable items...`);
    if (page.length < PAGE) break;
  }
  return all;
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is required");
  await mongoose.connect(dbUrl);
  console.log("Connected to MongoDB");

  // Valid TRA stop ids from the GTFS feed — rows referencing unknown stations
  // (rare data drift) are skipped so the router never sees a dangling stopId.
  const traStops = await GtfsStop.find({ stopId: /^TRA_/ })
    .select("stopId")
    .lean();
  const validStopIds = new Set(traStops.map((s) => s.stopId));
  console.log(`GTFS TRA stops: ${validStopIds.size}`);

  console.log("Fetching TRA GeneralTimetable from TDX...");
  const raw = await fetchAllTimetables();
  const todayIso = new Date().toISOString().slice(0, 10);
  const items = raw.filter((i) => isEffectiveToday(i, todayIso));
  console.log(`${raw.length} items fetched, ${items.length} effective today`);

  const routes: any[] = [];
  const trips: any[] = [];
  const calendars: any[] = [];
  const stopTimes: any[] = [];
  let skippedStops = 0;
  const seenTrainNos = new Set<string>();

  for (const item of items) {
    const gt = item.GeneralTimetable;
    const info = gt?.GeneralTrainInfo;
    if (!info?.TrainNo || !gt.StopTimes?.length) continue;
    if (seenTrainNos.has(info.TrainNo)) continue; // duplicate versions
    seenTrainNos.add(info.TrainNo);

    const id = `${TRIP_PREFIX}${info.TrainNo}`;
    const typeName = info.TrainTypeName?.Zh_tw ?? "列車";

    // Stop times: ordered by sequence; wrap past midnight → +24h offsets.
    const ordered = [...gt.StopTimes].sort(
      (a, b) => a.StopSequence - b.StopSequence
    );
    let dayOffset = 0;
    let prevSec = -1;
    const rows: { stopId: string; seq: number; arr: string; dep: string }[] =
      [];
    let valid = true;
    for (const st of ordered) {
      const stopId = `TRA_${st.StationID}`;
      const arrRaw = toSec(st.ArrivalTime || st.DepartureTime);
      const depRaw = toSec(st.DepartureTime || st.ArrivalTime);
      if (isNaN(arrRaw) || isNaN(depRaw)) {
        valid = false;
        break;
      }
      let arr = arrRaw + dayOffset;
      if (prevSec >= 0 && arr < prevSec) {
        dayOffset += 24 * 3600;
        arr = arrRaw + dayOffset;
      }
      let dep = depRaw + dayOffset;
      if (dep < arr) dep = arr; // same-minute rounding artefacts
      prevSec = dep;
      if (!validStopIds.has(stopId)) {
        skippedStops++;
        continue; // skip the row, keep the trip
      }
      rows.push({
        stopId,
        seq: st.StopSequence,
        arr: toHHmmss(arr),
        dep: toHHmmss(dep),
      });
    }
    if (!valid || rows.length < 2) continue;

    routes.push({
      routeId: id,
      agencyId: "TRA",
      routeShortName: info.TrainNo,
      routeLongName: typeName,
      routeType: 2,
    });
    trips.push({
      tripId: id,
      routeId: id,
      serviceId: id,
      directionId: (info.Direction ?? 0) as 0 | 1,
    });
    const sd = gt.ServiceDay;
    calendars.push({
      serviceId: id,
      monday: sd?.Monday ?? true,
      tuesday: sd?.Tuesday ?? true,
      wednesday: sd?.Wednesday ?? true,
      thursday: sd?.Thursday ?? true,
      friday: sd?.Friday ?? true,
      saturday: sd?.Saturday ?? true,
      sunday: sd?.Sunday ?? true,
      startDate: START_DATE,
      endDate: END_DATE,
      exceptions: [],
    });
    for (const r of rows) {
      stopTimes.push({
        tripId: id,
        stopId: r.stopId,
        stopSequence: r.seq,
        arrivalTime: r.arr,
        departureTime: r.dep,
      });
    }
  }

  console.log(
    `Prepared: ${routes.length} trains, ${stopTimes.length} stop_times` +
      (skippedStops ? ` (${skippedStops} rows skipped: unknown station)` : "")
  );

  // Replace previous TRA import atomically per collection.
  console.log("Deleting previous TRA_* docs...");
  await Promise.all([
    GtfsRoute.deleteMany({ routeId: /^TRA_/ }),
    GtfsTrip.deleteMany({ tripId: /^TRA_/ }),
    GtfsCalendar.deleteMany({ serviceId: /^TRA_/ }),
    GtfsStopTime.deleteMany({ tripId: /^TRA_/ }),
  ]);

  const insertBatches = async (model: mongoose.Model<any>, docs: any[]) => {
    for (let i = 0; i < docs.length; i += BATCH) {
      await model.insertMany(docs.slice(i, i + BATCH), { ordered: false });
    }
  };
  console.log("Inserting...");
  await insertBatches(GtfsRoute, routes);
  await insertBatches(GtfsTrip, trips);
  await insertBatches(GtfsCalendar, calendars);
  await insertBatches(GtfsStopTime, stopTimes);

  console.log(
    `Done: ${routes.length} routes/trips/calendars, ${stopTimes.length} stop_times`
  );
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
