import { encode } from "@googlemaps/polyline-codec";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeValhallaRoutes } from "../../../adapters/valhalla.adapter";
import { decodeValhallaShape, planValhallaRoute, ValhallaRoutingError } from "./valhalla-routing";

vi.mock("../../../adapters/valhalla.adapter", () => ({ computeValhallaRoutes: vi.fn() }));
const compute = vi.mocked(computeValhallaRoutes);
const points: [number, number][] = [[25.041, 121.567], [25.04, 121.565], [25.034, 121.564]];
const shape = encode(points, 6);
const normalizedTrip = {
  summary: { lengthKm: 1.5, timeSec: 125 },
  legs: [{ summary: { lengthKm: 1.5, timeSec: 125 }, shapePolyline6: shape, maneuvers: [
    { type: 1, instruction: "沿道路出發", lengthKm: 0.5, timeSec: 40, beginShapeIndex: 0, endShapeIndex: 1, streetNames: ["信義路"] },
    { type: 15, instruction: "左轉", lengthKm: 1, timeSec: 85, beginShapeIndex: 1, endShapeIndex: 2 },
  ] }],
};

describe("planValhallaRoute", () => {
  beforeEach(() => vi.resetAllMocks());
  it("decodes polyline6 to lng/lat", () => expect(decodeValhallaShape(shape)[0]).toEqual([121.567, 25.041]));

  it("maps drive trips and alternatives without traffic fields", async () => {
    compute.mockResolvedValue({ status: "OK", trips: [normalizedTrip, normalizedTrip] });
    const routes = await planValhallaRoute({ lat: 25, lng: 121 }, { lat: 25.1, lng: 121.1 }, { travelMode: "drive" });
    expect(routes.map((r) => r.routeId)).toEqual(["drive-0", "drive-1"]);
    expect(routes[0]).toMatchObject({ totalMinutes: 2, attribution: "© OpenStreetMap contributors" });
    expect(routes[0].legs[0]).toMatchObject({ type: "DRIVE", distanceM: 1500, durationMin: 2 });
    expect(routes[0].legs[0].type === "DRIVE" && routes[0].legs[0].steps?.[0].instruction).toBe("沿「信義路」出發");
    expect(routes[0].legs[0]).not.toHaveProperty("durationInTrafficMin");
  });

  it("maps walk steps using true shape locations", async () => {
    compute.mockResolvedValue({ status: "OK", trips: [normalizedTrip] });
    const routes = await planValhallaRoute({ lat: 25, lng: 121 }, { lat: 25.1, lng: 121.1 }, { travelMode: "walk" });
    expect(routes[0].legs[0]).toMatchObject({ type: "WALK" });
    expect(routes[0].legs[0].type === "WALK" && routes[0].legs[0].steps?.[0]).toMatchObject({ instruction: "沿「信義路」出發", location: [121.567, 25.041], relativeDirection: "DEPART" });
  });

  it("omits whole-leg steps for out-of-bounds guidance", async () => {
    compute.mockResolvedValue({ status: "OK", trips: [{ ...normalizedTrip, legs: [{ ...normalizedTrip.legs[0], maneuvers: [{ ...normalizedTrip.legs[0].maneuvers[0], endShapeIndex: 99 }] }] }] });
    const routes = await planValhallaRoute({ lat: 25, lng: 121 }, { lat: 25.1, lng: 121.1 }, { travelMode: "walk" });
    expect(routes[0].legs[0]).not.toHaveProperty("steps");
  });

  it("returns [] only for no route and throws typed errors otherwise", async () => {
    compute.mockResolvedValueOnce({ status: "NO_ROUTE", trips: [] });
    await expect(planValhallaRoute({ lat: 1, lng: 2 }, { lat: 3, lng: 4 }, { travelMode: "drive" })).resolves.toEqual([]);
    compute.mockResolvedValueOnce({ status: "UPSTREAM_ERROR", trips: [], httpStatus: 503 });
    await expect(planValhallaRoute({ lat: 1, lng: 2 }, { lat: 3, lng: 4 }, { travelMode: "drive" })).rejects.toBeInstanceOf(ValhallaRoutingError);
  });
});
