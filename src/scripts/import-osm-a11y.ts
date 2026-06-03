/**
 * One-shot import script: fetches Taiwan accessibility data from OpenStreetMap
 * via Overpass API and upserts into MongoDB.
 *
 * Run: npx dotenvx run -- ts-node src/scripts/import-osm-a11y.ts
 */

import "dotenv/config";
import mongoose from "mongoose";
import OsmA11y from "../model/osm-a11y.model";
import { IOsmA11y } from "../types";

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const DELAY_MS = 6000; // respect Overpass rate limits between queries

// Four focused queries — splitting avoids timeout and keeps result sets manageable
const QUERIES: { label: string; query: string }[] = [
  {
    label: "wheelchair accessible places",
    query: `[out:json][timeout:60];
area["ISO3166-1"="TW"][admin_level=2]->.tw;
node["wheelchair"~"^(yes|limited)$"](area.tw);
out body;`,
  },
  {
    label: "kerb cuts and dropped kerbs",
    query: `[out:json][timeout:60];
area["ISO3166-1"="TW"][admin_level=2]->.tw;
(
  node["highway"="dropped_kerb"](area.tw);
  node["kerb"~"^(flush|lowered)$"](area.tw);
);
out body;`,
  },
  {
    label: "elevators",
    query: `[out:json][timeout:60];
area["ISO3166-1"="TW"][admin_level=2]->.tw;
(
  node["elevator"="yes"](area.tw);
  node["highway"="elevator"](area.tw);
);
out body;`,
  },
  {
    label: "wheelchair ramps",
    query: `[out:json][timeout:60];
area["ISO3166-1"="TW"][admin_level=2]->.tw;
node["ramp:wheelchair"="yes"](area.tw);
out body;`,
  },
];

function deriveCategory(
  tags: Record<string, string>
): IOsmA11y["category"] {
  if (tags["highway"] === "elevator" || tags["elevator"] === "yes")
    return "elevator";
  if (
    tags["highway"] === "dropped_kerb" ||
    tags["kerb"] === "flush" ||
    tags["kerb"] === "lowered"
  )
    return "kerb_cut";
  if (tags["ramp:wheelchair"] === "yes") return "ramp";
  if (tags["amenity"] === "toilets") return "toilet";
  return "wheelchair_accessible";
}

async function fetchOverpass(query: string): Promise<any[]> {
  let lastError: Error | null = null;
  for (const url of OVERPASS_ENDPOINTS) {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
        "User-Agent": "taipei-accessible-backend/1.0 (accessibility data import)",
      },
      body: `data=${encodeURIComponent(query)}`,
    });
    if (!resp.ok) {
      lastError = new Error(`Overpass HTTP ${resp.status} from ${url}: ${await resp.text()}`);
      continue;
    }
    const json = (await resp.json()) as { elements?: any[] };
    return json.elements ?? [];
  }
  throw lastError!;
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL env var is required");

  await mongoose.connect(dbUrl);
  console.log("Connected to MongoDB\n");

  let totalUpserted = 0;
  let totalUpdated = 0;

  for (const { label, query } of QUERIES) {
    console.log(`▶ Fetching: ${label}`);

    let elements: any[];
    try {
      elements = await fetchOverpass(query);
    } catch (err) {
      console.error(`  Error: ${(err as Error).message}`);
      await sleep(DELAY_MS);
      continue;
    }

    const nodes = elements.filter(
      (el) => el.type === "node" && el.lat != null && el.lon != null
    );
    console.log(`  Received ${nodes.length} nodes`);

    if (nodes.length === 0) {
      await sleep(DELAY_MS);
      continue;
    }

    const ops = nodes.map((el) => {
      const tags: Record<string, string> = el.tags ?? {};
      const doc: Omit<IOsmA11y, "_id"> = {
        osmId: String(el.id),
        name: tags["name"] ?? tags["name:zh"] ?? tags["name:en"],
        category: deriveCategory(tags),
        wheelchair: tags["wheelchair"] as IOsmA11y["wheelchair"],
        tags,
        location: { type: "Point", coordinates: [el.lon, el.lat] },
        importedAt: new Date(),
      };
      return {
        updateOne: {
          filter: { osmId: doc.osmId },
          update: { $set: doc },
          upsert: true,
        },
      };
    });

    // Process in chunks of 500 to avoid large write payloads
    const CHUNK = 500;
    for (let i = 0; i < ops.length; i += CHUNK) {
      const result = await OsmA11y.bulkWrite(ops.slice(i, i + CHUNK), {
        ordered: false,
      });
      totalUpserted += result.upsertedCount;
      totalUpdated += result.modifiedCount;
    }

    console.log(
      `  Done — new: ${totalUpserted}, updated: ${totalUpdated} (cumulative)`
    );
    await sleep(DELAY_MS);
  }

  console.log(`\n✓ Import complete. Total new: ${totalUpserted}, updated: ${totalUpdated}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
