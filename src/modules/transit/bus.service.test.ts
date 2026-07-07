import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/fetch", () => ({ tdxFetch: vi.fn() }));
vi.mock("../../model/bus-vehicle.model", () => ({ default: { find: vi.fn() } }));
vi.mock("../../model/bus-route.model", () => ({ default: { find: vi.fn() } }));
vi.mock("../../model/bus-stop.model", () => ({ default: { aggregate: vi.fn() } }));
vi.mock("../../adapters/google.adapter", () => ({ getCity: vi.fn() }));

import { tdxFetch } from "../../config/fetch";
import BusVehicleModel from "../../model/bus-vehicle.model";
import BusRouteModel from "../../model/bus-route.model";
import BusStopModel from "../../model/bus-stop.model";
import { getBusRealtimeOnRoute, getBusArrivalAtStop, searchBusStops } from "./bus.service";
import { TaiwanCityEn } from "../../types/transit";

const tdxFetchMock = tdxFetch as unknown as ReturnType<typeof vi.fn>;
const vehicleFindMock = BusVehicleModel.find as unknown as ReturnType<typeof vi.fn>;
const routeFindMock = BusRouteModel.find as unknown as ReturnType<typeof vi.fn>;
const stopAggregateMock = BusStopModel.aggregate as unknown as ReturnType<typeof vi.fn>;

function mockRouteMap(rows: unknown[]) {
  routeFindMock.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(rows) }) });
}

function mockTdxJson(rows: unknown[]) {
  tdxFetchMock.mockResolvedValue({ ok: true, json: async () => rows });
}
function mockVehicles(rows: unknown[]) {
  vehicleFindMock.mockReturnValue({ lean: () => Promise.resolve(rows) });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getBusRealtimeOnRoute — 低底盤 join（招牌功能）", () => {
  it("以在線車牌 join Vehicle 表，標註每台車是否低底盤；無車牌輸入", async () => {
    mockTdxJson([
      {
        PlateNumb: "AAA-1",
        Direction: 0,
        BusPosition: { PositionLat: 25.05, PositionLon: 121.51 },
        Speed: 30,
        BusStatus: 0,
      },
      {
        PlateNumb: "BBB-2",
        Direction: 0,
        BusPosition: { PositionLat: 25.04, PositionLon: 121.52 },
        Speed: 0,
        BusStatus: 3,
      },
    ]);
    // 只有 AAA-1 在 Vehicle 表，且為低底盤；BBB-2 未匯入 → 未知
    mockVehicles([
      { plateNumb: "AAA-1", isLowFloor: 1, hasLiftOrRamp: 1, vehicleClass: 1 },
    ]);

    const result = await getBusRealtimeOnRoute({
      routeName: "307",
      city: TaiwanCityEn.Taipei,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.count).toBe(2);
    expect(result.lowFloorCount).toBe(1);

    const aaa = result.buses.find((b) => b.plateNumb === "AAA-1")!;
    expect(aaa.isLowFloor).toBe("是");
    expect(aaa.hasLiftOrRamp).toBe("是");
    expect(aaa.vehicleClass).toBe("大型巴士");
    expect(aaa.lat).toBe(25.05);

    const bbb = result.buses.find((b) => b.plateNumb === "BBB-2")!;
    expect(bbb.isLowFloor).toBe("未知");
    expect(bbb.statusLabel).toBe("塞車");
  });

  it("路線目前沒有在線車輛時回 404", async () => {
    mockTdxJson([]);
    mockVehicles([]);
    const result = await getBusRealtimeOnRoute({
      routeName: "307",
      city: TaiwanCityEn.Taipei,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
  });
});

describe("getBusArrivalAtStop", () => {
  it("換算秒→分鐘並帶出站名/狀態（V2 N1）", async () => {
    mockTdxJson([
      {
        StopName: { Zh_tw: "台北車站" },
        Direction: 0,
        EstimateTime: 180,
        StopStatus: 0,
      },
    ]);

    const result = await getBusArrivalAtStop({
      routeName: "307",
      stopName: "台北車站",
      city: TaiwanCityEn.Taipei,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.arrivals[0].estimateMinutes).toBe(3);
    expect(result.arrivals[0].stopName).toBe("台北車站");
    expect(result.arrivals[0].directionLabel).toBe("去程");
    expect(result.arrivals[0].statusLabel).toBe("正常");
  });

  it("EstimateTime 缺值時 estimateMinutes 為 null", async () => {
    mockTdxJson([{ StopName: { Zh_tw: "台北車站" }, Direction: 0, StopStatus: 1 }]);
    const result = await getBusArrivalAtStop({
      routeName: "307",
      stopName: "台北車站",
      city: TaiwanCityEn.Taipei,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.arrivals[0].estimateMinutes).toBeNull();
    expect(result.arrivals[0].statusLabel).toBe("尚未發車");
  });
});

describe("searchBusStops — 站牌關鍵字搜尋", () => {
  it("同名同市的多筆站牌去重成一筆並聯集路線", async () => {
    stopAggregateMock.mockResolvedValue([
      {
        stopUid: "TPE1",
        stopName: { Zh_tw: "台北車站" },
        city: "Taipei",
        subRouteIds: ["307"],
        location: { coordinates: [121.51, 25.04] },
      },
      {
        stopUid: "TPE2",
        stopName: { Zh_tw: "台北車站" },
        city: "Taipei",
        subRouteIds: ["652"],
        location: { coordinates: [121.52, 25.05] },
      },
    ]);
    mockRouteMap([]);

    const result = await searchBusStops("台北");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stops).toHaveLength(1);
    expect(result.stops[0].stopName).toBe("台北車站");
    expect(result.stops[0].routes).toEqual(["307", "652"]);
  });

  it("同名但不同縣市維持兩筆", async () => {
    stopAggregateMock.mockResolvedValue([
      {
        stopUid: "TPE1",
        stopName: { Zh_tw: "中正路" },
        city: "Taipei",
        subRouteIds: [],
        location: { coordinates: [121.51, 25.04] },
      },
      {
        stopUid: "TXG1",
        stopName: { Zh_tw: "中正路" },
        city: "Taichung",
        subRouteIds: [],
        location: { coordinates: [120.68, 24.14] },
      },
    ]);
    mockRouteMap([]);

    const result = await searchBusStops("中正");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stops).toHaveLength(2);
    expect(result.stops.map((s) => s.city).sort()).toEqual(["Taichung", "Taipei"]);
  });

  it("以 subRouteName→routeName 映射顯示路線名（而非 subRouteId）", async () => {
    stopAggregateMock.mockResolvedValue([
      {
        stopUid: "TPE1",
        stopName: { Zh_tw: "市政府" },
        city: "Taipei",
        subRouteIds: ["0東"],
        location: { coordinates: [121.56, 25.04] },
      },
    ]);
    mockRouteMap([{ subRouteName: { Zh_tw: "0東" }, routeName: { Zh_tw: "0東" } }]);

    const result = await searchBusStops("市政府");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stops[0].routes).toEqual(["0東"]);
  });

  it("無匹配時回空陣列（非錯誤）", async () => {
    stopAggregateMock.mockResolvedValue([]);
    const result = await searchBusStops("不存在的站");
    expect(result).toEqual({ ok: true, stops: [] });
  });

  it("DB aggregate 拋錯時回 500", async () => {
    stopAggregateMock.mockRejectedValue(new Error("db down"));
    const result = await searchBusStops("台北");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(500);
  });
});
