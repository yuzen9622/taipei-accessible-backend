import A11y from "../../model/a11y.model";
import BathroomModel from "../../model/bathroom.model";
import OsmA11y from "../../model/osm-a11y.model";
import DisabledParkingModel from "../../model/disabled-parking.model";
import { IA11y, IOsmA11y } from "../../types";

export type A11yPlace = Omit<IA11y, "_id"> & {
  _id?: unknown;
  source: "metro" | "osm";
  osmId?: string;
  wheelchair?: IOsmA11y["wheelchair"];
  category?: "elevator" | "ramp";
};

const OSM_STRUCTURE_CATEGORIES: readonly string[] = ["elevator", "ramp"];

const OSM_CATEGORY_FALLBACK_NAME: Record<string, string> = {
  elevator: "無障礙電梯",
  ramp: "無障礙坡道",
};

/**
 * Normalizes an OSM accessibility document into the A11y (metro) response
 * shape so both sources render through the same frontend layer.
 */
export function osmToA11yPlace(doc: IOsmA11y): A11yPlace {
  const [lng, lat] = doc.location.coordinates;
  return {
    項次: doc.osmId,
    "出入口電梯/無障礙坡道名稱":
      doc.name ?? OSM_CATEGORY_FALLBACK_NAME[doc.category] ?? doc.category,
    經度: lng,
    緯度: lat,
    location: doc.location,
    source: "osm",
    osmId: doc.osmId,
    wheelchair: doc.wheelchair,
    category: doc.category as "elevator" | "ramp",
  };
}

/**
 * Merges metro elevator/ramp docs with OSM elevator/ramp docs into one
 * unified list; non-structure OSM categories (toilets, kerb cuts…) are
 * filtered out.
 */
export function mergeA11yPlaces(
  metro: Omit<IA11y, "_id">[],
  osm: IOsmA11y[]
): A11yPlace[] {
  return [
    ...metro.map((doc) => ({ ...doc, source: "metro" as const })),
    ...osm
      .filter((doc) => OSM_STRUCTURE_CATEGORIES.includes(doc.category))
      .map(osmToA11yPlace),
  ];
}

function makeGeoQuery(lng: number, lat: number, radiusM: number) {
  return {
    $near: {
      $geometry: { type: "Point", coordinates: [lng, lat] },
      $maxDistance: radiusM,
    },
  };
}

export async function findAll(): Promise<A11yPlace[]> {
  const [metro, osm] = await Promise.all([
    A11y.find().lean(),
    OsmA11y.find({ category: { $in: OSM_STRUCTURE_CATEGORIES } }).lean(),
  ]);
  return mergeA11yPlaces(metro, osm as IOsmA11y[]);
}

export async function findAllBathrooms() {
  return BathroomModel.find({ type: "無障礙廁所" });
}

export async function findNearbyParking(lat: number, lng: number, radiusM = 300) {
  return DisabledParkingModel.find({
    location: makeGeoQuery(lng, lat, radiusM),
  }).lean();
}

export async function findNearby(lat: number, lng: number, radiusM = 150) {
  const geoQuery = makeGeoQuery(lng, lat, radiusM);
  const [nearbyMetroA11y, nearbyBathroom, nearbyOsm, nearbyParking] =
    await Promise.all([
      A11y.find({ location: geoQuery }).lean(),
      BathroomModel.find({ type: "無障礙廁所", location: makeGeoQuery(lng, lat, 150) }),
      OsmA11y.find({ location: geoQuery }).lean(),
      DisabledParkingModel.find({ location: geoQuery }),
    ]);
  return {
    nearbyMetroA11y: mergeA11yPlaces(nearbyMetroA11y, nearbyOsm as IOsmA11y[]),
    nearbyBathroom,
    nearbyOsm,
    nearbyParking,
  };
}

export async function findNearbyLimited(lat: number, lng: number, radiusM = 300) {
  const geoQuery = makeGeoQuery(lng, lat, radiusM);
  const [nearbyMetroA11y, nearbyBathroom, nearbyOsm, nearbyParking] =
    await Promise.all([
      A11y.find({ location: geoQuery }).limit(10).lean(),
      BathroomModel.find({ type: "無障礙廁所", location: makeGeoQuery(lng, lat, 150) }).limit(5).lean(),
      OsmA11y.find({ location: geoQuery }).limit(15).lean(),
      DisabledParkingModel.find({ location: geoQuery }).limit(10).lean(),
    ]);
  return {
    nearbyMetroA11y: mergeA11yPlaces(nearbyMetroA11y, nearbyOsm as IOsmA11y[]),
    nearbyBathroom,
    nearbyOsm,
    nearbyParking,
  };
}

export async function findByOsmIds(ids: string[]) {
  return OsmA11y.find({ osmId: { $in: ids } }).lean();
}
