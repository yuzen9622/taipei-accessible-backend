/**
 * One-shot import: fetches metro station data from TDX for all supported rail
 * systems and upserts into MongoDB for geospatial ($near) queries.
 *
 * Run: npm run import:tdx-metro
 * Or for a single system: npm run import:tdx-metro -- --system=TRTC
 */

import "dotenv/config";
import mongoose from "mongoose";
import MetroStationModel from "../model/metro-station.model";
import { metroUrl } from "../config/transit";
import { tdxFetch } from "../config/fetch";
import { TdxMetroStation, TdxMetroStationOfLine } from "../types/transit";
// TDX Station API returns StationUID with system prefix (e.g. "TMRT-G0").
// StationOfLine returns bare StationID (e.g. "G0") — we construct the full UID below.

const DELAY_MS = 60000;
const CHUNK = 500;

const ALL_SYSTEMS = ["TRTC", "KRTC", "TYMC", "TMRT", "NTMC", "KLRT"];

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function importSystem(railSystem: string): Promise<number> {
  const stationResp = await tdxFetch(
    `${metroUrl.stationUrl(railSystem)}?$format=JSON`,
  );
  if (!stationResp.ok) {
    const body = await stationResp.text();
    console.warn(
      `  TDX ${stationResp.status} for ${railSystem} stations: ${body.slice(0, 120)}`,
    );
    return 0;
  }
  const stations = (await stationResp.json()) as TdxMetroStation[];
  if (!stations.length) {
    console.log(`  No stations for ${railSystem}`);
    return 0;
  }

  const lineResp = await tdxFetch(
    `${metroUrl.stationOfLineUrl(railSystem)}?$format=JSON`,
  );
  const stationOfLines: TdxMetroStationOfLine[] = lineResp.ok
    ? ((await lineResp.json()) as TdxMetroStationOfLine[])
    : [];

  // Build fullStationUid → Set<fullLineUid>
  // TDX StationOfLine uses bare IDs, so we prepend railSystem to reconstruct full UIDs.
  const lineMap = new Map<string, Set<string>>();
  for (const sol of stationOfLines) {
    const fullLineUid = `${railSystem}-${sol.LineID}`;
    for (const s of sol.Stations ?? []) {
      const fullStationUid = `${railSystem}-${s.StationID}`;
      if (!lineMap.has(fullStationUid)) lineMap.set(fullStationUid, new Set());
      lineMap.get(fullStationUid)!.add(fullLineUid);
    }
  }

  const ops = stations
    .filter(
      (s) =>
        s.StationUID &&
        s.StationPosition?.PositionLon &&
        s.StationPosition?.PositionLat,
    )
    .map((s) => ({
      updateOne: {
        filter: { stationUid: s.StationUID },
        update: {
          $set: {
            stationUid: s.StationUID,
            stationName: { Zh_tw: s.StationName.Zh_tw, En: s.StationName.En },
            railSystem,
            lineIds: [...(lineMap.get(s.StationUID) ?? [])],
            location: {
              type: "Point",
              coordinates: [
                s.StationPosition.PositionLon,
                s.StationPosition.PositionLat,
              ],
            },
            importedAt: new Date(),
          },
        },
        upsert: true,
      },
    }));

  if (!ops.length) return 0;

  let upserted = 0;
  for (let i = 0; i < ops.length; i += CHUNK) {
    const result = await MetroStationModel.bulkWrite(ops.slice(i, i + CHUNK), {
      ordered: false,
    });
    upserted += result.upsertedCount + result.modifiedCount;
  }
  return upserted;
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL env var is required");

  await mongoose.connect(dbUrl);
  console.log("Connected to MongoDB\n");

  const systemArg = process.argv
    .find((a) => a.startsWith("--system="))
    ?.split("=")[1];
  const systems = systemArg ? [systemArg] : ALL_SYSTEMS;

  let total = 0;
  for (const railSystem of systems) {
    console.log(`▶ Importing: ${railSystem}`);
    try {
      const count = await importSystem(railSystem);
      console.log(`  Upserted/updated: ${count}`);
      total += count;
    } catch (err) {
      console.error(`  Error: ${(err as Error).message}`);
    }
    await sleep(DELAY_MS);
  }

  console.log(`\n✓ Done. Total upserted/updated: ${total}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
