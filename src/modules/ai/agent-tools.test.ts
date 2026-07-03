import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../a11y/a11y.service", () => ({
  findNearbyLimited: vi.fn(),
  findByOsmIds: vi.fn(),
  findNearbyParking: vi.fn(),
}));
vi.mock("../transit/bus.service", () => ({
  resolveBusCity: vi.fn(),
  getBusRouteInfo: vi.fn(),
  getBusArrivalAtStop: vi.fn(),
  getBusTimetable: vi.fn(),
  getBusRealtimeOnRoute: vi.fn(),
}));
vi.mock("../air/air.service", () => ({
  getAirData: vi.fn(),
  classifyPm25: vi.fn(),
}));
vi.mock("../hazard-report/hazard-report.service", () => ({
  findNearby: vi.fn(),
}));
vi.mock("../environment/environment.service", () => ({
  getEnvironmentInfo: vi.fn(),
}));
vi.mock("../../adapters/google.adapter", () => ({
  getCoordinates: vi.fn(),
  searchPlaces: vi.fn(),
}));
vi.mock("../accessible-route/accessible-route.service", () => ({
  planAccessibleRouteFromRequest: vi.fn(),
}));
vi.mock("../nav-instructions/nav-instructions.service", () => ({
  generateNavInstructions: vi.fn(),
}));
vi.mock("../accessible-route/facility-slim", () => ({
  slimFacility: vi.fn((f: any) => ({ osmId: f.osmId, category: f.category })),
}));
vi.mock("./memory.service", () => ({
  saveMemory: vi.fn(),
  deleteMemory: vi.fn(),
}));
vi.mock("./knowledge.service", () => ({
  searchKnowledge: vi.fn(),
}));
vi.mock("../../config/ai", () => ({
  googleGenAi: {
    models: { generateContent: vi.fn() },
  },
  model: "test-model",
}));

import * as a11yService from "../a11y/a11y.service";
import * as hazardService from "../hazard-report/hazard-report.service";
import { getEnvironmentInfo as fetchEnvironment } from "../environment/environment.service";
import { getCoordinates } from "../../adapters/google.adapter";
import { planAccessibleRouteFromRequest } from "../accessible-route/accessible-route.service";
import { generateNavInstructions } from "../nav-instructions/nav-instructions.service";
import { googleGenAi } from "../../config/ai";
import * as memoryServiceMod from "./memory.service";
import { searchKnowledge } from "./knowledge.service";
import {
  getEnvironmentInfo,
  getNearbyHazards,
  findNearbyParking,
  getNavInstructions,
  saveMemory,
  deleteMemory,
  searchAccessibilityGuide,
  webSearch,
  executeLocalTool,
} from "./agent-tools";

