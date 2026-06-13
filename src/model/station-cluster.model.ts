import { model, Schema } from "mongoose";

/**
 * A cluster of GTFS route-network stops that represent the SAME physical
 * station across transport modes — e.g. TRTC_R28 「淡水」 + the surrounding
 * bus stops named 「捷運淡水站」 + a co-located TRA station.
 *
 * Built offline by src/scripts/build-station-clusters.ts (coordinate
 * proximity + normalized-name fuzzy matching, rail stations as seeds).
 * The GTFS router uses clusters as transfer-hub keys, fixing the
 * bus↔rail transfers that exact stop_name matching can never connect.
 */
export interface IStationCluster {
  clusterId: string;
  /** Representative (rail) station name. */
  name: string;
  memberStopIds: string[];
  memberNames: string[];
  location: {
    type: "Point";
    coordinates: [number, number]; // [lng, lat]
  };
}

const stationClusterSchema = new Schema<IStationCluster>({
  clusterId: { type: String, required: true },
  name: { type: String, required: true },
  memberStopIds: { type: [String], required: true },
  memberNames: { type: [String], required: true },
  location: {
    type: { type: String, enum: ["Point"], required: true },
    coordinates: { type: [Number], required: true },
  },
});

stationClusterSchema.index({ clusterId: 1 }, { unique: true });
// Multikey index: stopId → its cluster (a stop belongs to at most one).
stationClusterSchema.index({ memberStopIds: 1 });
stationClusterSchema.index({ location: "2dsphere" });

export const StationCluster = model<IStationCluster>(
  "StationCluster",
  stationClusterSchema
);
