/**
 * One-off migration: fill the blank arrival/departure times in GtfsStopTime
 * (74% of the feed is blank — timepoint-only data) by linear interpolation.
 * See src/config/gtfs-interpolation.ts for the strategy.
 *
 * Streams the whole collection ordered by (tripId, stopSequence) — an index
 * walk, no in-memory sort — groups rows per trip, interpolates, and bulk-
 * writes only the rows that changed. Safe to re-run (already-filled rows are
 * left untouched and produce no writes).
 *
 * Run: npx dotenvx run -- npx ts-node src/scripts/interpolate-stop-times.ts
 */

import "dotenv/config";
import mongoose from "mongoose";
import { GtfsStopTime } from "../model/gtfs-stop-time.model";
import { interpolateTripTimes } from "../config/gtfs-interpolation";

const BATCH = 2000;

type Row = {
  _id: mongoose.Types.ObjectId;
  tripId: string;
  arrivalTime: string;
  departureTime: string;
};

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is required");
  await mongoose.connect(dbUrl);
  console.log("Connected to MongoDB");

  const cursor = GtfsStopTime.find({})
    .sort({ tripId: 1, stopSequence: 1 })
    .select("tripId arrivalTime departureTime stopSequence")
    .lean()
    .cursor({ batchSize: 5000 });

  let ops: mongoose.AnyBulkWriteOperation[] = [];
  let group: Row[] = [];
  let currentTrip = "";
  let scanned = 0;
  let filledRows = 0;
  let trips = 0;
  const start = Date.now();

  const flushOps = async (force = false) => {
    if (ops.length >= BATCH || (force && ops.length)) {
      const batch = ops;
      ops = [];
      await GtfsStopTime.bulkWrite(batch, { ordered: false });
    }
  };

  const processGroup = () => {
    if (group.length < 2) return;
    const before = group.map((r) => r.departureTime + "|" + r.arrivalTime);
    const filled = interpolateTripTimes(group);
    if (!filled) return;
    for (let i = 0; i < group.length; i++) {
      if (before[i] === group[i].departureTime + "|" + group[i].arrivalTime)
        continue;
      ops.push({
        updateOne: {
          filter: { _id: group[i]._id },
          update: {
            $set: {
              arrivalTime: group[i].arrivalTime,
              departureTime: group[i].departureTime,
            },
          },
        },
      });
      filledRows++;
    }
  };

  for await (const doc of cursor) {
    const row = doc as unknown as Row;
    if (row.tripId !== currentTrip) {
      processGroup();
      await flushOps();
      group = [];
      currentTrip = row.tripId;
      trips++;
    }
    group.push(row);
    if (++scanned % 200000 === 0) {
      const rate = Math.round(scanned / ((Date.now() - start) / 1000));
      console.log(
        `scanned ${scanned} rows, ${trips} trips, filled ${filledRows} (${rate} rows/s)`
      );
    }
  }
  processGroup();
  await flushOps(true);

  console.log(
    `Done: scanned ${scanned}, trips ${trips}, rows filled ${filledRows} in ${Math.round(
      (Date.now() - start) / 1000
    )}s`
  );
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
