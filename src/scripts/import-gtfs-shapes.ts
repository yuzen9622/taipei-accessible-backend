/**
 * Import shapes.txt → GtfsShape collection (5,409,301 points → LineString per shape)
 * Accumulates points per shapeId in memory, flushes in chunks to avoid OOM.
 * Run: npx ts-node --max-old-space-size=2048 src/scripts/import-gtfs-shapes.ts
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import readline from "readline";
import mongoose from "mongoose";
import { GtfsShape } from "../model/gtfs-shape.model";

const GTFS_DIR = path.resolve(__dirname, "../../data/gtfs");
// Flush accumulated shapes to DB when the map reaches this many entries
const FLUSH_AT = 500;

type ShapePoint = { seq: number; coord: [number, number] };

async function flushShapes(
  shapeMap: Map<string, ShapePoint[]>
): Promise<number> {
  const ops: Parameters<typeof GtfsShape.bulkWrite>[0] = [];
  for (const [shapeId, points] of shapeMap) {
    points.sort((a, b) => a.seq - b.seq);
    ops.push({
      updateOne: {
        filter: { shapeId },
        update: {
          $set: {
            shapeId,
            geometry: {
              type: "LineString",
              coordinates: points.map((p) => p.coord),
            },
          },
        },
        upsert: true,
      },
    });
  }
  if (!ops.length) return 0;
  await GtfsShape.bulkWrite(ops, { ordered: false });
  return ops.length;
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is required");
  await mongoose.connect(dbUrl);
  console.log("Connected to MongoDB");
  console.log("Importing shapes.txt (5.4M points) — this will take a while...");

  const filePath = path.join(GTFS_DIR, "shapes.txt");
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  let headers: string[] = [];
  const shapeMap = new Map<string, ShapePoint[]>();
  let totalShapes = 0;
  let totalPoints = 0;
  const start = Date.now();

  for await (const line of rl) {
    if (!headers.length) {
      headers = line.replace(/^﻿/, "").split(",");
      continue;
    }
    const values = line.split(",");
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = values[i]?.trim() ?? ""));

    const shapeId = row.shape_id;
    if (!shapeId) continue;

    const lat = parseFloat(row.shape_pt_lat);
    const lon = parseFloat(row.shape_pt_lon);
    const seq = parseInt(row.shape_pt_sequence, 10);
    if (isNaN(lat) || isNaN(lon) || isNaN(seq)) continue;

    if (!shapeMap.has(shapeId)) shapeMap.set(shapeId, []);
    shapeMap.get(shapeId)!.push({ seq, coord: [lon, lat] });
    totalPoints++;

    // Flush completed shapes when the map is large enough.
    // We detect "completed" shapes by flushing all except the current shapeId
    // (since points for the same shape are typically contiguous in the file).
    if (shapeMap.size > FLUSH_AT) {
      const toFlush = new Map<string, ShapePoint[]>();
      for (const [id, pts] of shapeMap) {
        if (id !== shapeId) toFlush.set(id, pts);
      }
      totalShapes += await flushShapes(toFlush);
      for (const id of toFlush.keys()) shapeMap.delete(id);

      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      process.stdout.write(
        `  ${totalShapes} shapes / ${totalPoints} points (${elapsed}s)...\r`
      );
    }
  }

  // Flush remaining
  totalShapes += await flushShapes(shapeMap);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    `\n✓ GtfsShape: ${totalShapes} shapes from ${totalPoints} points, ${elapsed}s`
  );
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
