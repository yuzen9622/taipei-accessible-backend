import A11y from "../../model/a11y.model";
import BathroomModel from "../../model/bathroom.model";
import OsmA11y from "../../model/osm-a11y.model";
import DisabledParkingModel from "../../model/disabled-parking.model";
import * as campusService from "../campus/campus.service";
import {
  autocompletePlaces,
  getPlaceDetails,
  type GooglePlaceDetails,
} from "../../adapters/google.adapter";
import { redisGet, redisSet } from "../../config/redis";
import { haversineMeters } from "../../utils/geo";

const AC_CACHE_PREFIX = "ps:ac:";
const AC_CACHE_TTL_SEC = 120;
const A11Y_NEARBY_RADIUS_M = 50;
const GOOGLE_ATTRIBUTION = "Powered by Google";

export interface AutocompleteItem {
  placeId: string;
  primaryText: string;
  secondaryText: string | null;
}

export interface PlaceAccessibility {
  status: "accessible" | "limited" | "unknown";
  wheelchair: "yes" | "limited" | "no" | null;
  nearbyFacilityCount: number;
  source: "local-db" | "google" | "none";
}

export interface PlaceResult {
  id: string;
  source: "google" | "osm" | "metro" | "campus" | "bathroom" | "parking" | "local";
  name: string;
  address: string | null;
  location: { type: "Point"; coordinates: [number, number] };
  category: string | null;
  distanceMeters: number | null;
  rating: number | null;
  accessibility: PlaceAccessibility;
  attribution: string | null;
}

function makeGeoQuery(lng: number, lat: number, radiusM: number) {
  return {
    $near: {
      $geometry: { type: "Point", coordinates: [lng, lat] },
      $maxDistance: radiusM,
    },
  };
}

/** Coarse coordinate bucket (~1km) so nearby queries share the same cache key. */
function roundCoarse(n?: number): string {
  return Number.isFinite(n) ? (n as number).toFixed(2) : "";
}

/**
 * Returns place-name predictions for a partial query. Cheap by design: no
 * coordinate or accessibility resolution. Short-TTL Redis cache keyed on query
 * plus coarse coordinates (session token is intentionally excluded — predictions
 * are token-independent). Degrades to an empty array on any Google failure.
 *
 * @param params Query text, optional session token, and optional bias coordinates.
 * @returns The predicted places.
 */
export async function autocomplete(params: {
  q: string;
  sessionToken?: string;
  lat?: number;
  lng?: number;
}): Promise<AutocompleteItem[]> {
  const { q, sessionToken, lat, lng } = params;
  const cacheKey = `${AC_CACHE_PREFIX}${q}:${roundCoarse(lat)}:${roundCoarse(lng)}`;

  const cached = await redisGet(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached) as AutocompleteItem[];
    } catch {
      /* treat malformed cache as a miss */
    }
  }

  const suggestions = await autocompletePlaces(q, {
    sessionToken,
    latitude: lat,
    longitude: lng,
  });
  const items: AutocompleteItem[] = suggestions.map((s) => ({
    placeId: s.placeId,
    primaryText: s.primaryText,
    secondaryText: s.secondaryText,
  }));

  await redisSet(cacheKey, JSON.stringify(items), AC_CACHE_TTL_SEC);
  return items;
}

/** Counts local accessibility facilities within the given radius of a point. */
async function countNearbyFacilities(lat: number, lng: number): Promise<number> {
  const geoQuery = makeGeoQuery(lng, lat, A11Y_NEARBY_RADIUS_M);
  const [metro, osm, bathroom, parking, campus] = await Promise.all([
    A11y.find({ location: geoQuery }).lean().catch(() => []),
    OsmA11y.find({ location: geoQuery }).lean().catch(() => []),
    BathroomModel.find({ type: "無障礙廁所", location: geoQuery }).lean().catch(() => []),
    DisabledParkingModel.find({ location: geoQuery }).lean().catch(() => []),
    campusService.findFacilitiesNearby(lat, lng, A11Y_NEARBY_RADIUS_M).catch(() => []),
  ]);
  return metro.length + osm.length + bathroom.length + parking.length + campus.length;
}

/**
 * Derives the three-state accessibility badge from local facility density and
 * Google's wheelchair signal. Local data wins; Google is the fallback signal.
 * Honest by design: absence of both is reported as `unknown`, never faked.
 */
async function computeAccessibility(
  lat: number,
  lng: number,
  googleWheelchair: "yes" | "no" | null,
  googleWheelchairPartial: boolean,
): Promise<PlaceAccessibility> {
  const nearbyFacilityCount = await countNearbyFacilities(lat, lng);

  if (nearbyFacilityCount > 0) {
    return {
      status: "accessible",
      wheelchair: googleWheelchair,
      nearbyFacilityCount,
      source: "local-db",
    };
  }
  if (googleWheelchair === "yes") {
    return { status: "accessible", wheelchair: "yes", nearbyFacilityCount, source: "google" };
  }
  if (googleWheelchairPartial) {
    return { status: "limited", wheelchair: "limited", nearbyFacilityCount, source: "google" };
  }
  if (googleWheelchair === "no") {
    return { status: "unknown", wheelchair: "no", nearbyFacilityCount, source: "google" };
  }
  return { status: "unknown", wheelchair: null, nearbyFacilityCount, source: "none" };
}

function googleToLocation(d: GooglePlaceDetails & { location: { latitude: number; longitude: number } }) {
  return {
    type: "Point" as const,
    coordinates: [d.location.longitude, d.location.latitude] as [number, number],
  };
}

/**
 * Resolves a selected place id to a full PlaceResult: coordinates, distance from
 * the user (when supplied), and the computed accessibility badge. Returns null
 * when the place is unresolvable or has no usable coordinates (controller → 404).
 * Not cached — Google terms disallow persisting non-id fields, and details is
 * called once per selection.
 *
 * @param params Place id, optional session token, and optional user coordinates.
 * @returns The resolved place, or null.
 */
export async function details(params: {
  placeId: string;
  sessionToken?: string;
  lat?: number;
  lng?: number;
}): Promise<PlaceResult | null> {
  const { placeId, sessionToken, lat, lng } = params;

  const d = await getPlaceDetails(placeId, { sessionToken });
  if (!d || !d.location) return null;

  const placeLat = d.location.latitude;
  const placeLng = d.location.longitude;

  const hasUserCoords = Number.isFinite(lat) && Number.isFinite(lng);
  const distanceMeters = hasUserCoords
    ? Math.round(haversineMeters(lat as number, lng as number, placeLat, placeLng))
    : null;

  const accessibility = await computeAccessibility(
    placeLat,
    placeLng,
    d.wheelchair,
    d.wheelchairPartial,
  );

  return {
    id: d.id,
    source: "google",
    name: d.name,
    address: d.formattedAddress,
    location: googleToLocation(d as GooglePlaceDetails & { location: { latitude: number; longitude: number } }),
    category: null,
    distanceMeters,
    rating: d.rating,
    accessibility,
    attribution: GOOGLE_ATTRIBUTION,
  };
}