const mockGetCoordinates = getCoordinates as unknown as ReturnType<typeof vi.fn>;
const mockFetchEnvironment = fetchEnvironment as unknown as ReturnType<typeof vi.fn>;
const mockHazardFindNearby = hazardService.findNearby as unknown as ReturnType<typeof vi.fn>;
const mockA11yParking = a11yService.findNearbyParking as unknown as ReturnType<typeof vi.fn>;
const mockPlanRoute = planAccessibleRouteFromRequest as unknown as ReturnType<typeof vi.fn>;
const mockGenNav = generateNavInstructions as unknown as ReturnType<typeof vi.fn>;
const mockGenerateContent = googleGenAi.models.generateContent as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// getEnvironmentInfo
// ---------------------------------------------------------------------------
describe("getEnvironmentInfo", () => {
  const envData = {
    location: { lat: 25.05, lng: 121.51 },
    weather: { status: "ok", temperature: 28 },
    airQuality: { status: "ok", pm25: 12, quality: "良好" },
    nearbyCctv: { status: "ok", cameras: [] },
  };

  it("用經緯度查詢成功", async () => {
    mockFetchEnvironment.mockResolvedValue(envData);
    const raw = await getEnvironmentInfo({ latitude: 25.05, longitude: 121.51 });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(true);
    expect(result.weather.status).toBe("ok");
    expect(mockFetchEnvironment).toHaveBeenCalledWith(25.05, 121.51, 1000);
  });

  it("用地名 geocode 後查詢", async () => {
    mockGetCoordinates.mockResolvedValue({ latitude: 25.05, longitude: 121.51 });
    mockFetchEnvironment.mockResolvedValue(envData);
    const raw = await getEnvironmentInfo({ query: "台北車站" });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(true);
    expect(result.query).toBe("台北車站");
    expect(mockGetCoordinates).toHaveBeenCalledWith("台北車站", undefined, undefined);
  });

  it("地名 geocode 失敗回錯誤", async () => {
    mockGetCoordinates.mockResolvedValue(null);
    const raw = await getEnvironmentInfo({ query: "不存在的地點" });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("不存在的地點");
  });

  it("缺少位置資訊回錯誤", async () => {
    const raw = await getEnvironmentInfo({} as any);
    const result = JSON.parse(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("缺少位置資訊");
  });

  it("自訂 radius 傳遞正確", async () => {
    mockFetchEnvironment.mockResolvedValue(envData);
    await getEnvironmentInfo({ latitude: 25, longitude: 121, radius: 2000 });
    expect(mockFetchEnvironment).toHaveBeenCalledWith(25, 121, 2000);
  });

  it("geocode 帶入 userLocation 作 bias", async () => {
    mockGetCoordinates.mockResolvedValue({ latitude: 25.05, longitude: 121.51 });
    mockFetchEnvironment.mockResolvedValue(envData);
    await getEnvironmentInfo({
      query: "車站",
      userLocation: { latitude: 25.1, longitude: 121.6 },
    });
    expect(mockGetCoordinates).toHaveBeenCalledWith("車站", 25.1, 121.6);
  });

  it("service 拋錯時回 fallback 錯誤", async () => {
    mockFetchEnvironment.mockRejectedValue(new Error("boom"));
    const raw = await getEnvironmentInfo({ latitude: 25, longitude: 121 });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("環境資訊查詢失敗");
  });
});

// ---------------------------------------------------------------------------
// getNearbyHazards
// ---------------------------------------------------------------------------
describe("getNearbyHazards", () => {
  const hazardResult = {
    ok: true,
    httpCode: 200,
    message: "找到 2 筆附近路況回報",
    data: { reports: [{ id: "a" }, { id: "b" }], total: 2 },
  };

  it("用經緯度查詢成功", async () => {
    mockHazardFindNearby.mockResolvedValue(hazardResult);
    const raw = await getNearbyHazards({ latitude: 25.05, longitude: 121.51 });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(true);
    expect(result.data.total).toBe(2);
    expect(mockHazardFindNearby).toHaveBeenCalledWith({
      lat: 25.05,
      lng: 121.51,
      radius: undefined,
      hazardType: undefined,
    });
  });

  it("用地名 geocode 後查詢", async () => {
    mockGetCoordinates.mockResolvedValue({ latitude: 25.05, longitude: 121.51 });
    mockHazardFindNearby.mockResolvedValue(hazardResult);
    const raw = await getNearbyHazards({ query: "中正紀念堂" });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(true);
    expect(mockHazardFindNearby).toHaveBeenCalledWith(
      expect.objectContaining({ lat: 25.05, lng: 121.51 }),
    );
  });

  it("地名 geocode 失敗回錯誤", async () => {
    mockGetCoordinates.mockResolvedValue(null);
    const raw = await getNearbyHazards({ query: "火星" });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("火星");
  });

  it("傳遞 hazardType 篩選", async () => {
    mockHazardFindNearby.mockResolvedValue(hazardResult);
    await getNearbyHazards({ latitude: 25, longitude: 121, hazardType: "construction" });
    expect(mockHazardFindNearby).toHaveBeenCalledWith(
      expect.objectContaining({ hazardType: "construction" }),
    );
  });

  it("傳遞 radiusM", async () => {
    mockHazardFindNearby.mockResolvedValue(hazardResult);
    await getNearbyHazards({ latitude: 25, longitude: 121, radiusM: 1000 });
    expect(mockHazardFindNearby).toHaveBeenCalledWith(
      expect.objectContaining({ radius: 1000 }),
    );
  });

  it("缺少位置資訊回錯誤", async () => {
    const raw = await getNearbyHazards({});
    const result = JSON.parse(raw);
    expect(result.ok).toBe(false);
  });

  it("service 拋錯時回 fallback", async () => {
    mockHazardFindNearby.mockRejectedValue(new Error("db down"));
    const raw = await getNearbyHazards({ latitude: 25, longitude: 121 });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("附近路況查詢失敗");
  });
});

// ---------------------------------------------------------------------------
// findNearbyParking
// ---------------------------------------------------------------------------
describe("findNearbyParking", () => {
  const spots = [
    { _id: "1", location: { coordinates: [121.51, 25.05] }, address: "中正路1號" },
    { _id: "2", location: { coordinates: [121.52, 25.04] }, address: "信義路2號" },
  ];

  it("用經緯度查詢成功", async () => {
    mockA11yParking.mockResolvedValue(spots);
    const raw = await findNearbyParking({ latitude: 25.05, longitude: 121.51 });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(true);
    expect(result.total).toBe(2);
    expect(result.parkingSpots).toHaveLength(2);
    expect(mockA11yParking).toHaveBeenCalledWith(25.05, 121.51, 500);
  });

  it("用地名 geocode 後查詢", async () => {
    mockGetCoordinates.mockResolvedValue({ latitude: 25.05, longitude: 121.51 });
    mockA11yParking.mockResolvedValue(spots);
    const raw = await findNearbyParking({ query: "板橋車站" });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(true);
    expect(result.query).toBe("板橋車站");
  });

  it("自訂 radiusM", async () => {
    mockA11yParking.mockResolvedValue([]);
    await findNearbyParking({ latitude: 25, longitude: 121, radiusM: 1000 });
    expect(mockA11yParking).toHaveBeenCalledWith(25, 121, 1000);
  });

  it("無結果時 total 為 0", async () => {
    mockA11yParking.mockResolvedValue([]);
    const raw = await findNearbyParking({ latitude: 25, longitude: 121 });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(true);
    expect(result.total).toBe(0);
    expect(result.parkingSpots).toEqual([]);
  });

  it("缺少位置回錯誤", async () => {
    const raw = await findNearbyParking({});
    const result = JSON.parse(raw);
    expect(result.ok).toBe(false);
  });

  it("geocode 失敗回錯誤", async () => {
    mockGetCoordinates.mockResolvedValue(null);
    const raw = await findNearbyParking({ query: "外太空" });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("外太空");
  });

  it("service 拋錯時回 fallback", async () => {
    mockA11yParking.mockRejectedValue(new Error("db down"));
    const raw = await findNearbyParking({ latitude: 25, longitude: 121 });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("身障停車位查詢失敗");
  });
});

// ---------------------------------------------------------------------------
// getNavInstructions
// ---------------------------------------------------------------------------
describe("getNavInstructions", () => {
  const fakeRoute = {
    routeName: "307 → 板南線",
    totalMinutes: 25,
    transferCount: 1,
    legs: [
      { type: "WALK", from: "起點", to: "台北車站", distanceM: 200, minutesEst: 3 },
      { type: "METRO", lineName: "板南線", departureStation: "台北車站", arrivalStation: "忠孝復興" },
    ],
  };

  const planOk = {
    ok: true,
    data: {
      origin: { lat: 25.05, lng: 121.51 },
      destination: { lat: 25.04, lng: 121.54 },
      city: "Taipei",
      routes: [fakeRoute],
    },
  };

  const navOk = {
    ok: true as const,
    data: {
      instructions: [
        { text: "請朝東方向出發", type: "depart", legType: "WALK" },
        { text: "請搭乘板南線", type: "transit_board", legType: "METRO" },
        { text: "您已抵達目的地", type: "arrive", legType: "METRO" },
      ],
      initialBearing: 90,
      totalSteps: 3,
      warnings: [],
    },
  };

  it("規劃路線 + 產出導航指引", async () => {
    mockPlanRoute.mockResolvedValue(planOk);
    mockGenNav.mockReturnValue(navOk);
    const raw = await getNavInstructions({
      origin: "台北車站",
      destination: "忠孝復興",
    });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(true);
    expect(result.routeName).toBe("307 → 板南線");
    expect(result.totalSteps).toBe(3);
    expect(result.instructions).toHaveLength(3);
    expect(result.instructions[0].text).toContain("東");
  });

  it("planRoute 失敗時回錯誤", async () => {
    mockPlanRoute.mockResolvedValue({ ok: false, error: "找不到路線" });
    const raw = await getNavInstructions({
      origin: "A",
      destination: "B",
    });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("找不到路線");
  });

  it("generateNavInstructions 失敗時回錯誤", async () => {
    mockPlanRoute.mockResolvedValue(planOk);
    mockGenNav.mockReturnValue({
      ok: false,
      status: 400,
      reason: "INVALID_ROUTE_INPUT",
      message: "route 欄位格式錯誤",
    });
    const raw = await getNavInstructions({
      origin: "A",
      destination: "B",
    });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("格式錯誤");
  });

  it("current_location 無 userLocation 回錯誤", async () => {
    const raw = await getNavInstructions({
      origin: "current_location",
      destination: "B",
    });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("使用者位置");
  });

  it("current_location + userLocation 正常規劃", async () => {
    mockPlanRoute.mockResolvedValue(planOk);
    mockGenNav.mockReturnValue(navOk);
    const raw = await getNavInstructions({
      origin: "current_location",
      destination: "B",
      userLocation: { latitude: 25.05, longitude: 121.51 },
    });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(true);
    expect(mockPlanRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: { latitude: 25.05, longitude: 121.51 },
      }),
    );
  });

  it("routeIndex 選擇第二條路線", async () => {
    const secondRoute = { ...fakeRoute, routeName: "紅線直達" };
    mockPlanRoute.mockResolvedValue({
      ...planOk,
      data: { ...planOk.data, routes: [fakeRoute, secondRoute] },
    });
    mockGenNav.mockReturnValue(navOk);
    const raw = await getNavInstructions({
      origin: "A",
      destination: "B",
      routeIndex: 1,
    });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(true);
    expect(mockGenNav).toHaveBeenCalledWith(
      { legs: secondRoute.legs },
      undefined,
    );
  });

  it("routeIndex 超出範圍時 clamp 到最後一條", async () => {
    mockPlanRoute.mockResolvedValue(planOk);
    mockGenNav.mockReturnValue(navOk);
    await getNavInstructions({
      origin: "A",
      destination: "B",
      routeIndex: 99,
    });
    expect(mockGenNav).toHaveBeenCalledWith(
      { legs: fakeRoute.legs },
      undefined,
    );
  });

  it("傳遞 userHeading 給 generateNavInstructions", async () => {
    mockPlanRoute.mockResolvedValue(planOk);
    mockGenNav.mockReturnValue(navOk);
    await getNavInstructions({
      origin: "A",
      destination: "B",
      userHeading: 45,
    });
    expect(mockGenNav).toHaveBeenCalledWith(
      expect.anything(),
      45,
    );
  });

  it("傳遞 mode 和 departureTime", async () => {
    mockPlanRoute.mockResolvedValue(planOk);
    mockGenNav.mockReturnValue(navOk);
    await getNavInstructions({
      origin: "A",
      destination: "B",
      mode: "wheelchair",
      departureTime: "14:00",
    });
    expect(mockPlanRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "wheelchair",
        departureTime: "14:00",
      }),
    );
  });

  it("無效 mode 降級為 normal", async () => {
    mockPlanRoute.mockResolvedValue(planOk);
    mockGenNav.mockReturnValue(navOk);
    await getNavInstructions({
      origin: "A",
      destination: "B",
      mode: "flying_carpet",
    });
    expect(mockPlanRoute).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "normal" }),
    );
  });

  it("planRoute 拋例外時回 fallback", async () => {
    mockPlanRoute.mockRejectedValue(new Error("timeout"));
    const raw = await getNavInstructions({
      origin: "A",
      destination: "B",
    });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("timeout");
  });
});

