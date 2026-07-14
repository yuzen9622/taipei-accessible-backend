import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

vi.mock("./a11y.service", async () => {
  const actual = await vi.importActual<typeof import("./a11y.service")>("./a11y.service");
  return {
    ...actual,
    findAllFacilities: vi.fn(),
    findBathroomFacilities: vi.fn(),
    findRampFacilities: vi.fn(),
    findElevatorFacilities: vi.fn(),
  };
});

import { buildTestApp } from "../../../tests/helpers/test-helpers";
import * as service from "./a11y.service";
import { ERROR_MESSAGE } from "../../constants/messages";

const app = buildTestApp();
const BASE = "/api/v1/a11y";

const GEO = { type: "Point" as const, coordinates: [121.5, 25.03] as [number, number] };

const facility = (id: string, source: string): any => ({
  _id: id,
  name: `facility-${id}`,
  location: GEO,
  category: "elevator",
  source,
});

beforeEach(() => {
  vi.resetAllMocks();
});

describe("a11y facility list routes", () => {
  const cases = [
    { path: "/all-facilities", fn: "findAllFacilities", source: "metro" },
    { path: "/all-bathrooms", fn: "findBathroomFacilities", source: "bathroom" },
    { path: "/all-ramps", fn: "findRampFacilities", source: "osm" },
    { path: "/all-elevators", fn: "findElevatorFacilities", source: "campus" },
  ] as const;

  for (const { path, fn, source } of cases) {
    it(`GET ${path} returns 200 with the service output echoed through the envelope`, async () => {
      const data = [facility(`${fn}-1`, source)];
      vi.mocked(service[fn]).mockResolvedValue(data as any);

      const res = await request(app).get(`${BASE}${path}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        ok: true,
        status: "success",
        code: 200,
      });
      expect(res.body.data).toEqual(data);
      expect(vi.mocked(service[fn])).toHaveBeenCalledTimes(1);
    });

    it(`GET ${path} returns a 500 envelope with the fixed internal message when the service throws`, async () => {
      const secret = "SENSITIVE_DB_CONNECTION_STRING_LEAK";
      vi.mocked(service[fn]).mockRejectedValue(new Error(secret));

      const res = await request(app).get(`${BASE}${path}`);

      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({
        ok: false,
        status: "error",
        code: 500,
        message: ERROR_MESSAGE.INTERNAL,
      });
      expect(JSON.stringify(res.body)).not.toContain(secret);
    });
  }

  it("wires each path to its own service function", async () => {
    vi.mocked(service.findAllFacilities).mockResolvedValue([facility("A", "metro")] as any);
    vi.mocked(service.findBathroomFacilities).mockResolvedValue([facility("B", "bathroom")] as any);
    vi.mocked(service.findRampFacilities).mockResolvedValue([facility("R", "osm")] as any);
    vi.mocked(service.findElevatorFacilities).mockResolvedValue([facility("E", "campus")] as any);

    const [all, bath, ramp, elev] = await Promise.all([
      request(app).get(`${BASE}/all-facilities`),
      request(app).get(`${BASE}/all-bathrooms`),
      request(app).get(`${BASE}/all-ramps`),
      request(app).get(`${BASE}/all-elevators`),
    ]);

    expect(all.body.data[0]._id).toBe("A");
    expect(bath.body.data[0]._id).toBe("B");
    expect(ramp.body.data[0]._id).toBe("R");
    expect(elev.body.data[0]._id).toBe("E");
  });

  it("GET /all-places is removed and returns 404", async () => {
    const res = await request(app).get(`${BASE}/all-places`);
    expect(res.status).toBe(404);
  });
});
