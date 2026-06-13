/**
 * Import calendar.txt + calendar_dates.txt → GtfsCalendar collection
 * Merges both files: base schedule from calendar.txt, exceptions from calendar_dates.txt
 * Run: npx ts-node src/scripts/import-gtfs-calendar.ts
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import readline from "readline";
import mongoose from "mongoose";
import { GtfsCalendar, IGtfsCalendar } from "../model/gtfs-calendar.model";

const GTFS_DIR = path.resolve(__dirname, "../../data/gtfs");
const BATCH = 1000;

async function readCalendarDates(): Promise<
  Map<string, IGtfsCalendar["exceptions"]>
> {
  const exceptionsMap = new Map<string, IGtfsCalendar["exceptions"]>();
  const filePath = path.join(GTFS_DIR, "calendar_dates.txt");
  if (!fs.existsSync(filePath)) return exceptionsMap;

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  let headers: string[] = [];
  for await (const line of rl) {
    if (!headers.length) {
      headers = line.replace(/^﻿/, "").split(",");
      continue;
    }
    const values = line.split(",");
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = values[i]?.trim() ?? ""));

    const { service_id, date, exception_type } = row;
    if (!service_id) continue;

    if (!exceptionsMap.has(service_id)) exceptionsMap.set(service_id, []);
    exceptionsMap.get(service_id)!.push({
      date,
      exceptionType: parseInt(exception_type, 10) as 1 | 2,
    });
  }

  return exceptionsMap;
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is required");
  await mongoose.connect(dbUrl);
  console.log("Connected to MongoDB");

  console.log("Reading calendar_dates.txt...");
  const exceptionsMap = await readCalendarDates();
  console.log(`  ${exceptionsMap.size} services with exceptions`);

  const filePath = path.join(GTFS_DIR, "calendar.txt");
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  let headers: string[] = [];
  let batch: Parameters<typeof GtfsCalendar.bulkWrite>[0] = [];
  let total = 0;
  const seenInCalendar = new Set<string>();
  const start = Date.now();

  for await (const line of rl) {
    if (!headers.length) {
      headers = line.replace(/^﻿/, "").split(",");
      continue;
    }
    const values = line.split(",");
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = values[i]?.trim() ?? ""));

    if (!row.service_id) continue;
    seenInCalendar.add(row.service_id);

    batch.push({
      updateOne: {
        filter: { serviceId: row.service_id },
        update: {
          $set: {
            serviceId: row.service_id,
            monday: row.monday === "1",
            tuesday: row.tuesday === "1",
            wednesday: row.wednesday === "1",
            thursday: row.thursday === "1",
            friday: row.friday === "1",
            saturday: row.saturday === "1",
            sunday: row.sunday === "1",
            startDate: row.start_date,
            endDate: row.end_date,
            exceptions: exceptionsMap.get(row.service_id) ?? [],
          },
        },
        upsert: true,
      },
    });

    if (batch.length >= BATCH) {
      await GtfsCalendar.bulkWrite(batch, { ordered: false });
      total += batch.length;
      batch = [];
    }
  }

  if (batch.length) {
    await GtfsCalendar.bulkWrite(batch, { ordered: false });
    total += batch.length;
    batch = [];
  }

  // Services defined ONLY via calendar_dates.txt (no calendar.txt row) — e.g.
  // THSR runs entirely on per-date exception_type=1 entries. Create a doc with
  // all weekdays false; getActiveServiceIds activates it via its exceptions.
  let datesOnly = 0;
  for (const [serviceId, exceptions] of exceptionsMap) {
    if (seenInCalendar.has(serviceId)) continue;
    const dates = exceptions.map((e) => e.date).sort();
    batch.push({
      updateOne: {
        filter: { serviceId },
        update: {
          $set: {
            serviceId,
            monday: false,
            tuesday: false,
            wednesday: false,
            thursday: false,
            friday: false,
            saturday: false,
            sunday: false,
            startDate: dates[0] ?? "",
            endDate: dates[dates.length - 1] ?? "",
            exceptions,
          },
        },
        upsert: true,
      },
    });
    datesOnly++;
    if (batch.length >= BATCH) {
      await GtfsCalendar.bulkWrite(batch, { ordered: false });
      total += batch.length;
      batch = [];
    }
  }
  if (batch.length) {
    await GtfsCalendar.bulkWrite(batch, { ordered: false });
    total += batch.length;
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    `✓ GtfsCalendar: ${total} upserted (${datesOnly} calendar_dates-only), ${elapsed}s`
  );
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
