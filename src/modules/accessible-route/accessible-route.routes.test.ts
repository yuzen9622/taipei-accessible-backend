import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// Mock only the service seam; the request still exercises router + validation
// + controller + envelope (schema defaults / rejections happen before the mock).
vi.mock("./accessible-route.service", async (importActual) => {
  const actual =
    await importActual<typeof import("./accessible-route.service")>();
  return { ...actual, planAccessibleRouteFromRequest: vi.fn() };
});

import { buildTestApp } from "../../../tests/helpers/test-helpers";
import * as service from "./accessible-route.service";

const app = buildTestApp();
const URL = "/api/v1/a11y/accessible-route";
const mockPlan = vi.mocked(service.planAccessibleRouteFromRequest);

const okData = (overrides: Record<string, unknown> = {}) => ({
  origin: { lat: 25.04, lng: 121.56 },
  destination: { lat: 25.03, lng: 121.55 },
  city: "Taipei",
  travelMode: "transit",
  routes: [],
  ...overrides,
});

beforeEach(() => {
  vi.resetAllMocks();
});

describe("POST /api/v1/a11y/accessible-route travel modes + waypoints", () => {
  it("echoes travelMode + waypoints for a drive request", async () => {
    mockPlan.mockResolvedValue({
      ok: true,
      data: okData({
        travelMode: "drive",
        waypoints: [{ lat: 25.035, lng: 121.555 }],
        routes: [
          {
            routeId: "drive-0",
            routeName: "開車",
            totalMinutes: 20,
            transferCount: 0,
            legs: [],
            accessibilityHighlights: [],
          },
        ],
      }),
    } as any);

    const res = await request(app)
      .post(URL)
      .send({
        origin: { latitude: 25.04, longitude: 121.56 },
        destination: { latitude: 25.03, longitude: 121.55 },
        travelMode: "drive",
        waypoints: [{ latitude: 25.035, longitude: 121.555 }],
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.travelMode).toBe("drive");
    expect(res.body.data.waypoints).toHaveLength(1);
  });

  it("defaults travelMode to transit when omitted (passed through to service)", async () => {
    mockPlan.mockResolvedValue({ ok: true, data: okData() } as any);

    const res = await request(app)
      .post(URL)
      .send({
        origin: { latitude: 25, longitude: 121 },
        destination: { latitude: 25.1, longitude: 121.1 },
      });

    expect(res.status).toBe(200);
    expect(mockPlan.mock.calls[0][0].travelMode).toBe("transit");
  });

  it("rejects an invalid travelMode with 400 before calling the service", async () => {
    const res = await request(app)
      .post(URL)
      .send({
        origin: { latitude: 25, longitude: 121 },
        destination: { latitude: 25.1, longitude: 121.1 },
        travelMode: "teleport",
      });

    expect(res.status).toBe(400);
    expect(mockPlan).not.toHaveBeenCalled();
  });

  it("rejects more than 5 waypoints with 400", async () => {
    const res = await request(app)
      .post(URL)
      .send({
        origin: { latitude: 25, longitude: 121 },
        destination: { latitude: 25.1, longitude: 121.1 },
        waypoints: Array.from({ length: 6 }, () => ({
          latitude: 25,
          longitude: 121,
        })),
      });

    expect(res.status).toBe(400);
    expect(mockPlan).not.toHaveBeenCalled();
  });

  it("maps a service 503 outcome to HTTP 503", async () => {
    mockPlan.mockResolvedValue({
      ok: false,
      status: 503,
      error: "路線規劃服務暫時忙線，請稍後再試",
    } as any);

    const res = await request(app)
      .post(URL)
      .send({
        origin: { latitude: 25, longitude: 121 },
        destination: { latitude: 25.1, longitude: 121.1 },
        travelMode: "drive",
      });

    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
  });
});
