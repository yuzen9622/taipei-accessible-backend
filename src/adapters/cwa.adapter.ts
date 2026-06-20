/**
 * CWA open-data HTTP I/O for weather. Performs the two-stage nearest-point
 * lookup (089 county feed → township feed) and returns the raw nearest `Location`
 * payload; field normalization is the parser's job. All failures are thrown via
 * `withResilience`; raw datastore responses are cached per resource id.
 */
import { haversineMeters } from "../utils/geo";
import { redisGet, redisSet } from "../config/redis";
import {
  UpstreamBadPayloadError,
  UpstreamHttpError,
  withResilience,
} from "../config/resilience";
import {
  CWA_COUNTY_RESOURCE_ID,
  CWA_DATASTORE_BASE_URL,
  CWA_WEATHER_ELEMENTS,
  ENV_CACHE_TTL_SEC,
  cwaRawCacheKey,
} from "../constants/environment";
import { CWA_COUNTY_RESOURCE_IDS } from "../constants/cwa-county-codes";
import type { CwaLocation } from "../modules/environment/environment.types";

const CIRCUIT_KEY = "cwa";

interface CwaDatastoreResponse {
  records?: { Locations?: Array<{ Location?: CwaLocation[] }> };
}

function nearest(
  locations: CwaLocation[],
  lat: number,
  lng: number,
): CwaLocation {
  let best = locations[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const loc of locations) {
    const distance = haversineMeters(
      lat,
      lng,
      Number(loc.Latitude),
      Number(loc.Longitude),
    );
    if (distance < bestDistance) {
      bestDistance = distance;
      best = loc;
    }
  }
  return best;
}

async function fetchDatastore(resourceId: string): Promise<CwaLocation[]> {
  const cacheKey = cwaRawCacheKey(resourceId);
  const cached = await redisGet(cacheKey);
  if (cached) {
    return JSON.parse(cached) as CwaLocation[];
  }

  const key = process.env.CWA_API_KEY ?? "";
  const elements = encodeURIComponent(CWA_WEATHER_ELEMENTS.join(","));
  const url =
    `${CWA_DATASTORE_BASE_URL}/${resourceId}` +
    `?Authorization=${key}&format=JSON&ElementName=${elements}`;

  const locations = await withResilience(CIRCUIT_KEY, async (signal) => {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new UpstreamHttpError(res.status);

    const data = (await res.json()) as CwaDatastoreResponse;
    const list = data.records?.Locations?.[0]?.Location;
    if (!Array.isArray(list) || list.length === 0) {
      throw new UpstreamBadPayloadError(
        `CWA datastore ${resourceId} returned no locations`,
      );
    }
    return list;
  });

  await redisSet(
    cacheKey,
    JSON.stringify(locations),
    ENV_CACHE_TTL_SEC.WEATHER,
  );
  return locations;
}

/**
 * Resolves the weather observation `Location` closest to a coordinate using the
 * two-stage scheme: pick the nearest of the 22 county points, then the nearest
 * township within that county's feed.
 *
 * @param lat Query latitude.
 * @param lng Query longitude.
 * @returns The raw nearest township `Location` (with its `WeatherElement` array).
 * @throws ResilienceError on upstream failure, or when the county has no known feed.
 */
export async function fetchNearestWeather(
  lat: number,
  lng: number,
): Promise<CwaLocation> {
  const counties = await fetchDatastore(CWA_COUNTY_RESOURCE_ID);
  const county = nearest(counties, lat, lng).LocationName;

  const resourceId = CWA_COUNTY_RESOURCE_IDS[county];
  if (!resourceId) {
    throw new UpstreamBadPayloadError(
      `No CWA township feed mapped for county ${county}`,
    );
  }

  const districts = await fetchDatastore(resourceId);
  return nearest(districts, lat, lng);
}
