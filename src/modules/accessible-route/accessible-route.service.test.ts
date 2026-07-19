import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the driving planner (dynamic-imported by the service) — override only
// planValhallaRoute; keep ValhallaRoutingError so `instanceof` checks stay valid.
vi.mock("./planners/valhalla-routing", () => ({
  planValhallaRoute: vi.fn(),
  ValhallaRoutingError: class ValhallaRoutingError extends Error {},
}));

// Spread-actual: only override the a11y hooks the driving path calls.
vi.mock("../a11y/a11y.service", async (importActual) => {
  const actual = await importActual<typeof import("../a11y/a11y.service")>();
  return { ...actual, findNearbyParking: vi.fn(), findNearby: vi.fn() };
});

// The transit branch dynamic-imports both from the OTP planner.
vi.mock("./planners/otp-routing", () => ({
  planOtpRoute: vi.fn().mockResolvedValue([]),
  isOtpCircuitOpen: () => false,
}));

// DB isolation: resolveCityFromStops does findOne().select().lean().
vi.mock("../../model/bus-stop.model", () => ({
  default: {
    findOne: () => ({
      select: () => ({ lean: () => Promise.resolve({ city: "Taipei" }) }),
    }),
  },
}));

// Spread-actual google adapter; getCity is a fallback (city resolves via stops).
vi.mock("../../adapters/google.adapter", async (importActual) => {
  const actual =
    await importActual<typeof import("../../adapters/google.adapter")>();
  return { ...actual, getCity: vi.fn(), getCoordinates: vi.fn() };
});

import { planAccessibleRouteFromRequest } from "./accessible-route.service";
import { planValhallaRoute, ValhallaRoutingError } from "./planners/valhalla-routing";
import { findNearbyParking, findNearby } from "../a11y/a11y.service";
import { planOtpRoute } from "./planners/otp-routing";
import { getCity } from "../../adapters/google.adapter";
import { ResponseCode } from "../../types/code";

const driveRequest = {
  travelMode: "drive" as const,
  origin: { latitude: 25.04, longitude: 121.56 },
  destination: { latitude: 25.03, longitude: 121.55 },
};

// Well-formed parking doc: the caller reads location.coordinates + placeName.
const parkingFixture = [
  {
    placeName: "身障停車格A",
    latitude: 25.031,
    longitude: 121.551,
    location: { type: "Point", coordinates: [121.551, 25.031] },
  },
];

const driveRoute = (highlights: string[]) => ({
  routeId: "drive-0",
  routeName: "開車",
  totalMinutes: 20,
  transferCount: 0,
  totalWalkDistanceM: 150,
  legs: [],
  accessibilityHighlights: highlights,
});

const hasParkingGuide = (hl: string[]) =>
  hl.some((h) => h.includes("已為您導引至最近身障停車格"));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getCity).mockResolvedValue("Taipei");
  vi.mocked(findNearby).mockResolvedValue({ nearbyOsm: [] } as any);
  vi.mocked(planOtpRoute).mockResolvedValue([]);
});

describe("planAccessibleRouteFromRequest driving a11y highlights append", () => {
  it("appends the parking highlight without overwriting the walk hint", async () => {
    const walkHint = "起點需步行約 150 公尺至可上車路段";
    vi.mocked(planValhallaRoute).mockResolvedValue([driveRoute([walkHint])] as any);
    vi.mocked(findNearbyParking).mockResolvedValue(parkingFixture as any);

    const res = await planAccessibleRouteFromRequest(driveRequest);

    expect(res.ok).toBe(true);
    expect(res.data!.travelMode).toBe("drive");
    const highlights = res.data!.routes[0].accessibilityHighlights;
    expect(highlights).toContain(walkHint);
    expect(highlights.some((h) => h.includes("身障停車格"))).toBe(true);
  });

  it("keeps a walk-failure warning alongside the appended parking highlight", async () => {
    const warning =
      "起點距可行車路段約 120 公尺，但無法建立可信步行路徑，請留意";
    vi.mocked(planValhallaRoute).mockResolvedValue([driveRoute([warning])] as any);
    vi.mocked(findNearbyParking).mockResolvedValue(parkingFixture as any);

    const res = await planAccessibleRouteFromRequest(driveRequest);

    expect(res.ok).toBe(true);
    const highlights = res.data!.routes[0].accessibilityHighlights;
    expect(highlights).toContain(warning);
    expect(highlights.some((h) => h.includes("身障停車格"))).toBe(true);
  });
});

