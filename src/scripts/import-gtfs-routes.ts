/**
 * Import routes.txt → GtfsRoute collection (8,910 rows)
 * Run: npx ts-node src/scripts/import-gtfs-routes.ts
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import readline from "readline";
import mongoose from "mongoose";
import { GtfsRoute } from "../model/gtfs-route.model";

const GTFS_DIR = path.resolve(__dirname, "../../data/gtfs");
const BATCH = 1000;

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is required");
  await mongoose.connect(dbUrl);
  console.log("Connected to MongoDB");

  const filePath = path.join(GTFS_DIR, "routes.txt");
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  let headers: string[] = [];
  let batch: Parameters<typeof GtfsRoute.bulkWrite>[0] = [];
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

    if (!row.route_id) continue;

    batch.push({
      updateOne: {
        filter: { routeId: row.route_id },
        update: {
          $set: {
            routeId: row.route_id,
            agencyId: row.agency_id,
            routeShortName: row.route_short_name,
            routeLongName: row.route_long_name,
            routeType: parseInt(row.route_type, 10) as 1 | 2 | 3 | 4,
          },
        },
        upsert: true,
      },
    });

    if (batch.length >= BATCH) {
      await GtfsRoute.bulkWrite(batch, { ordered: false });
      total += batch.length;
      batch = [];
    }
  }

  if (batch.length) {
    await GtfsRoute.bulkWrite(batch, { ordered: false });
    total += batch.length;
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`✓ GtfsRoute: ${total} upserted, ${elapsed}s`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