// ---------------------------------------------------------------------------
// executeLocalTool — 新工具註冊
// ---------------------------------------------------------------------------
describe("executeLocalTool dispatches new tools", () => {
  it("getEnvironmentInfo 走到正確函式", async () => {
    mockFetchEnvironment.mockResolvedValue({
      location: { lat: 25, lng: 121 },
      weather: { status: "ok" },
      airQuality: { status: "ok" },
      nearbyCctv: { status: "ok" },
    });
    const raw = await executeLocalTool(
      "getEnvironmentInfo",
      { latitude: 25, longitude: 121 },
      undefined,
    );
    expect(JSON.parse(raw).ok).toBe(true);
  });

  it("getNearbyHazards 走到正確函式", async () => {
    mockHazardFindNearby.mockResolvedValue({
      ok: true,
      data: { reports: [], total: 0 },
    });
    const raw = await executeLocalTool(
      "getNearbyHazards",
      { latitude: 25, longitude: 121 },
      undefined,
    );
    expect(JSON.parse(raw).ok).toBe(true);
  });

  it("findNearbyParking 走到正確函式", async () => {
    mockA11yParking.mockResolvedValue([]);
    const raw = await executeLocalTool(
      "findNearbyParking",
      { latitude: 25, longitude: 121 },
      undefined,
    );
    expect(JSON.parse(raw).ok).toBe(true);
  });

  it("getNavInstructions 走到正確函式", async () => {
    mockPlanRoute.mockResolvedValue({
      ok: true,
      data: {
        origin: { lat: 25, lng: 121 },
        destination: { lat: 25, lng: 121 },
        city: "Taipei",
        routes: [{ routeName: "x", totalMinutes: 5, legs: [{ type: "WALK" }] }],
      },
    });
    mockGenNav.mockReturnValue({
      ok: true,
      data: { instructions: [], initialBearing: 0, totalSteps: 0, warnings: [] },
    });
    const raw = await executeLocalTool(
      "getNavInstructions",
      { origin: "A", destination: "B" },
      undefined,
    );
    expect(JSON.parse(raw).ok).toBe(true);
  });

  it("未知工具回錯誤", async () => {
    const raw = await executeLocalTool("noSuchTool", {}, undefined);
    expect(JSON.parse(raw).error).toContain("未知工具");
  });

  it("saveMemory 走到正確函式", async () => {
    const mockSave = memoryServiceMod.saveMemory as unknown as ReturnType<typeof vi.fn>;
    mockSave.mockResolvedValue({ _id: "m1", content: "坐輪椅", category: "preference" });
    const raw = await executeLocalTool(
      "saveMemory",
      { content: "坐輪椅", category: "preference" },
      undefined,
      "user123",
    );
    expect(JSON.parse(raw).ok).toBe(true);
    expect(JSON.parse(raw).memory.content).toBe("坐輪椅");
  });

  it("deleteMemory 走到正確函式", async () => {
    const mockDel = memoryServiceMod.deleteMemory as unknown as ReturnType<typeof vi.fn>;
    mockDel.mockResolvedValue(true);
    const raw = await executeLocalTool(
      "deleteMemory",
      { memoryId: "m1" },
      undefined,
      "user123",
    );
    expect(JSON.parse(raw).ok).toBe(true);
  });

  it("webSearch 走到正確函式", async () => {
    mockGenerateContent.mockResolvedValue({
      text: "搜尋摘要",
      candidates: [{ groundingMetadata: { groundingChunks: [] } }],
    });
    const raw = await executeLocalTool("webSearch", { query: "最新無障礙政策" }, undefined);
    expect(JSON.parse(raw).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// saveMemory / deleteMemory (agent tool functions)
// ---------------------------------------------------------------------------
describe("saveMemory agent tool", () => {
  const mockSave = memoryServiceMod.saveMemory as unknown as ReturnType<typeof vi.fn>;

  it("有 userId + 有效 category 成功儲存", async () => {
    mockSave.mockResolvedValue({ _id: "m1", content: "家住板橋", category: "place" });
    const raw = await saveMemory({ content: "家住板橋", category: "place", userId: "u1" });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(true);
    expect(result.memory.content).toBe("家住板橋");
  });

  it("無 userId 回錯誤", async () => {
    const raw = await saveMemory({ content: "test", category: "place" });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("登入");
  });

  it("空 content 回錯誤", async () => {
    const raw = await saveMemory({ content: "", category: "place", userId: "u1" });
    expect(JSON.parse(raw).ok).toBe(false);
  });

  it("無效 category 回錯誤", async () => {
    const raw = await saveMemory({ content: "test", category: "invalid", userId: "u1" });
    expect(JSON.parse(raw).ok).toBe(false);
    expect(JSON.parse(raw).error).toContain("無效");
  });
});

describe("deleteMemory agent tool", () => {
  const mockDel = memoryServiceMod.deleteMemory as unknown as ReturnType<typeof vi.fn>;

  it("有 userId 成功刪除", async () => {
    mockDel.mockResolvedValue(true);
    const raw = await deleteMemory({ memoryId: "m1", userId: "u1" });
    expect(JSON.parse(raw).ok).toBe(true);
  });

  it("找不到回錯誤", async () => {
    mockDel.mockResolvedValue(false);
    const raw = await deleteMemory({ memoryId: "m1", userId: "u1" });
    expect(JSON.parse(raw).ok).toBe(false);
  });

  it("無 userId 回錯誤", async () => {
    const raw = await deleteMemory({ memoryId: "m1" });
    expect(JSON.parse(raw).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// searchAccessibilityGuide
// ---------------------------------------------------------------------------
describe("searchAccessibilityGuide", () => {
  const mockSearch = searchKnowledge as unknown as ReturnType<typeof vi.fn>;

  it("有結果時回傳 content + source", async () => {
    mockSearch.mockResolvedValue([
      { content: "輪椅搭公車步驟…", source: "台北市公共運輸處", category: "transit_tips", title: "輪椅搭公車 SOP", score: 0.92 },
    ]);
    const raw = await searchAccessibilityGuide({ query: "輪椅怎麼搭公車" });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].title).toBe("輪椅搭公車 SOP");
  });

  it("無結果時回空陣列", async () => {
    mockSearch.mockResolvedValue([]);
    const raw = await searchAccessibilityGuide({ query: "火星交通" });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(true);
    expect(result.results).toEqual([]);
  });

  it("空 query 回錯誤", async () => {
    const raw = await searchAccessibilityGuide({ query: "" });
    expect(JSON.parse(raw).ok).toBe(false);
  });

  it("service 拋錯回 fallback", async () => {
    mockSearch.mockRejectedValue(new Error("chroma down"));
    const raw = await searchAccessibilityGuide({ query: "test" });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("知識庫查詢失敗");
  });

  it("executeLocalTool dispatch 正確", async () => {
    mockSearch.mockResolvedValue([]);
    const raw = await executeLocalTool("searchAccessibilityGuide", { query: "test" }, undefined);
    expect(JSON.parse(raw).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// webSearch
// ---------------------------------------------------------------------------
describe("webSearch", () => {
  it("使用 Gemini Google Search 並整理來源", async () => {
    mockGenerateContent.mockResolvedValue({
      text: "台北市近期更新了無障礙交通資訊。",
      candidates: [
        {
          groundingMetadata: {
            webSearchQueries: ["台北市 無障礙交通 最新"],
            groundingChunks: [
              {
                web: {
                  uri: "https://example.gov.tw/news",
                  title: "官方新聞",
                  domain: "example.gov.tw",
                },
              },
              {
                web: {
                  uri: "https://example.gov.tw/news",
                  title: "重複來源",
                  domain: "example.gov.tw",
                },
              },
            ],
          },
        },
      ],
    });

    const raw = await webSearch({ query: "台北市無障礙交通最新政策" });
    const result = JSON.parse(raw);

    expect(result.ok).toBe(true);
    expect(result.answer).toContain("台北市");
    expect(result.webSearchQueries).toEqual(["台北市 無障礙交通 最新"]);
    expect(result.sources).toEqual([
      {
        title: "官方新聞",
        url: "https://example.gov.tw/news",
        domain: "example.gov.tw",
      },
    ]);
    expect(mockGenerateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "test-model",
        contents: "台北市無障礙交通最新政策",
        config: expect.objectContaining({
          tools: [{ googleSearch: {} }],
        }),
      }),
    );
  });

  it("空 query 回錯誤", async () => {
    const raw = await webSearch({ query: "   " });
    expect(JSON.parse(raw).ok).toBe(false);
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it("Gemini 搜尋失敗時回 fallback", async () => {
    mockGenerateContent.mockRejectedValue(new Error("quota"));
    const raw = await webSearch({ query: "最新消息" });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("網路搜尋失敗");
  });
});
