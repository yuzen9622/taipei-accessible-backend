import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("axios", () => ({
  default: {
    get: vi.fn(),
    isAxiosError: (e: unknown) => !!(e as { isAxiosError?: boolean })?.isAxiosError,
  },
}));

import axios from "axios";
import { computeTomTomRoutes } from "./tomtom.adapter";

const mockGet = vi.mocked(axios.get);
const origin = { lat: 25.04, lng: 121.56 };
const destination = { lat: 25.03, lng: 121.55 };

function motorcycleRoute(sectionTravelModes: string[]) {
  return {
    summary: { lengthInMeters: 1000, travelTimeInSeconds: 300 },
    legs: [
      {
        summary: { lengthInMeters: 1000, travelTimeInSeconds: 300 },
        points: [
          { latitude: 25.04, longitude: 121.56 },
          { latitude: 25.03, longitude: 121.55 },
        ],
      },
    ],
    sections: sectionTravelModes.map((travelMode) => ({
      sectionType: "TRAVEL_MODE",
      travelMode,
    })),
  };
}

function axiosError(status: number, detailedError?: { code?: string; message?: string }) {
  return {
    isAxiosError: true,
    response: { status, data: { detailedError } },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  process.env.TOMTOM_API_KEY = "test-key";
});

describe("computeTomTomRoutes", () => {
  it("assembles the locations path from origin, capped waypoints and destination", async () => {
    mockGet.mockResolvedValue({
      data: { routes: [motorcycleRoute(["car"])] },
    } as any);

    await computeTomTomRoutes({ origin, destination, travelMode: "car" });
    expect(mockGet.mock.calls[0][0]).toContain(
      "/25.04,121.56:25.03,121.55/json",
    );

    const waypoints = Array.from({ length: 6 }, (_, i) => ({
      lat: 25.0 + i,
      lng: 121.5,
    }));
    await computeTomTomRoutes({
      origin,
      destination,
      waypoints,
      travelMode: "car",
    });
    const url = mockGet.mock.calls[1][0] as string;
    expect(url).toContain(
      "/25.04,121.56:25,121.5:26,121.5:27,121.5:28,121.5:29,121.5:25.03,121.55/json",
    );
    expect(url).not.toContain("30,121.5");
  });

  it("keeps only fully supported motorcycle alternatives in a mixed response", async () => {
    const supported = motorcycleRoute(["motorcycle"]);
    const degraded = motorcycleRoute(["motorcycle", "other"]);
    mockGet.mockResolvedValue({
      data: { routes: [supported, degraded] },
    } as any);

    const result = await computeTomTomRoutes({
      origin,
      destination,
      travelMode: "motorcycle",
    });

    expect(result.status).toBe("OK");
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).toBe(supported);
  });

  it("returns UNSUPPORTED_MODE when every motorcycle route contains an 'other' section", async () => {
    mockGet.mockResolvedValue({
      data: { routes: [motorcycleRoute(["other"]), motorcycleRoute(["car", "other"])] },
    } as any);

    const result = await computeTomTomRoutes({
      origin,
      destination,
      travelMode: "motorcycle",
    });

    expect(result.status).toBe("UNSUPPORTED_MODE");
    expect(result.routes).toEqual([]);
  });

  it("maps NO_ROUTE_FOUND and MAP_MATCHING_FAILURE 4xx responses to NO_ROUTE", async () => {
    mockGet.mockRejectedValueOnce(
      axiosError(400, { code: "NO_ROUTE_FOUND", message: "no route" }),
    );
    let result = await computeTomTomRoutes({
      origin,
      destination,
      travelMode: "car",
    });
    expect(result.status).toBe("NO_ROUTE");

    mockGet.mockRejectedValueOnce(
      axiosError(400, { code: "MAP_MATCHING_FAILURE", message: "off road" }),
    );
    result = await computeTomTomRoutes({
      origin,
      destination,
      travelMode: "car",
    });
    expect(result.status).toBe("NO_ROUTE");
  });

  it("maps 429 and timeouts to UPSTREAM_ERROR", async () => {
    mockGet.mockRejectedValueOnce(axiosError(429, { code: "TOO_MANY_REQUESTS" }));
    let result = await computeTomTomRoutes({
      origin,
      destination,
      travelMode: "car",
    });
    expect(result.status).toBe("UPSTREAM_ERROR");
    expect(result.httpStatus).toBe(429);

    mockGet.mockRejectedValueOnce(new Error("The operation was aborted due to timeout"));
    result = await computeTomTomRoutes({
      origin,
      destination,
      travelMode: "car",
    });
    expect(result.status).toBe("UPSTREAM_ERROR");
  });

  it("sends traffic/departAt only for traffic-aware motorized requests", async () => {
    mockGet.mockResolvedValue({
      data: { routes: [motorcycleRoute(["car"])] },
    } as any);

    await computeTomTomRoutes({
      origin,
      destination,
      travelMode: "car",
      trafficAware: true,
      departureTime: "2030-01-01T10:00:00.000Z",
      computeAlternatives: true,
    });
    const driveParams = (mockGet.mock.calls[0][1] as any).params;
    expect(driveParams.traffic).toBe(true);
    expect(driveParams.departAt).toBe("2030-01-01T10:00:00.000Z");
    expect(driveParams.maxAlternatives).toBe(2);
    expect(driveParams.language).toBe("zh-TW");

    await computeTomTomRoutes({
      origin,
      destination,
      travelMode: "pedestrian",
      trafficAware: true,
      departureTime: "2030-01-01T10:00:00.000Z",
    });
    const walkParams = (mockGet.mock.calls[1][1] as any).params;
    expect(walkParams.traffic).toBeUndefined();
    expect(walkParams.departAt).toBeUndefined();
  });
});
