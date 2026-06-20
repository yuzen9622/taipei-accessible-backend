import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/fetch", () => ({ tdxFetch: vi.fn() }));
vi.mock("../../model/bus-vehicle.model", () => ({ default: { find: vi.fn() } }));
vi.mock("../../model/bus-route.model", () => ({ default: { find: vi.fn() } }));
vi.mock("../../adapters/google.adapter", () => ({ getCity: vi.fn() }));

import { tdxFetch } from "../../config/fetch";
import BusVehicleModel from "../../model/bus-vehicle.model";
import { getBusRealtimeOnRoute, getBusArrivalAtStop } from "./bus.service";
import { TaiwanCityEn } from "../../types/transit";

const tdxFetchMock = tdxFetch as unknown as ReturnType<typeof vi.fn>;
const vehicleFindMock = BusVehicleModel.find as unknown as ReturnType<typeof vi.fn>;

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
