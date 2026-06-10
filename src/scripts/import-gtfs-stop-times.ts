/**
 * Import stop_times.txt → GtfsStopTime collection (4,966,406 rows)
 * Largest file — uses streaming + batch bulkWrite. Expect 10-20 min.
 *
 * Blank times (74% of the feed is timepoint-only) are interpolated per trip
 * during import — see src/config/gtfs-interpolation.ts. Rows are grouped by
 * trip on the fly (stop_times.txt is ordered by trip_id per the GTFS spec).
 *
 * Run: npx ts-node src/scripts/import-gtfs-stop-times.ts
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import readline from "readline";
import mongoose from "mongoose";
import { GtfsStopTime } from "../model/gtfs-stop-time.model";
import { interpolateTripTimes } from "../config/gtfs-interpolation";

const GTFS_DIR = path.resolve(__dirname, "../../data/gtfs");
const BATCH = 2000;

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is required");
  await mongoose.connect(dbUrl);
  console.log("Connected to MongoDB");
  console.log("Importing stop_times.txt (4.9M rows) — this will take a while...");

  const filePath = path.join(GTFS_DIR, "stop_times.txt");
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  let headers: string[] = [];
  let batch: Parameters<typeof GtfsStopTime.bulkWrite>[0] = [];
  let total = 0;
  let errors = 0;
  let interpolated = 0;
  const start = Date.now();

  type TripRow = {
    tripId: string;
    stopId: string;
    stopSequence: number;
    arrivalTime: string;
    departureTime: string;
  };
  let group: TripRow[] = [];
  let currentTrip = "";

  const flushBatch = async (force = false) => {
    if (batch.length >= BATCH || (force && batch.length)) {
      const ops = batch;
      batch = [];
      try {
        await GtfsStopTime.bulkWrite(ops, { ordered: false });
        total += ops.length;
      } catch {
        errors += ops.length;
      }
      if (total % 100000 < BATCH) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(0);
        process.stdout.write(`  ${total} rows (${elapsed}s)...\r`);
      }
    }
  };

  // Interpolate the buffered trip's blank times, then emit its upserts.
  const emitGroup = () => {
    if (!group.length) return;
    group.sort((a, b) => a.stopSequence - b.stopSequence);
    interpolated += interpolateTripTimes(group);
    for (const r of group) {
      batch.push({
        updateOne: {
          filter: { tripId: r.tripId, stopSequence: r.stopSequence },
          update: { $set: { ...r } },
          upsert: true,
        },
      });
    }
    group = [];
  };

  for await (const line of rl) {
    if (!headers.length) {
      headers = line.replace(/^﻿/, "").split(",");
      continue;
    }
    const values = line.split(",");
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = values[i]?.trim() ?? ""));

    if (!row.trip_id || !row.stop_id) continue;

    if (row.trip_id !== currentTrip) {
      emitGroup();
      await flushBatch();
      currentTrip = row.trip_id;
    }
    group.push({
      tripId: row.trip_id,
      stopId: row.stop_id,
      stopSequence: parseInt(row.stop_sequence, 10),
      arrivalTime: row.arrival_time,
      departureTime: row.departure_time,
    });
  }

  emitGroup();
  await flushBatch(true);
  console.log(`\n  interpolated ${interpolated} blank-time rows`);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n✓ GtfsStopTime: ${total} upserted, ${errors} errors, ${elapsed}s`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
