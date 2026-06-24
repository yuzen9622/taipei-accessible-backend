import A11y from "../../model/a11y.model";
import BathroomModel from "../../model/bathroom.model";
import OsmA11y from "../../model/osm-a11y.model";
import DisabledParkingModel from "../../model/disabled-parking.model";

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

export async function findNearbyParking(lat: number, lng: number, radiusM = 300) {
  return DisabledParkingModel.find({
    location: makeGeoQuery(lng, lat, radiusM),
  }).lean();
}

export async function findNearby(lat: number, lng: number, radiusM = 150) {
  const geoQuery = makeGeoQuery(lng, lat, radiusM);
  const [nearbyMetroA11y, nearbyBathroom, nearbyOsm, nearbyParking] =
    await Promise.all([
      A11y.find({ location: geoQuery }),
      BathroomModel.find({ type: "無障礙廁所", location: makeGeoQuery(lng, lat, 150) }),
      OsmA11y.find({ location: geoQuery }),
      DisabledParkingModel.find({ location: geoQuery }),
    ]);
  return { nearbyMetroA11y, nearbyBathroom, nearbyOsm, nearbyParking };
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
  return { nearbyMetroA11y, nearbyBathroom, nearbyOsm, nearbyParking };
}

export async function findByOsmIds(ids: string[]) {
  return OsmA11y.find({ osmId: { $in: ids } }).lean();
}