describe("planAccessibleRouteFromRequest parking-aware arrival", () => {
  it("routes to the parking anchor with the true dest as finalWalkTarget (drive)", async () => {
    vi.mocked(findNearbyParking).mockResolvedValue(parkingFixture as any);
    vi.mocked(planValhallaRoute).mockResolvedValue([driveRoute([])] as any);

    const res = await planAccessibleRouteFromRequest(driveRequest);

    const [, dest, opts] = vi.mocked(planValhallaRoute).mock.calls[0];
    expect(dest.lat).toBeCloseTo(25.031);
    expect(dest.lng).toBeCloseTo(121.551);
    expect(opts.finalWalkTarget!.lat).toBeCloseTo(25.03);
    expect(opts.finalWalkTarget!.lng).toBeCloseTo(121.55);

    expect(res.ok).toBe(true);
    expect(hasParkingGuide(res.data!.routes[0].accessibilityHighlights)).toBe(true);
    expect(res.data!.destination).toEqual({ lat: 25.03, lng: 121.55 });
  });

  it("applies the same treatment to motorcycle", async () => {
    vi.mocked(findNearbyParking).mockResolvedValue(parkingFixture as any);
    vi.mocked(planValhallaRoute).mockResolvedValue([driveRoute([])] as any);

    const res = await planAccessibleRouteFromRequest({
      ...driveRequest,
      travelMode: "motorcycle",
    });

    const [, dest, opts] = vi.mocked(planValhallaRoute).mock.calls[0];
    expect(dest.lat).toBeCloseTo(25.031);
    expect(dest.lng).toBeCloseTo(121.551);
    expect(opts.finalWalkTarget!.lat).toBeCloseTo(25.03);
    expect(opts.finalWalkTarget!.lng).toBeCloseTo(121.55);
    expect(res.ok).toBe(true);
    expect(hasParkingGuide(res.data!.routes[0].accessibilityHighlights)).toBe(true);
  });

  it("routes straight to the true destination when no parking is found", async () => {
    vi.mocked(findNearbyParking).mockResolvedValue([] as any);
    vi.mocked(planValhallaRoute).mockResolvedValue([driveRoute([])] as any);

    const res = await planAccessibleRouteFromRequest(driveRequest);

    const [, dest, opts] = vi.mocked(planValhallaRoute).mock.calls[0];
    expect(dest.lat).toBeCloseTo(25.03);
    expect(dest.lng).toBeCloseTo(121.55);
    expect(opts.finalWalkTarget).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(hasParkingGuide(res.data!.routes[0].accessibilityHighlights)).toBe(false);
  });

  it("falls back to the true destination when the parking lookup rejects", async () => {
    vi.mocked(findNearbyParking).mockRejectedValue(new Error("mongo down"));
    vi.mocked(planValhallaRoute).mockResolvedValue([driveRoute([])] as any);

    const res = await planAccessibleRouteFromRequest(driveRequest);

    const [, dest, opts] = vi.mocked(planValhallaRoute).mock.calls[0];
    expect(dest.lat).toBeCloseTo(25.03);
    expect(dest.lng).toBeCloseTo(121.55);
    expect(opts.finalWalkTarget).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(hasParkingGuide(res.data!.routes[0].accessibilityHighlights)).toBe(false);
  });

  it("retries against the true destination when the parking bay is unreachable", async () => {
    vi.mocked(findNearbyParking).mockResolvedValue(parkingFixture as any);
    vi.mocked(planValhallaRoute)
      .mockResolvedValueOnce([] as any)
      .mockResolvedValueOnce([driveRoute([])] as any);

    const res = await planAccessibleRouteFromRequest(driveRequest);

    const calls = vi.mocked(planValhallaRoute).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1][1].lat).toBeCloseTo(25.03);
    expect(calls[1][1].lng).toBeCloseTo(121.55);
    expect(calls[1][2].finalWalkTarget).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(hasParkingGuide(res.data!.routes[0].accessibilityHighlights)).toBe(false);
  });

  it("returns NOT_FOUND when both the parking bay and the true dest are unreachable", async () => {
    vi.mocked(findNearbyParking).mockResolvedValue(parkingFixture as any);
    vi.mocked(planValhallaRoute).mockResolvedValue([] as any);

    const res = await planAccessibleRouteFromRequest(driveRequest);

    expect(res.ok).toBe(false);
    expect(res.status).toBe(ResponseCode.NOT_FOUND);
  });

  it("does NOT retry (and stays 503) when the first plan is upstream-unavailable", async () => {
    vi.mocked(findNearbyParking).mockResolvedValue(parkingFixture as any);
    vi.mocked(planValhallaRoute).mockRejectedValue(new ValhallaRoutingError("upstream"));

    const res = await planAccessibleRouteFromRequest(driveRequest);

    expect(vi.mocked(planValhallaRoute).mock.calls).toHaveLength(1);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(ResponseCode.SERVICE_UNAVAILABLE);
  });

  it("does NOT retry (and stays 500) when the first plan errors", async () => {
    vi.mocked(findNearbyParking).mockResolvedValue(parkingFixture as any);
    vi.mocked(planValhallaRoute).mockRejectedValue(new Error("boom"));

    const res = await planAccessibleRouteFromRequest(driveRequest);

    expect(vi.mocked(planValhallaRoute).mock.calls).toHaveLength(1);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(ResponseCode.INTERNAL_ERROR);
  });

  it("does not run the parking lookup for transit", async () => {
    const res = await planAccessibleRouteFromRequest({
      ...driveRequest,
      travelMode: "transit",
    });

    expect(findNearbyParking).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
  });

  it("does not run the parking arrival lookup for walk mode", async () => {
    vi.mocked(planValhallaRoute).mockResolvedValue([driveRoute([])] as any);

    const res = await planAccessibleRouteFromRequest({
      ...driveRequest,
      travelMode: "walk",
    });

    expect(findNearbyParking).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
  });
});
