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
import { planValhallaRoute } from "./planners/valhalla-routing";
import { findNearbyParking, findNearby } from "../a11y/a11y.service";
import { getCity } from "../../adapters/google.adapter";

const driveRequest = {
  travelMode: "drive" as const,
  origin: { latitude: 25.04, longitude: 121.56 },
  destination: { latitude: 25.03, longitude: 121.55 },
};

const driveRoute = (highlights: string[]) => ({
  routeId: "drive-0",
  routeName: "開車",
  totalMinutes: 20,
  transferCount: 0,
  totalWalkDistanceM: 150,
  legs: [],
  accessibilityHighlights: highlights,
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getCity).mockResolvedValue("Taipei");
  vi.mocked(findNearby).mockResolvedValue({ nearbyOsm: [] } as any);
});

describe("planAccessibleRouteFromRequest driving a11y highlights append", () => {
  it("appends the parking highlight without overwriting the walk hint", async () => {
    const walkHint = "起點需步行約 150 公尺至可上車路段";
    vi.mocked(planValhallaRoute).mockResolvedValue([driveRoute([walkHint])] as any);
    vi.mocked(findNearbyParking).mockResolvedValue([{}] as any);

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
    vi.mocked(findNearbyParking).mockResolvedValue([{}] as any);

    const res = await planAccessibleRouteFromRequest(driveRequest);

    expect(res.ok).toBe(true);
    const highlights = res.data!.routes[0].accessibilityHighlights;
    expect(highlights).toContain(warning);
    expect(highlights.some((h) => h.includes("身障停車格"))).toBe(true);
  });
});
