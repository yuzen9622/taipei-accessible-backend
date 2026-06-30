import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../config/fetch", () => ({ tdxFetch: vi.fn() }));

import { tdxFetch } from "../../config/fetch";
import { fetchWaitInfo } from "./accessible-route.service";

const tdxFetchMock = tdxFetch as unknown as ReturnType<typeof vi.fn>;

function mockEta(rows: unknown[]) {
  tdxFetchMock.mockResolvedValue({ ok: true, json: async () => rows });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Freeze the clock at Taipei 10:00:00 (UTC+8) so schedule clock times are deterministic.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-30T02:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("fetchWaitInfo — realtime vs schedule source", () => {
  it("StopStatus 1（尚未發車）的 EstimateTime 是下一班發車倒數，回 schedule 發車時刻而非 realtime", async () => {
    mockEta([
      {
        StopName: { Zh_tw: "捷運市政府站" },
        Direction: 0,
        EstimateTime: 6180, // 103 分鐘後才發車
        StopStatus: 1,
      },
    ]);

    const result = await fetchWaitInfo("671", "Taipei", 0, "捷運市政府站");

    expect(result.source).toBe("schedule");
    expect(result.time).toBe("11:43"); // 10:00 + 103 分
    expect(result.time).not.toBe(103);
    // EstimateTime 已可用，不需再打班表查詢
    expect(tdxFetchMock).toHaveBeenCalledTimes(1);
  });

  it("StopStatus 0（車輛在路上）才回 realtime 分鐘數", async () => {
    mockEta([
      {
        StopName: { Zh_tw: "捷運市政府站" },
        Direction: 0,
        EstimateTime: 180,
        StopStatus: 0,
      },
    ]);

    const result = await fetchWaitInfo("671", "Taipei", 0, "捷運市政府站");

    expect(result.source).toBe("realtime");
    expect(result.time).toBe(3);
  });
});
