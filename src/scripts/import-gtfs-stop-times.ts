/**
 * Import stop_times.txt → GtfsStopTime collection (4,966,406 rows)
 * Largest file — uses streaming + batch bulkWrite. Expect 10-20 min.
 * Run: npx ts-node src/scripts/import-gtfs-stop-times.ts
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import readline from "readline";
import mongoose from "mongoose";
import { GtfsStopTime } from "../model/gtfs-stop-time.model";

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
  const start = Date.now();

  for await (const line of rl) {
    if (!headers.length) {
      headers = line.replace(/^﻿/, "").split(",");
      continue;
    }
    const values = line.split(",");
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = values[i]?.trim() ?? ""));

    if (!row.trip_id || !row.stop_id) continue;

    batch.push({
      updateOne: {
        filter: {
          tripId: row.trip_id,
          stopSequence: parseInt(row.stop_sequence, 10),
        },
        update: {
          $set: {
            tripId: row.trip_id,
            stopId: row.stop_id,
            stopSequence: parseInt(row.stop_sequence, 10),
            arrivalTime: row.arrival_time,
            departureTime: row.departure_time,
          },
        },
        upsert: true,
      },
    });

    if (batch.length >= BATCH) {
      try {
        await GtfsStopTime.bulkWrite(batch, { ordered: false });
        total += batch.length;
      } catch {
        errors += batch.length;
      }
      batch = [];
      if (total % 100000 === 0) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(0);
        process.stdout.write(`  ${total} rows (${elapsed}s)...\r`);
      }
    }
  }

  if (batch.length) {
    await GtfsStopTime.bulkWrite(batch, { ordered: false });
    total += batch.length;
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n✓ GtfsStopTime: ${total} upserted, ${errors} errors, ${elapsed}s`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
