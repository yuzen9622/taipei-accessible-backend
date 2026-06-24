import mongoose from "mongoose";
import WelfareModel from "../../model/welfare.model";

function makeGeoQuery(lng: number, lat: number, radiusM: number) {
  return {
    $near: {
      $geometry: { type: "Point", coordinates: [lng, lat] },
      $maxDistance: radiusM,
    },
  };
}

/** Welfare institutions within `radiusM` of the point (only geocoded ones have a location). */
export async function findNearby(lat: number, lng: number, radiusM = 1000) {
  return WelfareModel.find({ location: makeGeoQuery(lng, lat, radiusM) }).lean();
}

/** Directory listing, optionally filtered by county and/or institution type. */
export async function findAll(filter: { county?: string; type?: string } = {}) {
  const query: Record<string, unknown> = {};
  if (filter.county) query.county = filter.county;
  if (filter.type) query.type = filter.type;
  return WelfareModel.find(query).lean();
}

/** Single institution by id, or null if the id is malformed or not found. */
export async function findById(id: string) {
  if (!mongoose.isValidObjectId(id)) return null;
  return WelfareModel.findById(id).lean();
}
