import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// Mock the service seam (and the google.adapter the controller calls directly)
// while keeping every other export of those modules real, so importing the
// whole app graph stays intact. Per-test we set the return of each method.
vi.mock("./transit.service", async (orig) => ({
  ...((await orig()) as any),
  getBusEta: vi.fn(),
  getBusRealtimePosition: vi.fn(),
}));
vi.mock("./bus.service", async (orig) => ({
  ...((await orig()) as any),
  resolveBusCity: vi.fn(),
  getBusRouteInfo: vi.fn(),
  getBusArrivalAtStop: vi.fn(),
  getBusTimetable: vi.fn(),
  getBusRealtimeOnRoute: vi.fn(),
}));
vi.mock("../../adapters/google.adapter", async (orig) => ({
  ...((await orig()) as any),
  getCity: vi.fn(),
}));

import { buildTestApp } from "../../../test/test-helpers";
import * as transitService from "./transit.service";
import * as busService from "./bus.service";
import { getCity } from "../../adapters/google.adapter";
import { ResponseCode } from "../../types/code";
import { MSG, ERROR_MESSAGE } from "../../constants/messages";

const app = buildTestApp();
const BASE = "/api/v1/transit";

const VALID_BUS_BODY = {
  route_name: "299",
  arrival_stop: "台北車站",
  departure_stop: "忠孝復興",
  arrival_lat: 25.0478,
  arrival_lng: 121.5171,
};

beforeEach(() => {
  vi.resetAllMocks();
  // Sensible happy-path defaults; individual tests override as needed.
  vi.mocked(getCity).mockResolvedValue("Taipei" as any);
  vi.mocked(busService.resolveBusCity).mockResolvedValue("Taipei" as any);
});

describe("POST /api/v1/transit/bus", () => {
  it("returns 200 + the data envelope with the ETA payload when the service succeeds", async () => {
    const etaData = [{ StopName: { Zh_tw: "台北車站" }, EstimateTime: 180 }];
    vi.mocked(transitService.getBusEta).mockResolvedValue({ ok: true, etaData } as any);

    const res = await request(app).post(`${BASE}/bus`).send(VALID_BUS_BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      status: "success",
      code: ResponseCode.OK,
      message: MSG.OK,
      data: etaData,
    });
    expect(vi.mocked(transitService.getBusEta)).toHaveBeenCalledWith(
      expect.objectContaining({
        routeName: "299",
        departureStop: "忠孝復興",
        arrivalStop: "台北車站",
        arrivalLat: 25.0478,
        arrivalLng: 121.5171,
      }),
    );
  });

  it("rejects a missing route_name with 400 + the error envelope (schema)", async () => {
    const { route_name, ...body } = VALID_BUS_BODY;

    const res = await request(app).post(`${BASE}/bus`).send(body);

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(res.body).toMatchObject({
      ok: false,
      status: "error",
      code: ResponseCode.INVALID_INPUT,
      message: "Invalid request.",
    });
    expect(res.body.data.errors.length).toBeGreaterThan(0);
    expect(vi.mocked(transitService.getBusEta)).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric arrival_lat with 400 (schema)", async () => {
    const res = await request(app)
      .post(`${BASE}/bus`)
      .send({ ...VALID_BUS_BODY, arrival_lat: "not-a-number" });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(res.body.code).toBe(ResponseCode.INVALID_INPUT);
    expect(vi.mocked(transitService.getBusEta)).not.toHaveBeenCalled();
  });

  it("rejects unknown body keys with 400 (strict schema)", async () => {
    const res = await request(app)
      .post(`${BASE}/bus`)
      .send({ ...VALID_BUS_BODY, surprise: "field" });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(res.body.code).toBe(ResponseCode.INVALID_INPUT);
  });

  it("maps a service domain error (400) to its status + message", async () => {
    vi.mocked(transitService.getBusEta).mockResolvedValue({
      ok: false,
      status: 400,
      error: "無法辨識路線方向，請確認站牌名稱是否正確",
    } as any);

    const res = await request(app).post(`${BASE}/bus`).send(VALID_BUS_BODY);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      ok: false,
      status: "error",
      code: 400,
      message: "無法辨識路線方向，請確認站牌名稱是否正確",
    });
  });

  it("maps a service upstream error (500) to its status + message", async () => {
    vi.mocked(transitService.getBusEta).mockResolvedValue({
      ok: false,
      status: 500,
      error: "TDX 公車路線資料查詢失敗",
    } as any);

    const res = await request(app).post(`${BASE}/bus`).send(VALID_BUS_BODY);

    expect(res.status).toBe(500);
    expect(res.body.code).toBe(500);
    expect(res.body.message).toBe("TDX 公車路線資料查詢失敗");
  });

  it("returns 500 with the thrown message when the service throws", async () => {
    vi.mocked(transitService.getBusEta).mockRejectedValue(new Error("boom"));

    const res = await request(app).post(`${BASE}/bus`).send(VALID_BUS_BODY);

    expect(res.status).toBe(ResponseCode.INTERNAL_ERROR);
    expect(res.body).toEqual({
      ok: false,
      status: "error",
      code: ResponseCode.INTERNAL_ERROR,
      message: "boom",
    });
  });
});

