import axios from "axios";

const MAPS_KEY = () => process.env.GOOGLE_MAPS_API_KEY ?? "";

const cityCache = new Map<string, string>();
const cityZhCache = new Map<string, string>();
const coordsCache = new Map<string, { latitude: number; longitude: number } | null>();

/**
 * Returns the English-style administrative area name used by TDX
 * (e.g. "Taipei", "NewTaipei", "Taichung").
 *
 * @param lat Latitude
 * @param lng Longitude
 * @returns The TDX-style city name
 */
export async function getCity(lat: number, lng: number): Promise<string> {
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  const hit = cityCache.get(key);
  if (hit) return hit;

  const geocode = await fetch(
    `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${MAPS_KEY()}`,
  );
  const data = (await geocode.json()) as any;
  if (!data.results || data.results.length === 0) {
    throw new Error(`Geocoding failed: ${data.status ?? "NO_RESULTS"}`);
  }
  const result = data.results[0].address_components
    .find((c: any) => c.types.includes("administrative_area_level_1"))
    ?.long_name.replace("City", "")
    .replace(" ", "") as string;
  
  if (result) {
    cityCache.set(key, result);
  }
  return result;
}

/**
 * Returns the Chinese city name used by STA air-quality API
 * (e.g. "臺北市", "臺中市").
 *
 * @param lat Latitude
 * @param lng Longitude
 * @returns The Chinese city name
 */
export async function getCityZh(lat: number, lng: number): Promise<string> {
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  const hit = cityZhCache.get(key);
  if (hit) return hit;

  const geocode = await fetch(
    `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${MAPS_KEY()}&language=zh-TW`,
  );
  const data = (await geocode.json()) as any;
  let city = "臺北市";
  const cityComp = data?.results?.[0]?.address_components?.find((c: any) =>
    c.types.includes("administrative_area_level_1"),
  );
  if (cityComp) city = (cityComp.long_name as string).replace("台", "臺");
  
  cityZhCache.set(key, city);
  return city;
}

/**
 * Resolves a free-text query to coordinates via Google Places Text Search.
 * Returns null when the query matches no places or the API key is missing.
 *
 * @param query Free-text place query
 * @param latitude Optional bias latitude
 * @param longitude Optional bias longitude
 * @returns The matched coordinates, or null
 */
export async function getCoordinates(
  query: string,
  latitude?: number,
  longitude?: number,
): Promise<{ latitude: number; longitude: number } | null> {
  const trimmed = query.trim().toLowerCase();
  const cacheKey = latitude && longitude 
    ? `${trimmed}|${latitude.toFixed(3)},${longitude.toFixed(3)}` 
    : trimmed;
  
  if (coordsCache.has(cacheKey)) {
    return coordsCache.get(cacheKey)!;
  }

  if (!MAPS_KEY()) return null;

  const body: Record<string, unknown> = {
    textQuery: query,
    maxResultCount: 1,
    regionCode: "TW",
  };
  if (latitude && longitude) {
    body.locationBias = { circle: { center: { latitude, longitude }, radius: 50000.0 } };
  }

  try {
    const response = await axios.post("https://places.googleapis.com/v1/places:searchText", body, {
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": MAPS_KEY(),
        "X-Goog-FieldMask": "places.location",
      },
    });
    const result = response.data.places?.[0]?.location ?? null;
    coordsCache.set(cacheKey, result);
    return result;
  } catch {
    coordsCache.set(cacheKey, null);
    return null;
  }
}

export interface GooglePlace {
  name: string;
  place_id: string;
  formatted_address: string;
  rating?: number;
  location: { latitude: number; longitude: number };
  distanceMeters?: number;
}

