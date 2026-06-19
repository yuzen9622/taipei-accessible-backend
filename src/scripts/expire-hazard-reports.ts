/**
 * Mark stale hazard reports as expired (no physical delete).
 * Run on a schedule (e.g. Cloud Scheduler) or ad hoc:
 *   npx dotenvx run -- ts-node src/scripts/expire-hazard-reports.ts
 */

import "dotenv/config";
import mongoose from "mongoose";
import { expireStaleReports } from "../modules/hazard-report/hazard-report.expire";

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is required");
  await mongoose.connect(dbUrl);
  console.log("Connected to MongoDB");

  const expired = await expireStaleReports();
  console.log(`Marked ${expired} hazard report(s) as expired`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
