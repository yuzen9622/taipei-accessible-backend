import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../adapters/google.adapter", () => ({
  computeGoogleRoutes: vi.fn(),
}));

import { computeGoogleRoutes } from "../../../adapters/google.adapter";
import { planGoogleRoute, GoogleRoutingError } from "./google-routing";

const mockCompute = vi.mocked(computeGoogleRoutes);
const origin = { lat: 25.04, lng: 121.56 };
const destination = { lat: 25.03, lng: 121.55 };

function driveRoute() {
  return {
    distanceMeters: 5200,
    duration: "780s",
    staticDuration: "600s",
    description: "建國高架",
    legs: [
      {
        distanceMeters: 5200,
        duration: "780s",
        staticDuration: "600s",
        startLocation: { latLng: { latitude: 25.04, longitude: 121.56 } },
        endLocation: { latLng: { latitude: 25.03, longitude: 121.55 } },
        steps: [
          {
            distanceMeters: 240,
            staticDuration: "60s",
            navigationInstruction: {
              maneuver: "TURN_LEFT",
              instructions: "左轉信義路",
            },
          },
        ],
      },
    ],
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("planGoogleRoute", () => {
  it("maps a drive route to a DRIVE leg with traffic-aware minutes and steps", async () => {
    mockCompute.mockResolvedValue({ status: "OK", routes: [driveRoute()] } as any);

    const routes = await planGoogleRoute(origin, destination, {
      travelMode: "drive",
    });

    expect(routes).toHaveLength(1);
    expect(routes[0].transferCount).toBe(0);
    expect(routes[0].totalMinutes).toBe(13); // 780s
    expect(routes[0].routeName).toContain("開車");

    const leg = routes[0].legs[0] as any;
    expect(leg.type).toBe("DRIVE");
    expect(leg.durationMin).toBe(10); // 600s
    expect(leg.durationInTrafficMin).toBe(13); // 780s
    expect(leg.trafficLevel).toBe("moderate"); // 13/10 = 1.3
    expect(leg.from).toEqual({ lat: 25.04, lng: 121.56 });
    expect(leg.to).toEqual({ lat: 25.03, lng: 121.55 });
    expect(leg.steps[0].instruction).toBe("左轉信義路");
    expect(leg.steps[0].maneuver).toBe("TURN_LEFT");

    // drive is traffic-aware
    expect(mockCompute.mock.calls[0][0].travelMode).toBe("DRIVE");
    expect(mockCompute.mock.calls[0][0].trafficAware).toBe(true);
  });

  it("passes a future departure time (ISO) to the adapter for drive", async () => {
    mockCompute.mockResolvedValue({ status: "OK", routes: [driveRoute()] } as any);
    const departureTime = new Date("2030-01-01T10:00:00Z");

    await planGoogleRoute(origin, destination, {
      travelMode: "drive",
      departureTime,
    });

    expect(mockCompute.mock.calls[0][0].departureTime).toBe(
      departureTime.toISOString(),
    );
  });

  it("falls back to DRIVE when TWO_WHEELER is unsupported, flagging modeFallback", async () => {
    mockCompute
      .mockResolvedValueOnce({ status: "UNSUPPORTED_MODE", routes: [] } as any)
      .mockResolvedValueOnce({ status: "OK", routes: [driveRoute()] } as any);

    const routes = await planGoogleRoute(origin, destination, {
      travelMode: "motorcycle",
    });

    expect(mockCompute).toHaveBeenCalledTimes(2);
    expect(mockCompute.mock.calls[0][0].travelMode).toBe("TWO_WHEELER");
    expect(mockCompute.mock.calls[1][0].travelMode).toBe("DRIVE");

    const leg = routes[0].legs[0] as any;
    expect(leg.type).toBe("MOTORCYCLE"); // keeps the requested mode label
    expect(leg.modeFallback).toBe("DRIVE");
    expect(routes[0].routeName).toContain("騎車");
  });

  it("maps a walk route to WALK legs and does not request traffic", async () => {
    mockCompute.mockResolvedValue({
      status: "OK",
      routes: [
        {
          duration: "600s",
          staticDuration: "600s",
          legs: [
            {
              distanceMeters: 800,
              staticDuration: "600s",
              startLocation: { latLng: { latitude: 25.04, longitude: 121.56 } },
              endLocation: { latLng: { latitude: 25.05, longitude: 121.57 } },
            },
          ],
        },
      ],
    } as any);

    const routes = await planGoogleRoute(origin, destination, {
      travelMode: "walk",
    });

    const leg = routes[0].legs[0] as any;
    expect(leg.type).toBe("WALK");
    expect(leg.distanceM).toBe(800);
    expect(leg.minutesEst).toBe(10);
    expect(leg.a11yFacilities).toEqual([]);
    expect(routes[0].totalWalkDistanceM).toBe(800);
    expect(mockCompute.mock.calls[0][0].travelMode).toBe("WALK");
    expect(mockCompute.mock.calls[0][0].trafficAware).toBe(false);
  });

  it("returns [] when no route exists", async () => {
    mockCompute.mockResolvedValue({ status: "NO_ROUTE", routes: [] } as any);

    const routes = await planGoogleRoute(origin, destination, {
      travelMode: "drive",
    });

    expect(routes).toEqual([]);
  });

  it("throws GoogleRoutingError on upstream error", async () => {
    mockCompute.mockResolvedValue({
      status: "UPSTREAM_ERROR",
      routes: [],
      httpStatus: 403,
    } as any);

    await expect(
      planGoogleRoute(origin, destination, { travelMode: "drive" }),
    ).rejects.toBeInstanceOf(GoogleRoutingError);
  });
});
