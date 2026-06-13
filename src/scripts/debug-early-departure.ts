/**
 * Repro: 10:00 request returning pre-10:00 bus departures (gtfs-direct path).
 * Usage: npx dotenvx run -- npx ts-node src/scripts/debug-early-departure.ts
 */
import mongoose from "mongoose";
import {
  planGtfsRoute,
  findNearestGtfsStops,
  getActiveServiceIds,
} from "../service/gtfs-router.service";

const ORIGIN = { lat: 24.2726233, lng: 120.57864749999999 }; // 高美
const DEST = { lat: 24.149743299999997, lng: 120.6837712 }; // 台中科大

async function main() {
  await mongoose.connect(process.env.DATABASE_URL!);
  const departureTime = new Date(
    process.argv[2] ?? "2026-06-11T10:00:00+08:00"
  );
  console.log(
    "departureTime(local):",
    departureTime.toString(),
    "| getHours():",
    departureTime.getHours()
  );

  const svc = await getActiveServiceIds(departureTime);
  console.log("activeServiceIds today:", svc.size);

  const [o, d] = await Promise.all([
    findNearestGtfsStops(ORIGIN),
    findNearestGtfsStops(DEST),
  ]);
  console.log(
    "originStops:",
    o.map((s) => `${s.stopId}(${Math.round(s.distanceM)}m)`).join(", ")
  );
  console.log(
    "destStops:",
    d.map((s) => `${s.stopId}(${Math.round(s.distanceM)}m)`).join(", ")
  );

  const routes = await planGtfsRoute(ORIGIN, DEST, {
    departureTime,
    maxTransfers: 1,
    mode: "wheelchair",
  });
  for (const r of routes) {
    const transit = r.legs.filter((l) => l.type !== "WALK");
    console.log(
      `route ${r.routeId} | ${r.routeName} | total ${r.totalMinutes}m | departureDate=${r.departureDate ?? "-"} | hl=${JSON.stringify(r.accessibilityHighlights)}`
    );
    for (const l of transit) {
      const anyL = l as any;
      console.log(
        `  leg ${l.type} dep=${anyL.departureTime} arr=${anyL.arrivalTime} wait=${JSON.stringify(anyL.waitInfo)} stop=${anyL.departureStop ?? anyL.departureStation}`
      );
    }
  }
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
