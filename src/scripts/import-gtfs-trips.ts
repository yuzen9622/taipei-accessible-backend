/**
 * Import trips.txt → GtfsTrip collection (148,720 rows)
 * Run: npx ts-node src/scripts/import-gtfs-trips.ts
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import readline from "readline";
import mongoose from "mongoose";
import { GtfsTrip } from "../model/gtfs-trip.model";

const GTFS_DIR = path.resolve(__dirname, "../../data/gtfs");
const BATCH = 1000;

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is required");
  await mongoose.connect(dbUrl);
  console.log("Connected to MongoDB");

  const filePath = path.join(GTFS_DIR, "trips.txt");
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  let headers: string[] = [];
  let batch: Parameters<typeof GtfsTrip.bulkWrite>[0] = [];
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
        filter: { tripId: row.trip_id },
        update: {
          $set: {
            tripId: row.trip_id,
            routeId: row.route_id,
            serviceId: row.service_id,
            shapeId: row.shape_id || undefined,
            directionId: parseInt(row.direction_id || "0", 10) as 0 | 1,
            bikesAllowed: row.bikes_allowed
              ? (parseInt(row.bikes_allowed, 10) as 0 | 1 | 2)
              : undefined,
          },
        },
        upsert: true,
      },
    });

    if (batch.length >= BATCH) {
      await GtfsTrip.bulkWrite(batch, { ordered: false });
      total += batch.length;
      batch = [];
      if (total % 20000 === 0) process.stdout.write(`  ${total}...\r`);
    }
  }

  if (batch.length) {
    await GtfsTrip.bulkWrite(batch, { ordered: false });
    total += batch.length;
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n✓ GtfsTrip: ${total} upserted, ${elapsed}s`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
