/**
 * Phase 16 R1 shadow-diff tool (spec §11): run the SAME query against all
 * three planners (GTFS graph / TDX MaaS / OTP2) and print a side-by-side
 * comparison. Successor to debug-early-departure.ts.
 *
 * Usage:
 *   npx dotenvx run -- npx ts-node src/scripts/debug-planner-compare.ts \
 *     [departureTimeISO] [originLat,originLng] [destLat,destLng]
 *
 * Defaults reuse the diagnosis smoke case: 高美 → 台中科大.
 */
import mongoose from "mongoose";
import type { AccessibleRoute } from "../modules/accessible-route/accessible-route.service";

const DEFAULT_ORIGIN = { lat: 24.2726233, lng: 120.57864749999999 }; // 高美
const DEFAULT_DEST = { lat: 24.149743299999997, lng: 120.6837712 }; // 台中科大

function parseCoord(
  arg: string | undefined,
  fallback: { lat: number; lng: number },
): { lat: number; lng: number } {
  if (!arg) return fallback;
  const [lat, lng] = arg.split(",").map(Number);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : fallback;
}

function printRoutes(label: string, routes: AccessibleRoute[]): void {
  console.log(`\n═══ ${label} — ${routes.length} route(s) ═══`);
  for (const r of routes) {
    console.log(
      `route ${r.routeId} | ${r.routeName} | total ${r.totalMinutes}m | ` +
        `transfers ${r.transferCount} | departureDate=${r.departureDate ?? "-"}`,
    );
    for (const l of r.legs) {
      if (l.type === "WALK") {
        console.log(`  WALK  ${l.from} → ${l.to} (${l.distanceM}m, ${l.minutesEst}m)`);
        continue;
      }
      const anyL = l as any;
      console.log(
        `  ${l.type.padEnd(5)} ${anyL.routeName ?? anyL.lineName ?? anyL.trainNo} | ` +
          `${anyL.departureStop ?? anyL.departureStation} → ${anyL.arrivalStop ?? anyL.arrivalStation} | ` +
          `dep=${anyL.departureTime ?? "-"} arr=${anyL.arrivalTime ?? "-"} | ` +
          `wait=${JSON.stringify(anyL.waitInfo)} dir=${anyL.direction ?? "-"} | ` +
          `stopIds=${anyL.departureStopId ?? "-"}→${anyL.arrivalStopId ?? "-"}`,
      );
    }
  }
}

async function main() {
  await mongoose.connect(process.env.DATABASE_URL!);

  const departureTime = process.argv[2] ? new Date(process.argv[2]) : undefined;
  const origin = parseCoord(process.argv[3], DEFAULT_ORIGIN);
  const dest = parseCoord(process.argv[4], DEFAULT_DEST);
  console.log(
    `query: ${origin.lat},${origin.lng} → ${dest.lat},${dest.lng} | ` +
      `departureTime=${departureTime?.toString() ?? "now"} | ` +
      `OTP_BASE_URL=${process.env.OTP_BASE_URL ?? "http://localhost:8080"}`,
  );

  const opts = {
    departureTime,
    maxTransfers: 1 as const,
    mode: "wheelchair" as const,
  };

  const [gtfs, tdx, otp] = await Promise.all([
    import("../service/gtfs-router.service")
      .then((m) => m.planGtfsRoute(origin, dest, opts))
      .catch((e): AccessibleRoute[] => {
        console.warn("planGtfsRoute failed:", e?.message ?? e);
        return [];
      }),
    import("../service/tdx-routing.service")
      .then((m) => m.planTdxRoute(origin, dest, { departureTime }))
      .catch((e): AccessibleRoute[] => {
        console.warn("planTdxRoute failed:", e?.message ?? e);
        return [];
      }),
    import("../service/otp-routing.service")
      .then((m) => m.planOtpRoute(origin, dest, opts))
      .catch((e): AccessibleRoute[] => {
        console.warn("planOtpRoute failed:", e?.message ?? e);
        return [];
      }),
  ]);

  printRoutes("GTFS graph (planGtfsRoute)", gtfs);
  printRoutes("TDX MaaS (planTdxRoute)", tdx);
  printRoutes("OTP2 (planOtpRoute)", otp);

  // Line-level diff: which transit lines does each engine propose?
  const lineSet = (routes: AccessibleRoute[]) =>
    new Set(
      routes.flatMap((r) =>
        r.legs
          .filter((l) => l.type !== "WALK")
          .map((l: any) => l.routeName ?? l.lineName ?? l.trainNo),
      ),
    );
  const [gl, tl, ol] = [lineSet(gtfs), lineSet(tdx), lineSet(otp)];
  const missing = [...new Set([...gl, ...tl])].filter((x) => !ol.has(x));
  const extra = [...ol].filter((x) => !gl.has(x) && !tl.has(x));
  console.log(`\n═══ line-level diff ═══`);
  console.log(`lines missing from OTP : ${missing.join(", ") || "(none)"}`);
  console.log(`lines only in OTP      : ${extra.join(", ") || "(none)"}`);

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
