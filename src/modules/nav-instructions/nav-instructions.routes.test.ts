import request from "supertest";
import { describe, expect, it } from "vitest";
import app from "../../app";

const URL = "/api/v1/a11y/route/instructions";

const driveRoute = {
  routeId: "drive-contract",
  routeName: "開車",
  totalMinutes: 10,
  transferCount: 0,
  accessibilityHighlights: [],
  attribution: "© OpenStreetMap contributors",
  legs: [
    {
      type: "DRIVE",
      from: { lat: 25.04, lng: 121.56 },
      to: { lat: 25.03, lng: 121.55 },
      distanceM: 5200,
      durationMin: 10,
      polyline: [
        [121.56, 25.04],
        [121.55, 25.03],
      ],
      steps: [
        {
          instruction: "沿信義路出發",
          distanceM: 5200,
          durationMin: 10,
          maneuver: "DEPART",
          polyline: [
            [121.56, 25.04],
            [121.55, 25.03],
          ],
        },
      ],
    },
  ],
};

describe("POST /api/v1/a11y/route/instructions", () => {
  it("returns the full success envelope for DRIVE guidance", async () => {
    const res = await request(app).post(URL).send({ route: driveRoute });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      status: "success",
      code: 200,
      message: "逐步指引產生完成，共 2 步",
      data: {
        initialBearing: expect.any(Number),
        totalSteps: 2,
        warnings: [],
        instructions: [
          {
            text: "沿信義路出發",
            type: "depart",
            legType: "DRIVE",
            distanceM: 5200,
          },
          {
            text: "您已抵達目的地",
            type: "arrive",
            legType: "DRIVE",
          },
        ],
      },
    });
  });

  it("returns 400 with the standard envelope for an unsupported leg type", async () => {
    const res = await request(app)
      .post(URL)
      .send({ route: { ...driveRoute, legs: [{ type: "FERRY" }] } });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      ok: false,
      status: "error",
      code: 400,
      message: "Invalid request.",
      data: { errors: expect.any(Array) },
    });
  });

  it("accepts a full Valhalla WALK route and returns compatible dual warnings", async () => {
    const res = await request(app).post(URL).send({
      route: {
        routeId: "walk-0", routeName: "步行", totalMinutes: 2, transferCount: 0,
        accessibilityHighlights: [], attribution: "© OpenStreetMap contributors",
        legs: [{ type: "WALK", from: "起點", to: "終點", distanceM: 100, minutesEst: 2,
          polyline: [[121.51, 25.04], [121.52, 25.05]], a11yFacilities: [] }],
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.warnings).toEqual([
      "WALK_STEPS_UNAVAILABLE",
      "ORS_STEPS_UNAVAILABLE",
    ]);
  });

  it("returns 400 when the strict request body contains an unknown key", async () => {
    const res = await request(app)
      .post(URL)
      .send({ route: driveRoute, unexpected: true });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      ok: false,
      status: "error",
      code: 400,
      message: "Invalid request.",
      data: { errors: expect.any(Array) },
    });
  });
});