describe("GET /api/v1/transit/bus/realtime", () => {
  const VALID_QUERY = {
    plate_number: "KKA-1234",
    arrival_lat: "25.0478",
    arrival_lng: "121.5171",
    route_name: "299",
  };

  it("returns 200 + the position payload when the service succeeds", async () => {
    const positionData = [{ PlateNumb: "KKA-1234", BusPosition: { PositionLat: 25.05, PositionLon: 121.51 } }];
    vi.mocked(transitService.getBusRealtimePosition).mockResolvedValue({
      ok: true,
      positionData,
    } as any);

    const res = await request(app).get(`${BASE}/bus/realtime`).query(VALID_QUERY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      status: "success",
      code: ResponseCode.OK,
      message: MSG.OK,
      data: positionData,
    });
  });

  it("rejects an invalid plate_number with 400 (schema)", async () => {
    const res = await request(app)
      .get(`${BASE}/bus/realtime`)
      .query({ ...VALID_QUERY, plate_number: "INVALID PLATE!" });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(vi.mocked(transitService.getBusRealtimePosition)).not.toHaveBeenCalled();
  });

  it("rejects a missing route_name with 400 (schema)", async () => {
    const { route_name, ...query } = VALID_QUERY;

    const res = await request(app).get(`${BASE}/bus/realtime`).query(query);

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
  });

  it("rejects a non-numeric arrival_lng with 400 (schema)", async () => {
    const res = await request(app)
      .get(`${BASE}/bus/realtime`)
      .query({ ...VALID_QUERY, arrival_lng: "abc" });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
  });

  it("maps a service domain error to its status", async () => {
    vi.mocked(transitService.getBusRealtimePosition).mockResolvedValue({
      ok: false,
      status: 400,
      error: "TDX 公車位置查詢失敗",
    } as any);

    const res = await request(app).get(`${BASE}/bus/realtime`).query(VALID_QUERY);

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("TDX 公車位置查詢失敗");
  });

  it("returns 500 with the generic internal message when the service throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(transitService.getBusRealtimePosition).mockRejectedValue(new Error("boom"));

    const res = await request(app).get(`${BASE}/bus/realtime`).query(VALID_QUERY);

    expect(res.status).toBe(ResponseCode.INTERNAL_ERROR);
    expect(res.body.message).toBe(ERROR_MESSAGE.INTERNAL);
  });
});

describe("GET /api/v1/transit/bus/route", () => {
  it("returns 200 + service data with the `ok` flag stripped", async () => {
    vi.mocked(busService.getBusRouteInfo).mockResolvedValue({
      ok: true,
      route: { routeName: "307", stops: ["A", "B"] },
    } as any);

    const res = await request(app).get(`${BASE}/bus/route`).query({ routeName: "307", city: "台北" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      status: "success",
      code: ResponseCode.OK,
      message: MSG.OK,
      data: { route: { routeName: "307", stops: ["A", "B"] } },
    });
  });

  it("rejects a missing routeName with 400 (schema)", async () => {
    const res = await request(app).get(`${BASE}/bus/route`).query({ city: "台北" });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(vi.mocked(busService.getBusRouteInfo)).not.toHaveBeenCalled();
  });

  it("rejects unknown query keys with 400 (strict schema)", async () => {
    const res = await request(app)
      .get(`${BASE}/bus/route`)
      .query({ routeName: "307", surprise: "x" });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
  });

  it("returns 400 when the city cannot be resolved", async () => {
    vi.mocked(busService.resolveBusCity).mockResolvedValue(null);

    const res = await request(app).get(`${BASE}/bus/route`).query({ routeName: "307" });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(res.body.message).toContain("有效的縣市");
    expect(vi.mocked(busService.getBusRouteInfo)).not.toHaveBeenCalled();
  });

  it("maps a service not-found error to 404", async () => {
    vi.mocked(busService.getBusRouteInfo).mockResolvedValue({
      ok: false,
      status: 404,
      error: "找不到路線",
    } as any);

    const res = await request(app).get(`${BASE}/bus/route`).query({ routeName: "307", city: "台北" });

    expect(res.status).toBe(ResponseCode.NOT_FOUND);
    expect(res.body.message).toBe("找不到路線");
  });

  it("returns 500 with the thrown message when the service throws", async () => {
    vi.mocked(busService.getBusRouteInfo).mockRejectedValue(new Error("db down"));

    const res = await request(app).get(`${BASE}/bus/route`).query({ routeName: "307", city: "台北" });

    expect(res.status).toBe(ResponseCode.INTERNAL_ERROR);
    expect(res.body.message).toBe("db down");
  });
});

