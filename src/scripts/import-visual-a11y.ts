/**
 * One-shot import: OSM visual accessibility facilities → MongoDB.
 *
 * Fetches audio signals and tactile paving nodes from Overpass API
 * for the Taipei/New Taipei area and upserts into the visual_a11ys collection.
 *
 * Run: npm run import:visual-a11y
 */

import "dotenv/config";
import mongoose from "mongoose";
import { syncFromOverpass } from "../modules/visual-a11y/visual-a11y.service";

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL env var is required");

  await mongoose.connect(dbUrl);
  console.log("Connected to MongoDB");

  console.log("Fetching from Overpass API...");
  const { inserted, updated } = await syncFromOverpass();
  console.log(`✓ inserted=${inserted} updated=${updated}`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