function haversineDistanceMeters(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): number {
  const earthRadiusM = 6_371_000;
  const toRadians = (degrees: number): number => degrees * Math.PI / 180;
  const deltaLat = toRadians(to.latitude - from.latitude);
  const deltaLng = toRadians(to.longitude - from.longitude);
  const fromLat = toRadians(from.latitude);
  const toLat = toRadians(to.latitude);
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(fromLat) * Math.cos(toLat) * Math.sin(deltaLng / 2) ** 2;
  return 2 * earthRadiusM * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
}

function hasValidLocation(
  place: GooglePlace,
): place is GooglePlace & { location: { latitude: number; longitude: number } } {
  const { latitude, longitude } = place.location ?? {};
  return typeof latitude === "number"
    && Number.isFinite(latitude)
    && latitude >= -90
    && latitude <= 90
    && typeof longitude === "number"
    && Number.isFinite(longitude)
    && longitude >= -180
    && longitude <= 180;
}

/**
 * Searches for up to `maxResults` places matching the query, optionally biased
 * toward the given coordinates.
 *
 * @param query Free-text place query
 * @param opts Optional bias coordinates and result limit
 * @returns The matched places
 */
export async function searchPlaces(
  query: string,
  opts: {
    latitude?: number;
    longitude?: number;
    maxResults?: number;
    sortByDistance?: boolean;
  } = {},
): Promise<GooglePlace[]> {
  const key = MAPS_KEY();
  if (!key) return [];

  const body: Record<string, unknown> = {
    textQuery: query,
    languageCode: "zh-TW",
    maxResultCount: opts.sortByDistance ? 10 : opts.maxResults ?? 3,
  };
  if (opts.latitude !== undefined && opts.longitude !== undefined) {
    body.locationBias = {
      circle: { center: { latitude: opts.latitude, longitude: opts.longitude }, radius: 1000.0 },
    };
  }

  try {
    const response = await axios.post(
      "https://places.googleapis.com/v1/places:searchText",
      body,
      {
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask":
            "places.id,places.displayName,places.formattedAddress,places.rating,places.location",
        },
      },
    );
    const { places } = response.data;
    if (!places?.length) return [];
    const mapped: GooglePlace[] = places.map((p: any) => ({
      name: p.displayName?.text ?? "未知名稱",
      place_id: p.id,
      formatted_address: p.formattedAddress,
      rating: p.rating,
      location: p.location,
    }));
    if (opts.sortByDistance && opts.latitude !== undefined && opts.longitude !== undefined) {
      const origin = { latitude: opts.latitude, longitude: opts.longitude };
      return mapped
        .filter(hasValidLocation)
        .map((place) => ({
          ...place,
          distanceMeters: Math.round(haversineDistanceMeters(origin, place.location)),
        }))
        .sort((a, b) => (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity))
        .slice(0, opts.maxResults ?? 3);
    }
    return mapped;
  } catch {
    return [];
  }
}

export type GoogleTravelMode = "DRIVE" | "TWO_WHEELER" | "WALK";

export interface GoogleRouteStep {
  distanceMeters?: number;
  staticDuration?: string;
  polyline?: { encodedPolyline?: string };
  navigationInstruction?: { maneuver?: string; instructions?: string };
}

export interface GoogleLatLng {
  latitude?: number;
  longitude?: number;
}

export interface GoogleRouteLeg {
  distanceMeters?: number;
  duration?: string;
  staticDuration?: string;
  polyline?: { encodedPolyline?: string };
  startLocation?: { latLng?: GoogleLatLng };
  endLocation?: { latLng?: GoogleLatLng };
  steps?: GoogleRouteStep[];
}

export interface GoogleRoute {
  distanceMeters?: number;
  duration?: string;
  staticDuration?: string;
  polyline?: { encodedPolyline?: string };
  description?: string;
  legs?: GoogleRouteLeg[];
}

export interface ComputeRoutesParams {
  origin: { lat: number; lng: number };
  destination: { lat: number; lng: number };
  intermediates?: { lat: number; lng: number }[];
  travelMode: GoogleTravelMode;
  departureTime?: string;
  trafficAware?: boolean;
  computeAlternatives?: boolean;
}

