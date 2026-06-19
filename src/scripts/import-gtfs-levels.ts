/**
 * Import levels.txt → GtfsLevel collection (7,232 rows)
 * Run: npx ts-node src/scripts/import-gtfs-levels.ts
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import readline from "readline";
import mongoose from "mongoose";
import { GtfsLevel } from "../model/gtfs-level.model";
import { GTFS_DIR } from "../constants/gtfs";

const BATCH = 1000;

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is required");
  await mongoose.connect(dbUrl);
  console.log("Connected to MongoDB");

  const filePath = path.join(GTFS_DIR, "levels.txt");
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  let headers: string[] = [];
  let batch: Parameters<typeof GtfsLevel.bulkWrite>[0] = [];
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

    if (!row.level_id) continue;

    batch.push({
      updateOne: {
        filter: { levelId: row.level_id },
        update: {
          $set: {
            levelId: row.level_id,
            levelIndex: parseFloat(row.level_index),
            levelName: row.level_name,
          },
        },
        upsert: true,
      },
    });

    if (batch.length >= BATCH) {
      await GtfsLevel.bulkWrite(batch, { ordered: false });
      total += batch.length;
      batch = [];
    }
  }

  if (batch.length) {
    await GtfsLevel.bulkWrite(batch, { ordered: false });
    total += batch.length;
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`✓ GtfsLevel: ${total} upserted, ${elapsed}s`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
