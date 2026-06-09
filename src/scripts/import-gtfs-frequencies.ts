/**
 * Import frequencies.txt → GtfsFrequency collection (7,365 rows)
 * Used for headway-based service (metro / high-frequency buses).
 * Run: npx ts-node src/scripts/import-gtfs-frequencies.ts
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import readline from "readline";
import mongoose from "mongoose";
import { GtfsFrequency } from "../model/gtfs-frequency.model";

const GTFS_DIR = path.resolve(__dirname, "../../data/gtfs");
const BATCH = 1000;

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is required");
  await mongoose.connect(dbUrl);
  console.log("Connected to MongoDB");

  const filePath = path.join(GTFS_DIR, "frequencies.txt");
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  let headers: string[] = [];
  let batch: Parameters<typeof GtfsFrequency.bulkWrite>[0] = [];
  let total = 0;
  const start = Date.now();

  for await (const line of rl) {
    if (!headers.length) {
      headers = line.replace(/^﻿/, "").split(",");
      continue;
    }
    const values = line.split(",");
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = values[i]?.trim() ?? ""));

    if (!row.trip_id) continue;

    batch.push({
      updateOne: {
        filter: {
          tripId: row.trip_id,
          startTime: row.start_time,
          endTime: row.end_time,
        },
        update: {
          $set: {
            tripId: row.trip_id,
            startTime: row.start_time,
            endTime: row.end_time,
            headwaySecs: parseInt(row.headway_secs, 10),
          },
        },
        upsert: true,
      },
    });

    if (batch.length >= BATCH) {
      await GtfsFrequency.bulkWrite(batch, { ordered: false });
      total += batch.length;
      batch = [];
    }
  }

  if (batch.length) {
    await GtfsFrequency.bulkWrite(batch, { ordered: false });
    total += batch.length;
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`✓ GtfsFrequency: ${total} inserted, ${elapsed}s`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
