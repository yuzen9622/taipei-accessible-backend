import axios from "axios";

const MAPS_KEY = () => process.env.GOOGLE_MAPS_API_KEY ?? "";

// ─── Reverse Geocoding ────────────────────────────────────────────────────────

/**
 * Returns the English-style administrative area name used by TDX
 * (e.g. "Taipei", "NewTaipei", "Taichung").
 */
export async function getCity(lat: number, lng: number): Promise<string> {
  const geocode = await fetch(
    `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${MAPS_KEY()}`,
  );
  const data = (await geocode.json()) as any;
  if (!data.results || data.results.length === 0) {
    throw new Error(`Geocoding failed: ${data.status ?? "NO_RESULTS"}`);
  }
  return data.results[0].address_components
    .find((c: any) => c.types.includes("administrative_area_level_1"))
    ?.long_name.replace("City", "")
    .replace(" ", "") as string;
}

/**
 * Returns the Chinese city name used by STA air-quality API
 * (e.g. "臺北市", "臺中市").
 */
export async function getCityZh(lat: number, lng: number): Promise<string> {
  const geocode = await fetch(
    `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${MAPS_KEY()}&language=zh-TW`,
  );
  const data = (await geocode.json()) as any;
  let city = "臺北市";
  const cityComp = data?.results?.[0]?.address_components?.find((c: any) =>
    c.types.includes("administrative_area_level_1"),
  );
  if (cityComp) city = (cityComp.long_name as string).replace("台", "臺");
  return city;
}

// ─── Places Text Search → Coordinates ────────────────────────────────────────

/**
 * Resolves a free-text query to coordinates via Google Places Text Search.
 * Returns null when the query matches no places or the API key is missing.
 */
export async function getCoordinates(
  query: string,
  latitude?: number,
  longitude?: number,
): Promise<{ latitude: number; longitude: number } | null> {
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
    return response.data.places?.[0]?.location ?? null;
  } catch {
    return null;
  }
}

// ─── Places Text Search → Place List ─────────────────────────────────────────

export interface GooglePlace {
  name: string;
  place_id: string;
  formatted_address: string;
  rating?: number;
  location: { latitude: number; longitude: number };
}

/**
 * Searches for up to `maxResults` places matching the query, optionally biased
 * toward the given coordinates.
 */
export async function searchPlaces(
  query: string,
  opts: { latitude?: number; longitude?: number; maxResults?: number } = {},
): Promise<GooglePlace[]> {
  const key = MAPS_KEY();
  if (!key) return [];

  const body: Record<string, unknown> = {
    textQuery: query,
    languageCode: "zh-TW",
    maxResultCount: opts.maxResults ?? 3,
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
    return places.map((p: any) => ({
      name: p.displayName?.text ?? "未知名稱",
      place_id: p.id,
      formatted_address: p.formattedAddress,
      rating: p.rating,
      location: p.location,
    }));
  } catch {
    return [];
  }
}
