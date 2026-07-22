import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../adapters/google.adapter", () => ({
  autocompletePlaces: vi.fn(),
  getPlaceDetails: vi.fn(),
}));
vi.mock("../../config/redis", () => ({
  redisGet: vi.fn(),
  redisSet: vi.fn(),
}));
vi.mock("../campus/campus.service", () => ({
  findFacilitiesNearby: vi.fn(),
}));
vi.mock("../../model/a11y.model", () => ({ default: { find: vi.fn() } }));
vi.mock("../../model/osm-a11y.model", () => ({ default: { find: vi.fn() } }));
vi.mock("../../model/bathroom.model", () => ({ default: { find: vi.fn() } }));
vi.mock("../../model/disabled-parking.model", () => ({ default: { find: vi.fn() } }));

import * as service from "./place-search.service";
import { autocompletePlaces, getPlaceDetails } from "../../adapters/google.adapter";
import { redisGet, redisSet } from "../../config/redis";
import * as campusService from "../campus/campus.service";
import A11y from "../../model/a11y.model";
import OsmA11y from "../../model/osm-a11y.model";
import BathroomModel from "../../model/bathroom.model";
import DisabledParkingModel from "../../model/disabled-parking.model";

/** Makes a model's `.find().lean()` resolve to the given docs. */
function stubFind(model: { find: unknown }, docs: unknown[]) {
  vi.mocked(model.find as any).mockReturnValue({ lean: () => Promise.resolve(docs) });
}

function stubAllModelsEmpty() {
  stubFind(A11y as any, []);
  stubFind(OsmA11y as any, []);
  stubFind(BathroomModel as any, []);
  stubFind(DisabledParkingModel as any, []);
  vi.mocked(campusService.findFacilitiesNearby).mockResolvedValue([] as any);
}

const googleDetails = (overrides: Partial<any> = {}) => ({
  id: "ChIJ123",
  name: "台北101",
  formattedAddress: "台北市信義區信義路五段7號",
  location: { latitude: 25.0339, longitude: 121.5645 },
  rating: 4.5,
  wheelchair: null,
  wheelchairPartial: false,
  ...overrides,
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(redisGet).mockResolvedValue(null);
  vi.mocked(redisSet).mockResolvedValue(undefined);
});

describe("autocomplete", () => {
  it("maps adapter suggestions to items and caches them on a miss", async () => {
    vi.mocked(autocompletePlaces).mockResolvedValue([
      { placeId: "p1", primaryText: "台北101", secondaryText: "信義區" },
      { placeId: "p2", primaryText: "台北車站", secondaryText: null },
    ]);

    const items = await service.autocomplete({ q: "台北", sessionToken: "tok", lat: 25.03, lng: 121.5 });

    expect(items).toEqual([
      { placeId: "p1", primaryText: "台北101", secondaryText: "信義區" },
      { placeId: "p2", primaryText: "台北車站", secondaryText: null },
    ]);
    expect(autocompletePlaces).toHaveBeenCalledWith("台北", {
      sessionToken: "tok",
      latitude: 25.03,
      longitude: 121.5,
    });
    expect(redisSet).toHaveBeenCalledOnce();
  });

  it("returns cached items without calling Google", async () => {
    vi.mocked(redisGet).mockResolvedValue(
      JSON.stringify([{ placeId: "c1", primaryText: "cached", secondaryText: null }]),
    );

    const items = await service.autocomplete({ q: "台北" });

    expect(items).toEqual([{ placeId: "c1", primaryText: "cached", secondaryText: null }]);
    expect(autocompletePlaces).not.toHaveBeenCalled();
  });

  it("treats malformed cache as a miss", async () => {
    vi.mocked(redisGet).mockResolvedValue("not json{{");
    vi.mocked(autocompletePlaces).mockResolvedValue([]);

    const items = await service.autocomplete({ q: "台北" });

    expect(items).toEqual([]);
    expect(autocompletePlaces).toHaveBeenCalledOnce();
  });

  it("degrades to an empty list when the adapter returns nothing", async () => {
    vi.mocked(autocompletePlaces).mockResolvedValue([]);
    expect(await service.autocomplete({ q: "zzz" })).toEqual([]);
  });
});

describe("details", () => {
  it("returns null when the adapter returns null", async () => {
    vi.mocked(getPlaceDetails).mockResolvedValue(null);
    expect(await service.details({ placeId: "x" })).toBeNull();
  });

  it("returns null when the place has no coordinates", async () => {
    vi.mocked(getPlaceDetails).mockResolvedValue(googleDetails({ location: null }) as any);
    expect(await service.details({ placeId: "x" })).toBeNull();
  });

  it("swaps coordinates to [lng, lat] and computes distance when user coords given", async () => {
    vi.mocked(getPlaceDetails).mockResolvedValue(googleDetails() as any);
    stubAllModelsEmpty();

    const result = await service.details({ placeId: "ChIJ123", lat: 25.0339, lng: 121.5645 });

    expect(result?.location).toEqual({ type: "Point", coordinates: [121.5645, 25.0339] });
    expect(result?.distanceMeters).toBe(0);
    expect(result?.source).toBe("google");
    expect(result?.attribution).toBe("Powered by Google");
  });

  it("leaves distance null when no user coordinates are supplied", async () => {
    vi.mocked(getPlaceDetails).mockResolvedValue(googleDetails() as any);
    stubAllModelsEmpty();

    const result = await service.details({ placeId: "ChIJ123" });
    expect(result?.distanceMeters).toBeNull();
  });

  describe("accessibility", () => {
    it("is accessible/local-db when a local facility is nearby", async () => {
      vi.mocked(getPlaceDetails).mockResolvedValue(googleDetails({ wheelchair: null }) as any);
      stubAllModelsEmpty();
      stubFind(A11y as any, [{ _id: "e1" }]);

      const r = await service.details({ placeId: "ChIJ123" });
      expect(r?.accessibility).toMatchObject({ status: "accessible", source: "local-db", nearbyFacilityCount: 1 });
    });

    it("is accessible/google when Google reports wheelchair yes and no local data", async () => {
      vi.mocked(getPlaceDetails).mockResolvedValue(googleDetails({ wheelchair: "yes" }) as any);
      stubAllModelsEmpty();

      const r = await service.details({ placeId: "ChIJ123" });
      expect(r?.accessibility).toMatchObject({ status: "accessible", wheelchair: "yes", source: "google" });
    });

    it("is limited/google when Google reports partial accessibility", async () => {
      vi.mocked(getPlaceDetails).mockResolvedValue(
        googleDetails({ wheelchair: "no", wheelchairPartial: true }) as any,
      );
      stubAllModelsEmpty();

      const r = await service.details({ placeId: "ChIJ123" });
      expect(r?.accessibility).toMatchObject({ status: "limited", wheelchair: "limited", source: "google" });
    });

    it("is unknown with wheelchair no when Google reports not accessible", async () => {
      vi.mocked(getPlaceDetails).mockResolvedValue(
        googleDetails({ wheelchair: "no", wheelchairPartial: false }) as any,
      );
      stubAllModelsEmpty();

      const r = await service.details({ placeId: "ChIJ123" });
      expect(r?.accessibility).toMatchObject({ status: "unknown", wheelchair: "no", source: "google" });
    });

    it("is unknown/none when neither side has data", async () => {
      vi.mocked(getPlaceDetails).mockResolvedValue(googleDetails({ wheelchair: null }) as any);
      stubAllModelsEmpty();

      const r = await service.details({ placeId: "ChIJ123" });
      expect(r?.accessibility).toMatchObject({ status: "unknown", wheelchair: null, source: "none" });
    });
  });
});