describe("GET /api/v1/transit/bus/arrival", () => {
  const VALID = { routeName: "307", stopName: "台北車站", city: "台北", direction: "0" };

  it("returns 200 + service data on success", async () => {
    vi.mocked(busService.getBusArrivalAtStop).mockResolvedValue({
      ok: true,
      arrivals: [{ estimateMinutes: 3, isLowFloor: true }],
    } as any);

    const res = await request(app).get(`${BASE}/bus/arrival`).query(VALID);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ arrivals: [{ estimateMinutes: 3, isLowFloor: true }] });
    expect(vi.mocked(busService.getBusArrivalAtStop)).toHaveBeenCalledWith(
      expect.objectContaining({ routeName: "307", stopName: "台北車站", city: "Taipei", direction: 0 }),
    );
  });

  it("rejects a missing stopName with 400 (schema)", async () => {
    const res = await request(app).get(`${BASE}/bus/arrival`).query({ routeName: "307", city: "台北" });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
  });

  it("rejects an out-of-range direction with 400 (schema)", async () => {
    const res = await request(app).get(`${BASE}/bus/arrival`).query({ ...VALID, direction: "5" });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
  });

  it("returns 400 when the city cannot be resolved", async () => {
    vi.mocked(busService.resolveBusCity).mockResolvedValue(null);

    const res = await request(app)
      .get(`${BASE}/bus/arrival`)
      .query({ routeName: "307", stopName: "台北車站" });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(res.body.message).toContain("有效的縣市");
  });

  it("maps a service not-found error to 404", async () => {
    vi.mocked(busService.getBusArrivalAtStop).mockResolvedValue({
      ok: false,
      status: 404,
      error: "找不到到站資料",
    } as any);

    const res = await request(app).get(`${BASE}/bus/arrival`).query(VALID);

    expect(res.status).toBe(ResponseCode.NOT_FOUND);
    expect(res.body.message).toBe("找不到到站資料");
  });
});

describe("GET /api/v1/transit/bus/timetable", () => {
  it("returns 200 + service data on success", async () => {
    vi.mocked(busService.getBusTimetable).mockResolvedValue({
      ok: true,
      timetable: { firstBus: "06:00", lastBus: "23:00" },
    } as any);

    const res = await request(app).get(`${BASE}/bus/timetable`).query({ routeName: "307", city: "台北" });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ timetable: { firstBus: "06:00", lastBus: "23:00" } });
  });

  it("returns 400 when the city cannot be resolved", async () => {
    vi.mocked(busService.resolveBusCity).mockResolvedValue(null);

    const res = await request(app).get(`${BASE}/bus/timetable`).query({ routeName: "307" });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
  });

  it("maps a service upstream error to 500", async () => {
    vi.mocked(busService.getBusTimetable).mockResolvedValue({
      ok: false,
      status: 500,
      error: "TDX 錯誤",
    } as any);

    const res = await request(app).get(`${BASE}/bus/timetable`).query({ routeName: "307", city: "台北" });

    expect(res.status).toBe(500);
    expect(res.body.message).toBe("TDX 錯誤");
  });
});

describe("GET /api/v1/transit/bus/positions", () => {
  it("returns 200 + service data and coerces direction to a number", async () => {
    vi.mocked(busService.getBusRealtimeOnRoute).mockResolvedValue({
      ok: true,
      vehicles: [{ plate: "AAA-1", isLowFloor: true }],
    } as any);

    const res = await request(app)
      .get(`${BASE}/bus/positions`)
      .query({ routeName: "307", city: "台北", direction: "1" });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ vehicles: [{ plate: "AAA-1", isLowFloor: true }] });
    expect(vi.mocked(busService.getBusRealtimeOnRoute)).toHaveBeenCalledWith(
      expect.objectContaining({ routeName: "307", city: "Taipei", direction: 1 }),
    );
  });

  it("returns 400 when the city cannot be resolved", async () => {
    vi.mocked(busService.resolveBusCity).mockResolvedValue(null);

    const res = await request(app).get(`${BASE}/bus/positions`).query({ routeName: "307" });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
  });

  it("maps a service not-found error to 404", async () => {
    vi.mocked(busService.getBusRealtimeOnRoute).mockResolvedValue({
      ok: false,
      status: 404,
      error: "目前無營運車輛",
    } as any);

    const res = await request(app).get(`${BASE}/bus/positions`).query({ routeName: "307", city: "台北" });

    expect(res.status).toBe(ResponseCode.NOT_FOUND);
    expect(res.body.message).toBe("目前無營運車輛");
  });
});
