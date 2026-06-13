/**
 * Build the StationCluster collection: groups of GTFS route-network stops that
 * are the SAME physical station across modes, so the router can connect
 * bus↔rail transfers that exact stop_name matching never finds
 * (bus 「捷運淡水站」 vs metro 「淡水」, TRA 「台北」 vs TRTC 「台北車站」).
 *
 * Algorithm (offline, rail stations as seeds):
 *  1. Rail↔rail: union rail stations within RAIL_MERGE_M whose normalized
 *     names match (strips 捷運/臺鐵/台鐵/高鐵 prefixes, 站/車站/火車站
 *     suffixes, and parenthesised annotations).
 *  2. Bus attach: each bus stop within BUS_ATTACH_M of a rail station whose
 *     normalized name fuzzy-matches joins that station's cluster (nearest
 *     match wins; a stop belongs to at most one cluster).
 *  3. Clusters with a single member are kept only if rail↔rail merged ones —
 *     singletons add nothing over plain name matching and are dropped.
 *
 * Re-runnable: replaces the whole collection.
 *
 * Run: npx dotenvx run -- npx ts-node src/scripts/build-station-clusters.ts
 */

import "dotenv/config";
import mongoose from "mongoose";
import { GtfsStop } from "../model/gtfs-stop.model";
import { StationCluster, IStationCluster } from "../model/station-cluster.model";

const RAIL_PREFIX = /^(TRTC|KRTC|KLRT|TYMC|TMRT|NTMC|THSR|TRA)_/;
const RAIL_MERGE_M = 400; // cross-system rail stations of one physical station
const BUS_ATTACH_M = 500; // bus stop ↔ rail station (bus bays can sit across the plaza)
const BUS_PROBE_LIMIT = 150; // nearby bus stops examined per rail station — busy
// interchanges (淡水, 板橋…) have 60+ bays from BOTH city registries (TPE/NWT)

function haversineM(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLng = ((b[0] - a[0]) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a[1] * Math.PI) / 180) *
      Math.cos((b[1] * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Normalize a stop name for cross-mode matching. */
export function normalizeStationName(name: string): string {
  return (name ?? "")
    .replace(/（.*?）|\(.*?\)/g, "") // parenthesised annotations (路名, 出口…)
    .replace(/^(捷運|臺鐵|台鐵|高鐵|台灣高鐵)/, "")
    .replace(/(火車站|車站|站)$/, "")
    .trim();
}

/** Fuzzy match of two normalized names (≥2 chars to avoid 單字 false hits). */
function namesMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 2 && b.includes(a)) return true;
  if (b.length >= 2 && a.includes(b)) return true;
  return false;
}

interface StopLite {
  stopId: string;
  stopName: string;
  coords: [number, number];
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is required");
  await mongoose.connect(dbUrl);
  console.log("Connected to MongoDB");

  const railDocs = await GtfsStop.find({
    locationType: 0,
    parentStation: null,
    stopId: RAIL_PREFIX,
  })
    .select("stopId stopName stopLat stopLon")
    .lean();
  const rails: StopLite[] = railDocs.map((d) => ({
    stopId: d.stopId,
    stopName: d.stopName,
    coords: [d.stopLon, d.stopLat],
  }));
  console.log(`Rail stations: ${rails.length}`);

  // ── 1. Rail↔rail union-find ──
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    // path compression
    let c = x;
    while (parent.get(c) !== c) {
      const next = parent.get(c)!;
      parent.set(c, r);
      c = next;
    }
    return r;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));
  for (const r of rails) parent.set(r.stopId, r.stopId);

  const norm = new Map(rails.map((r) => [r.stopId, normalizeStationName(r.stopName)]));
  for (let i = 0; i < rails.length; i++) {
    for (let j = i + 1; j < rails.length; j++) {
      const a = rails[i];
      const b = rails[j];
      if (!namesMatch(norm.get(a.stopId)!, norm.get(b.stopId)!)) continue;
      if (haversineM(a.coords, b.coords) > RAIL_MERGE_M) continue;
      union(a.stopId, b.stopId);
    }
  }

  // ── 2. Attach fuzzy-matching bus stops near each rail station ──
  // busAssign: busStopId → { railStopId (nearest match), distance }
  const busAssign = new Map<string, { rail: StopLite; bus: StopLite; dist: number }>();
  let probed = 0;
  for (const rail of rails) {
    const nearbyBuses = await GtfsStop.find({
      locationType: 0,
      parentStation: null,
      stopId: { $not: RAIL_PREFIX },
      location: {
        $near: {
          $geometry: { type: "Point", coordinates: rail.coords },
          $maxDistance: BUS_ATTACH_M,
        },
      },
    })
      .select("stopId stopName stopLat stopLon")
      .limit(BUS_PROBE_LIMIT)
      .lean();
    const railNorm = norm.get(rail.stopId)!;
    for (const b of nearbyBuses) {
      if (!namesMatch(railNorm, normalizeStationName(b.stopName))) continue;
      const bus: StopLite = {
        stopId: b.stopId,
        stopName: b.stopName,
        coords: [b.stopLon, b.stopLat],
      };
      const dist = haversineM(rail.coords, bus.coords);
      const prev = busAssign.get(b.stopId);
      if (!prev || dist < prev.dist) busAssign.set(b.stopId, { rail, bus, dist });
    }
    if (++probed % 100 === 0) console.log(`  probed ${probed}/${rails.length} rail stations`);
  }
  console.log(`Bus stops attached: ${busAssign.size}`);

  // ── 3. Assemble clusters ──
  const byRoot = new Map<string, { rails: StopLite[]; buses: StopLite[] }>();
  for (const r of rails) {
    const root = find(r.stopId);
    const g = byRoot.get(root) ?? { rails: [], buses: [] };
    g.rails.push(r);
    byRoot.set(root, g);
  }
  for (const { rail, bus } of busAssign.values()) {
    byRoot.get(find(rail.stopId))!.buses.push(bus);
  }

  const clusters: IStationCluster[] = [];
  for (const [root, g] of byRoot) {
    const members = [...g.rails, ...g.buses];
    if (members.length < 2) continue; // singleton = plain name matching suffices
    const seed = g.rails[0];
    clusters.push({
      clusterId: `SC_${root}`,
      name: seed.stopName,
      memberStopIds: members.map((m) => m.stopId),
      memberNames: [...new Set(members.map((m) => m.stopName))],
      location: { type: "Point", coordinates: seed.coords },
    });
  }
  console.log(`Clusters with ≥2 members: ${clusters.length}`);

  await StationCluster.deleteMany({});
  if (clusters.length) await StationCluster.insertMany(clusters, { ordered: false });

  // Report a few interesting ones (cross-mode).
  const crossMode = clusters
    .filter((c) => c.memberStopIds.some((id) => !RAIL_PREFIX.test(id)))
    .slice(0, 5);
  for (const c of crossMode) {
    console.log(`  e.g. ${c.name}: ${c.memberNames.join(" / ")} (${c.memberStopIds.length} stops)`);
  }
  console.log("Done");
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
