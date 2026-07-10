import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../adapters/tomtom.adapter", () => ({
  computeTomTomRoutes: vi.fn(),
}));

import { computeTomTomRoutes } from "../../../adapters/tomtom.adapter";
import { planTomTomRoute, TomTomRoutingError } from "./tomtom-routing";

const mockCompute = vi.mocked(computeTomTomRoutes);
const origin = { lat: 25.04, lng: 121.56 };
const destination = { lat: 25.03, lng: 121.55 };

function driveRoute() {
  return {
    summary: {
      lengthInMeters: 5200,
      travelTimeInSeconds: 780,
      noTrafficTravelTimeInSeconds: 600,
    },
    legs: [
      {
        summary: {
          lengthInMeters: 5200,
          travelTimeInSeconds: 780,
          noTrafficTravelTimeInSeconds: 600,
        },
        points: [
          { latitude: 25.04, longitude: 121.56 },
          { latitude: 25.035, longitude: 121.555 },
          { latitude: 25.03, longitude: 121.55 },
        ],
      },
    ],
    guidance: {
      instructions: [
        {
          routeOffsetInMeters: 0,
          travelTimeInSeconds: 0,
          pointIndex: 0,
          maneuver: "DEPART",
          message: "出發",
        },
        {
          routeOffsetInMeters: 240,
          travelTimeInSeconds: 60,
          pointIndex: 1,
          maneuver: "TURN_LEFT",
          message: "左轉信義路",
        },
      ],
    },
  };
}

