import A11y from "../../model/a11y.model";
import BathroomModel from "../../model/bathroom.model";
import OsmA11y from "../../model/osm-a11y.model";

function makeGeoQuery(lng: number, lat: number, radiusM: number) {
  return {
    $near: {
      $geometry: { type: "Point", coordinates: [lng, lat] },
      $maxDistance: radiusM,
    },
  };
}

export async function findAll() {
  return A11y.find();
}

export async function findAllBathrooms() {
  return BathroomModel.find({ type: "無障礙廁所" });
}

export async function findNearby(lat: number, lng: number, radiusM = 150) {
  const geoQuery = makeGeoQuery(lng, lat, radiusM);
  const [nearbyMetroA11y, nearbyBathroom, nearbyOsm] = await Promise.all([
    A11y.find({ location: geoQuery }),
    BathroomModel.find({ type: "無障礙廁所", location: makeGeoQuery(lng, lat, 150) }),
    OsmA11y.find({ location: geoQuery }),
  ]);
  return { nearbyMetroA11y, nearbyBathroom, nearbyOsm };
}

export async function findNearbyLimited(lat: number, lng: number, radiusM = 300) {
  const geoQuery = makeGeoQuery(lng, lat, radiusM);
  const [nearbyMetroA11y, nearbyBathroom, nearbyOsm] = await Promise.all([
    A11y.find({ location: geoQuery }).limit(10).lean(),
    BathroomModel.find({ type: "無障礙廁所", location: makeGeoQuery(lng, lat, 150) }).limit(5).lean(),
    OsmA11y.find({ location: geoQuery }).limit(15).lean(),
  ]);
  return { nearbyMetroA11y, nearbyBathroom, nearbyOsm };
}

export async function findByOsmIds(ids: string[]) {
  return OsmA11y.find({ osmId: { $in: ids } }).lean();
}