export type ComputeRoutesStatus =
  | "OK"
  | "NO_ROUTE"
  | "UNSUPPORTED_MODE"
  | "UPSTREAM_ERROR";

export interface ComputeRoutesResult {
  status: ComputeRoutesStatus;
  routes: GoogleRoute[];
  httpStatus?: number;
}

const ROUTES_FIELD_MASK = [
  "routes.duration",
  "routes.staticDuration",
  "routes.distanceMeters",
  "routes.polyline.encodedPolyline",
  "routes.description",
  "routes.legs.duration",
  "routes.legs.staticDuration",
  "routes.legs.distanceMeters",
  "routes.legs.polyline.encodedPolyline",
  "routes.legs.startLocation.latLng",
  "routes.legs.endLocation.latLng",
  "routes.legs.steps.navigationInstruction",
  "routes.legs.steps.distanceMeters",
  "routes.legs.steps.staticDuration",
  "routes.legs.steps.polyline.encodedPolyline",
].join(",");

/**
 * Compute driving / two-wheeler / walking routes via the Google Routes API
 * (directions/v2:computeRoutes). routingPreference + departureTime yield
 * traffic-aware durations for DRIVE / TWO_WHEELER; intermediates add ordered
 * waypoints. Never throws — upstream failures are reported via `status`.
 *
 * @param p Route request (coords in {lat,lng}, RFC3339 departureTime).
 * @returns The matched routes plus a status; routes[] is empty unless OK.
 */
export async function computeGoogleRoutes(
  p: ComputeRoutesParams,
): Promise<ComputeRoutesResult> {
  const key = MAPS_KEY();
  if (!key) return { status: "UPSTREAM_ERROR", routes: [] };

  const toWaypoint = (c: { lat: number; lng: number }) => ({
    location: { latLng: { latitude: c.lat, longitude: c.lng } },
  });

  const body: Record<string, unknown> = {
    origin: toWaypoint(p.origin),
    destination: toWaypoint(p.destination),
    travelMode: p.travelMode,
    // HIGH_QUALITY keeps far more points than the default OVERVIEW, so the line
    // hugs the road instead of cutting corners when drawn on an OSM basemap.
    polylineQuality: "HIGH_QUALITY",
    languageCode: "zh-TW",
    regionCode: "TW",
    units: "METRIC",
  };
  if (p.intermediates?.length) {
    body.intermediates = p.intermediates.map(toWaypoint);
  }
  // routingPreference / departureTime only apply to motorized modes.
  if (p.trafficAware && p.travelMode !== "WALK") {
    body.routingPreference = "TRAFFIC_AWARE_OPTIMAL";
  }
  if (p.departureTime && p.travelMode !== "WALK") {
    body.departureTime = p.departureTime;
  }
  // The Routes API rejects alternatives when intermediate waypoints are set.
  if (p.computeAlternatives && !p.intermediates?.length) {
    body.computeAlternativeRoutes = true;
  }

  try {
    const response = await axios.post(
      "https://routes.googleapis.com/directions/v2:computeRoutes",
      body,
      {
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask": ROUTES_FIELD_MASK,
        },
      },
    );
    const routes = (response.data?.routes ?? []) as GoogleRoute[];
    return routes.length
      ? { status: "OK", routes }
      : { status: "NO_ROUTE", routes: [] };
  } catch (err) {
    const httpStatus = axios.isAxiosError(err)
      ? err.response?.status
      : undefined;
    // A 400 for TWO_WHEELER almost always means the mode is unavailable in
    // this region → let the caller fall back to DRIVE rather than 503.
    if (httpStatus === 400 && p.travelMode === "TWO_WHEELER") {
      return { status: "UNSUPPORTED_MODE", routes: [], httpStatus };
    }
    return { status: "UPSTREAM_ERROR", routes: [], httpStatus };
  }
}