function multiLegRoute() {
  const pt = (lat: number) => ({ latitude: lat, longitude: 121.5 });
  const legSummary = {
    lengthInMeters: 1000,
    travelTimeInSeconds: 300,
    noTrafficTravelTimeInSeconds: 300,
  };
  return {
    summary: {
      lengthInMeters: 3000,
      travelTimeInSeconds: 900,
      noTrafficTravelTimeInSeconds: 900,
    },
    legs: [
      { summary: { ...legSummary }, points: [pt(25.0), pt(25.01), pt(25.02)] },
      { summary: { ...legSummary }, points: [pt(25.02), pt(25.03), pt(25.04)] },
      { summary: { ...legSummary }, points: [pt(25.04), pt(25.05), pt(25.06)] },
    ],
    guidance: {
      instructions: [
        {
          routeOffsetInMeters: 0,
          travelTimeInSeconds: 0,
          pointIndex: 0,
          maneuver: "DEPART",
          message: "出發",
        },
        {
          routeOffsetInMeters: 400,
          travelTimeInSeconds: 120,
          pointIndex: 1,
          maneuver: "STRAIGHT",
          message: "直行",
        },
        {
          routeOffsetInMeters: 1000,
          travelTimeInSeconds: 300,
          pointIndex: 2,
          maneuver: "TURN_LEFT",
          message: "左轉",
        },
        {
          routeOffsetInMeters: 1500,
          travelTimeInSeconds: 450,
          pointIndex: 3,
          maneuver: "TURN_RIGHT",
          message: "右轉",
        },
        {
          routeOffsetInMeters: 2200,
          travelTimeInSeconds: 700,
          pointIndex: 5,
          maneuver: "WEIRD_CODE",
          message: "未知動作",
        },
      ],
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("planTomTomRoute", () => {
  it("maps a drive route to a DRIVE leg with [lng,lat] points, traffic minutes and steps", async () => {
    mockCompute.mockResolvedValue({ status: "OK", routes: [driveRoute()] } as any);

    const routes = await planTomTomRoute(origin, destination, {
      travelMode: "drive",
    });

    expect(routes).toHaveLength(1);
    expect(routes[0].transferCount).toBe(0);
    expect(routes[0].totalMinutes).toBe(13);
    expect(routes[0].routeName).toContain("開車");

    const leg = routes[0].legs[0] as any;
    expect(leg.type).toBe("DRIVE");
    expect(leg.distanceM).toBe(5200);
    expect(leg.durationMin).toBe(10);
    expect(leg.durationInTrafficMin).toBe(13);
    expect(leg.trafficLevel).toBe("moderate");
    expect(leg.from).toEqual({ lat: 25.04, lng: 121.56 });
    expect(leg.to).toEqual({ lat: 25.03, lng: 121.55 });
    expect(leg.polyline).toEqual([
      [121.56, 25.04],
      [121.555, 25.035],
      [121.55, 25.03],
    ]);

    expect(leg.steps).toHaveLength(2);
    expect(leg.steps[0].instruction).toBe("出發");
    expect(leg.steps[0].distanceM).toBe(240);
    expect(leg.steps[0].durationMin).toBe(1);
    expect(leg.steps[0].polyline).toEqual([
      [121.56, 25.04],
      [121.555, 25.035],
    ]);
    expect(leg.steps[1].instruction).toBe("左轉信義路");
    expect(leg.steps[1].maneuver).toBe("TURN_LEFT");
    expect(leg.steps[1].distanceM).toBe(4960);
    expect(leg.steps[1].durationMin).toBe(12);
    expect(leg.steps[1].polyline).toEqual([
      [121.555, 25.035],
      [121.55, 25.03],
    ]);

    expect(mockCompute.mock.calls[0][0].travelMode).toBe("car");
    expect(mockCompute.mock.calls[0][0].trafficAware).toBe(true);
  });

  it("falls back to travelTimeInSeconds for durationMin when noTrafficTravelTimeInSeconds is missing", async () => {
    const route = driveRoute();
    delete (route.legs[0].summary as any).noTrafficTravelTimeInSeconds;
    mockCompute.mockResolvedValue({ status: "OK", routes: [route] } as any);

    const routes = await planTomTomRoute(origin, destination, {
      travelMode: "drive",
    });

    const leg = routes[0].legs[0] as any;
    expect(leg.durationMin).toBe(13);
    expect(leg.trafficLevel).toBeUndefined();
  });

  it("buckets trafficLevel at the three ratio boundaries", async () => {
    const withTimes = (traffic: number) => {
      const route = driveRoute();
      route.summary.travelTimeInSeconds = traffic;
      route.legs[0].summary.travelTimeInSeconds = traffic;
      return route;
    };

    mockCompute.mockResolvedValueOnce({ status: "OK", routes: [withTimes(660)] } as any);
    let routes = await planTomTomRoute(origin, destination, { travelMode: "drive" });
    expect((routes[0].legs[0] as any).trafficLevel).toBe("light");

    mockCompute.mockResolvedValueOnce({ status: "OK", routes: [withTimes(780)] } as any);
    routes = await planTomTomRoute(origin, destination, { travelMode: "drive" });
    expect((routes[0].legs[0] as any).trafficLevel).toBe("moderate");

    mockCompute.mockResolvedValueOnce({ status: "OK", routes: [withTimes(900)] } as any);
    routes = await planTomTomRoute(origin, destination, { travelMode: "drive" });
    expect((routes[0].legs[0] as any).trafficLevel).toBe("heavy");
  });

  it("passes a future departure time (ISO) to the adapter for drive", async () => {
    mockCompute.mockResolvedValue({ status: "OK", routes: [driveRoute()] } as any);
    const departureTime = new Date("2030-01-01T10:00:00Z");

    await planTomTomRoute(origin, destination, {
      travelMode: "drive",
      departureTime,
    });

    expect(mockCompute.mock.calls[0][0].departureTime).toBe(
      departureTime.toISOString(),
    );
  });

  it("retries motorcycle as car on UNSUPPORTED_MODE, flagging modeFallback", async () => {
    mockCompute
      .mockResolvedValueOnce({ status: "UNSUPPORTED_MODE", routes: [] } as any)
      .mockResolvedValueOnce({ status: "OK", routes: [driveRoute()] } as any);

    const routes = await planTomTomRoute(origin, destination, {
      travelMode: "motorcycle",
    });

    expect(mockCompute).toHaveBeenCalledTimes(2);
    expect(mockCompute.mock.calls[0][0].travelMode).toBe("motorcycle");
    expect(mockCompute.mock.calls[1][0].travelMode).toBe("car");

    const leg = routes[0].legs[0] as any;
    expect(leg.type).toBe("MOTORCYCLE");
    expect(leg.modeFallback).toBe("DRIVE");
    expect(routes[0].routeName).toContain("騎車");
  });

  it("retries motorcycle as car on NO_ROUTE, flagging modeFallback", async () => {
    mockCompute
      .mockResolvedValueOnce({ status: "NO_ROUTE", routes: [] } as any)
      .mockResolvedValueOnce({ status: "OK", routes: [driveRoute()] } as any);

    const routes = await planTomTomRoute(origin, destination, {
      travelMode: "motorcycle",
    });

    expect(mockCompute.mock.calls[1][0].travelMode).toBe("car");
    expect((routes[0].legs[0] as any).modeFallback).toBe("DRIVE");
  });

  it("throws TomTomRoutingError on a first-call UPSTREAM_ERROR for motorcycle without retrying", async () => {
    mockCompute.mockResolvedValue({
      status: "UPSTREAM_ERROR",
      routes: [],
      httpStatus: 429,
    } as any);

    await expect(
      planTomTomRoute(origin, destination, { travelMode: "motorcycle" }),
    ).rejects.toBeInstanceOf(TomTomRoutingError);
    expect(mockCompute).toHaveBeenCalledTimes(1);
  });

  it("throws TomTomRoutingError when the motorcycle car retry hits UPSTREAM_ERROR", async () => {
    mockCompute
      .mockResolvedValueOnce({ status: "UNSUPPORTED_MODE", routes: [] } as any)
      .mockResolvedValueOnce({
        status: "UPSTREAM_ERROR",
        routes: [],
        httpStatus: 503,
      } as any);

    await expect(
      planTomTomRoute(origin, destination, { travelMode: "motorcycle" }),
    ).rejects.toBeInstanceOf(TomTomRoutingError);
  });

  it("returns [] when no route exists (non-motorcycle)", async () => {
    mockCompute.mockResolvedValue({ status: "NO_ROUTE", routes: [] } as any);

    const routes = await planTomTomRoute(origin, destination, {
      travelMode: "drive",
    });

    expect(routes).toEqual([]);
    expect(mockCompute).toHaveBeenCalledTimes(1);
  });

  it("maps a walk route to WALK legs and does not request traffic", async () => {
    mockCompute.mockResolvedValue({
      status: "OK",
      routes: [
        {
          summary: { lengthInMeters: 800, travelTimeInSeconds: 600 },
          legs: [
            {
              summary: { lengthInMeters: 800, travelTimeInSeconds: 600 },
              points: [
                { latitude: 25.04, longitude: 121.56 },
                { latitude: 25.05, longitude: 121.57 },
              ],
            },
          ],
        },
      ],
    } as any);

    const routes = await planTomTomRoute(origin, destination, {
      travelMode: "walk",
    });

    const leg = routes[0].legs[0] as any;
    expect(leg.type).toBe("WALK");
    expect(leg.from).toBe("起點");
    expect(leg.to).toBe("終點");
    expect(leg.distanceM).toBe(800);
    expect(leg.minutesEst).toBe(10);
    expect(leg.polyline).toEqual([
      [121.56, 25.04],
      [121.57, 25.05],
    ]);
    expect(leg.a11yFacilities).toEqual([]);
    expect(routes[0].totalWalkDistanceM).toBe(800);
    expect(mockCompute.mock.calls[0][0].travelMode).toBe("pedestrian");
    expect(mockCompute.mock.calls[0][0].trafficAware).toBe(false);
  });

  it("derives multi-leg steps from route-global instructions with exact boundaries", async () => {
    mockCompute.mockResolvedValue({
      status: "OK",
      routes: [multiLegRoute()],
    } as any);

    const routes = await planTomTomRoute(origin, destination, {
      travelMode: "drive",
      waypoints: [
        { lat: 25.02, lng: 121.5 },
        { lat: 25.04, lng: 121.5 },
      ],
    });

    const legs = routes[0].legs as any[];
    expect(legs).toHaveLength(3);

    const leg0 = legs[0];
    expect(leg0.steps).toHaveLength(2);
    expect(leg0.steps[0]).toMatchObject({
      instruction: "出發",
      distanceM: 400,
      durationMin: 2,
      maneuver: "DEPART",
    });
    expect(leg0.steps[0].polyline).toEqual([
      [121.5, 25.0],
      [121.5, 25.01],
    ]);
    expect(leg0.steps[1].distanceM).toBe(600);
    expect(leg0.steps[1].durationMin).toBe(3);
    expect(leg0.steps[1].polyline).toEqual([
      [121.5, 25.01],
      [121.5, 25.02],
    ]);

    const leg1 = legs[1];
    expect(leg1.steps).toHaveLength(2);
    expect(leg1.steps[0]).toMatchObject({
      instruction: "左轉",
      distanceM: 500,
      durationMin: 3,
      maneuver: "TURN_LEFT",
    });
    expect(leg1.steps[0].polyline).toEqual([
      [121.5, 25.02],
      [121.5, 25.03],
    ]);
    expect(leg1.steps[1]).toMatchObject({
      instruction: "右轉",
      distanceM: 500,
      durationMin: 3,
      maneuver: "TURN_RIGHT",
    });
    expect(leg1.steps[1].polyline).toEqual([
      [121.5, 25.03],
      [121.5, 25.04],
    ]);

    const leg2 = legs[2];
    expect(leg2.steps).toHaveLength(1);
    expect(leg2.steps[0]).toMatchObject({
      instruction: "未知動作",
      distanceM: 800,
      durationMin: 3,
      maneuver: "WEIRD_CODE",
    });
    expect(leg2.steps[0].polyline).toEqual([
      [121.5, 25.05],
      [121.5, 25.06],
    ]);

    for (const leg of legs) {
      for (const step of leg.steps) {
        expect(step.distanceM).toBeGreaterThanOrEqual(0);
        expect(step.durationMin).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("falls back to the nearest geometry point when pointIndex is missing", async () => {
    const route = multiLegRoute();
    route.legs = [route.legs[0]];
    route.summary = {
      lengthInMeters: 1000,
      travelTimeInSeconds: 300,
      noTrafficTravelTimeInSeconds: 300,
    };
    route.guidance.instructions = [
      {
        routeOffsetInMeters: 0,
        travelTimeInSeconds: 0,
        point: { latitude: 25.0, longitude: 121.5 },
        maneuver: "DEPART",
        message: "出發",
      } as any,
      {
        routeOffsetInMeters: 600,
        travelTimeInSeconds: 180,
        point: { latitude: 25.0101, longitude: 121.5001 },
        maneuver: "TURN_RIGHT",
        message: "右轉",
      } as any,
    ];
    mockCompute.mockResolvedValue({ status: "OK", routes: [route] } as any);

    const routes = await planTomTomRoute(origin, destination, {
      travelMode: "drive",
    });

    const steps = (routes[0].legs[0] as any).steps;
    expect(steps[0].polyline).toEqual([
      [121.5, 25.0],
      [121.5, 25.01],
    ]);
    expect(steps[1].polyline).toEqual([
      [121.5, 25.01],
      [121.5, 25.02],
    ]);
  });

  it("forwards 0 and 5 waypoints to the adapter unchanged", async () => {
    mockCompute.mockResolvedValue({ status: "OK", routes: [driveRoute()] } as any);

    await planTomTomRoute(origin, destination, { travelMode: "drive" });
    expect(mockCompute.mock.calls[0][0].waypoints).toBeUndefined();

    const waypoints = Array.from({ length: 5 }, (_, i) => ({
      lat: 25.0 + i * 0.01,
      lng: 121.5,
    }));
    await planTomTomRoute(origin, destination, {
      travelMode: "drive",
      waypoints,
    });
    expect(mockCompute.mock.calls[1][0].waypoints).toEqual(waypoints);
  });
});
