import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

vi.mock("./place-search.service", async () => {
  const actual =
    await vi.importActual<typeof import("./place-search.service")>("./place-search.service");
  return {
    ...actual,
    autocomplete: vi.fn(),
    details: vi.fn(),
  };
});

import { buildTestApp } from "../../../tests/helpers/test-helpers";
import * as service from "./place-search.service";

const app = buildTestApp();
const BASE = "/api/v1/a11y";

const placeResult = (): service.PlaceResult => ({
  id: "ChIJ123",
  source: "google",
  name: "台北101",
  address: "台北市信義區信義路五段7號",
  location: { type: "Point", coordinates: [121.5645, 25.0339] },
  category: null,
  distanceMeters: 1200,
  rating: 4.5,
  accessibility: { status: "accessible", wheelchair: "yes", nearbyFacilityCount: 3, source: "local-db" },
  attribution: "Powered by Google",
});

beforeEach(() => {
  vi.resetAllMocks();
});

describe("GET /a11y/search/autocomplete", () => {
  it("returns 200 with the prediction list envelope", async () => {
    const items = [{ placeId: "ChIJ1", primaryText: "台北101", secondaryText: "信義區" }];
    vi.mocked(service.autocomplete).mockResolvedValue(items);

    const res = await request(app).get(`${BASE}/search/autocomplete`).query({ q: "台北", sessiontoken: "tok" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual(items);
    expect(service.autocomplete).toHaveBeenCalledWith({
      q: "台北",
      sessionToken: "tok",
      lat: undefined,
      lng: undefined,
    });
  });

  it("forwards parsed coordinates when provided", async () => {
    vi.mocked(service.autocomplete).mockResolvedValue([]);

    await request(app)
      .get(`${BASE}/search/autocomplete`)
      .query({ q: "台北", lat: "25.033", lng: "121.565" });

    expect(service.autocomplete).toHaveBeenCalledWith({
      q: "台北",
      sessionToken: undefined,
      lat: 25.033,
      lng: 121.565,
    });
  });

  it("returns 200 with an empty list when the service degrades", async () => {
    vi.mocked(service.autocomplete).mockResolvedValue([]);

    const res = await request(app).get(`${BASE}/search/autocomplete`).query({ q: "zzz" });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it("returns 400 when q is missing", async () => {
    const res = await request(app).get(`${BASE}/search/autocomplete`).query({ sessiontoken: "tok" });

    expect(res.status).toBe(400);
    expect(service.autocomplete).not.toHaveBeenCalled();
  });

  it("returns 400 on an unknown query key", async () => {
    const res = await request(app).get(`${BASE}/search/autocomplete`).query({ q: "台北", foo: "bar" });

    expect(res.status).toBe(400);
  });
});

describe("GET /a11y/search/details/:placeId", () => {
  it("returns 200 with a single PlaceResult", async () => {
    const data = placeResult();
    vi.mocked(service.details).mockResolvedValue(data);

    const res = await request(app)
      .get(`${BASE}/search/details/ChIJ123`)
      .query({ sessiontoken: "tok", lat: "25.03", lng: "121.5" });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(data);
    expect(service.details).toHaveBeenCalledWith({
      placeId: "ChIJ123",
      sessionToken: "tok",
      lat: 25.03,
      lng: 121.5,
    });
  });

  it("returns 404 when the place is unresolvable", async () => {
    vi.mocked(service.details).mockResolvedValue(null);

    const res = await request(app).get(`${BASE}/search/details/ChIJmissing`);

    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });
});
