import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("axios", () => ({ default: { post: vi.fn() } }));

import axios from "axios";
import { searchPlaces } from "./google.adapter";

const mockPost = axios.post as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
});

describe("searchPlaces distance ordering", () => {
  it("requests extra candidates and returns the locally nearest places first", async () => {
    mockPost.mockResolvedValue({
      data: {
        places: [
          { id: "far", displayName: { text: "較遠站" }, formattedAddress: "far", location: { latitude: 25.06, longitude: 121.52 } },
          { id: "near", displayName: { text: "最近站" }, formattedAddress: "near", location: { latitude: 25.048, longitude: 121.5171 } },
          { id: "middle", displayName: { text: "中間站" }, formattedAddress: "middle", location: { latitude: 25.05, longitude: 121.518 } },
        ],
      },
    });

    const places = await searchPlaces("火車站", {
      latitude: 25.0478,
      longitude: 121.517,
      maxResults: 2,
      sortByDistance: true,
    });

    expect(mockPost).toHaveBeenCalledWith(
      "https://places.googleapis.com/v1/places:searchText",
      expect.objectContaining({ maxResultCount: 10, languageCode: "zh-TW" }),
      expect.any(Object),
    );
    expect(places.map((place) => place.name)).toEqual(["最近站", "中間站"]);
    expect(places[0].distanceMeters).toBeLessThan(places[1].distanceMeters!);
  });

  it("preserves upstream relevance order when no GPS is supplied", async () => {
    mockPost.mockResolvedValue({
      data: {
        places: [
          { id: "a", displayName: { text: "第一筆" }, formattedAddress: "a", location: { latitude: 25, longitude: 121 } },
          { id: "b", displayName: { text: "第二筆" }, formattedAddress: "b", location: { latitude: 24, longitude: 120 } },
        ],
      },
    });

    const places = await searchPlaces("火車站");

    expect(places.map((place) => place.name)).toEqual(["第一筆", "第二筆"]);
    expect(places[0].distanceMeters).toBeUndefined();
  });

  it("drops malformed coordinates without losing valid nearby candidates", async () => {
    mockPost.mockResolvedValue({
      data: {
        places: [
          { id: "missing", displayName: { text: "缺座標" }, formattedAddress: "missing" },
          { id: "nan", displayName: { text: "壞座標" }, formattedAddress: "nan", location: { latitude: Number.NaN, longitude: 121 } },
          { id: "far", displayName: { text: "較遠站" }, formattedAddress: "far", location: { latitude: 25.06, longitude: 121.52 } },
          { id: "near", displayName: { text: "最近站" }, formattedAddress: "near", location: { latitude: 25.048, longitude: 121.5171 } },
        ],
      },
    });

    const places = await searchPlaces("火車站", {
      latitude: 25.0478,
      longitude: 121.517,
      sortByDistance: true,
    });

    expect(places.map((place) => place.name)).toEqual(["最近站", "較遠站"]);
  });
});
