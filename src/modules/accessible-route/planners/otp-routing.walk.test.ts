import { encode } from "@googlemaps/polyline-codec";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("axios", () => ({
  default: { create: () => ({ post }), isAxiosError: () => false },
}));

import { planOtpWalk, isOtpCircuitOpen } from "./otp-routing";

const enc = (pts: [number, number][]) => encode(pts, 5);
const okResp = (itineraries: unknown[]) => ({
  data: { data: { plan: { itineraries } } },
});

const walkItin = () => ({
  duration: 713,
  walkDistance: 823,
  legs: [
    {
      mode: "WALK",
      distance: 823,
      duration: 713,
      startTime: 0,
      endTime: 713000,
      from: { name: "Origin" },
      to: { name: "Destination" },
      legGeometry: {
        points: enc([
          [25.041, 121.565],
          [25.033, 121.564],
        ]),
      },
      steps: [
        {
          distance: 823,
          lon: 121.565,
          lat: 25.041,
          relativeDirection: "DEPART",
          absoluteDirection: "SOUTH",
          streetName: "信義路",
          area: false,
          bogusName: false,
        },
      ],
    },
  ],
});

const origin = { lat: 25.041, lng: 121.565 };
const destination = { lat: 25.033, lng: 121.564 };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("planOtpWalk", () => {
  it("maps a walk itinerary into an AccessibleRoute", async () => {
    post.mockResolvedValue(okResp([walkItin()]));

    const result = await planOtpWalk(origin, destination);

    expect(result).toHaveLength(1);
    const r = result[0];
    expect(r.routeName).toBe("步行");
    expect(r.transferCount).toBe(0);
    expect(r.legs[0].type).toBe("WALK");
    expect(r.legs[0].from).toBe("出發地");
    expect(r.totalWalkDistanceM).toBe(823);
    expect(r.totalMinutes).toBe(12);
    expect(r.attribution).toBe("© OpenStreetMap contributors");
    expect(r.legs[0].steps?.[0].instruction).toBe("請沿「信義路」出發");

    const query: string = post.mock.calls[0][1].query;
    expect(query).toContain("transportModes: [{ mode: WALK }]");
    expect(query).not.toContain("TRANSIT");
  });

  it("drops an itinerary with no legs", async () => {
    post.mockResolvedValue(okResp([{ duration: 100, walkDistance: 50, legs: [] }]));
    expect(await planOtpWalk(origin, destination)).toEqual([]);
  });

  it("drops an itinerary containing a non-WALK leg", async () => {
    const it = walkItin();
    (it.legs as unknown[]).push({
      mode: "BUS",
      distance: 500,
      duration: 300,
      startTime: 0,
      endTime: 300000,
      from: { name: "A" },
      to: { name: "B" },
      legGeometry: { points: enc([[25.04, 121.56], [25.03, 121.55]]) },
      steps: [],
    });
    post.mockResolvedValue(okResp([it]));
    expect(await planOtpWalk(origin, destination)).toEqual([]);
  });

  it("drops a leg whose geometry decodes to fewer than 2 points", async () => {
    const it = walkItin();
    it.legs[0].legGeometry.points = enc([[25.04, 121.56]]);
    post.mockResolvedValue(okResp([it]));
    expect(await planOtpWalk(origin, destination)).toEqual([]);
  });

  it("falls back to leg distance sum when walkDistance is missing", async () => {
    const it = walkItin() as { walkDistance?: number };
    delete it.walkDistance;
    post.mockResolvedValue(okResp([it]));

    const result = await planOtpWalk(origin, destination);
    expect(result).toHaveLength(1);
    expect(Number.isFinite(result[0].totalWalkDistanceM)).toBe(true);
    expect(result[0].totalWalkDistanceM).toBe(823);
  });

  it("is fail-soft: resolves [] when the OTP post rejects", async () => {
    post.mockRejectedValue(new Error("boom"));
    await expect(planOtpWalk(origin, destination)).resolves.toEqual([]);
  });

  it("opens the walk breaker without tripping the transit circuit", async () => {
    vi.resetModules();
    const failPost = vi.fn().mockRejectedValue(new Error("down"));
    vi.doMock("axios", () => ({
      default: { create: () => ({ post: failPost }), isAxiosError: () => false },
    }));
    // A fresh module graph would recompile the mongoose models (OverwriteModelError);
    // the walk path never touches them, so stub them out for the isolated instance.
    vi.doMock("../../../model/gtfs-trip.model", () => ({ GtfsTrip: {} }));
    vi.doMock("../../../model/metro-station.model", () => ({ default: {} }));
    vi.doMock("../../../model/train-station.model", () => ({ default: {} }));
    vi.doMock("../../../model/bus-stop.model", () => ({ default: {} }));
    const mod = await import("./otp-routing");

    for (let i = 0; i < 3; i++) {
      expect(await mod.planOtpWalk(origin, destination)).toEqual([]);
    }
    expect(failPost).toHaveBeenCalledTimes(3);
    expect(mod.isOtpCircuitOpen()).toBe(false);

    // 4th call short-circuits on the open breaker — no further post.
    expect(await mod.planOtpWalk(origin, destination)).toEqual([]);
    expect(failPost).toHaveBeenCalledTimes(3);

    vi.doUnmock("axios");
    vi.doUnmock("../../../model/gtfs-trip.model");
    vi.doUnmock("../../../model/metro-station.model");
    vi.doUnmock("../../../model/train-station.model");
    vi.doUnmock("../../../model/bus-stop.model");
    vi.resetModules();
  });

  it("keeps the transit circuit reported closed after a walk-only success", async () => {
    post.mockResolvedValue(okResp([walkItin()]));
    await planOtpWalk(origin, destination);
    expect(isOtpCircuitOpen()).toBe(false);
  });
});
