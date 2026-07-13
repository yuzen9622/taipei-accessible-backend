import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../adapters/line.adapter", () => ({
  replyAgentResult: vi.fn().mockResolvedValue(undefined),
  replyText: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../agent/history-adapter", () => ({
  toGeminiHistory: vi.fn(() => ({ systemInstruction: "sys", contents: [] })),
}));

vi.mock("../agent/agent-manager.service", () => ({
  runToolLoop: vi.fn().mockResolvedValue({ text: "agent reply" }),
}));

vi.mock("../../config/ai", () => ({
  model: "test-model",
}));

vi.mock("../../config/ai/line-family-prompt", () => ({
  LINE_FAMILY_SYSTEM_PROMPT: "family prompt",
}));

vi.mock("../../model/emergency-contact.model", () => ({
  default: {
    findOne: vi.fn(),
    updateMany: vi.fn(),
  },
}));

vi.mock("../../model/sos-session.model", () => ({
  default: {
    findById: vi.fn(),
  },
}));

vi.mock("../../model/user.model", () => ({
  default: {
    findById: vi.fn(),
  },
}));

vi.mock("../accessible-route/accessible-route.service", () => ({
  planAccessibleRouteFromRequest: vi.fn(),
}));

import { getRoutePreview, handleEvents } from "./line.service";
import { replyAgentResult, replyText } from "../../adapters/line.adapter";
import { runToolLoop } from "../agent/agent-manager.service";
import { toGeminiHistory } from "../agent/history-adapter";
import EmergencyContact from "../../model/emergency-contact.model";
import SosSession from "../../model/sos-session.model";
import User from "../../model/user.model";
import { planAccessibleRouteFromRequest } from "../accessible-route/accessible-route.service";
import { LINE_MSG } from "../../constants/messages";
import { ResponseCode } from "../../types/code";
import type { LineEvent } from "./line.types";

const contactModel = EmergencyContact as unknown as {
  findOne: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
};
const sosSessionModel = SosSession as unknown as {
  findById: ReturnType<typeof vi.fn>;
};
const userModel = User as unknown as {
  findById: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.resetAllMocks();
  delete process.env.PUBLIC_LIFF_ROUTE_BASE_URL;
  vi.mocked(replyAgentResult).mockResolvedValue(undefined);
  vi.mocked(replyText).mockResolvedValue(undefined);
  vi.mocked(runToolLoop).mockResolvedValue({ text: "agent reply", toolResults: [] });
  vi.mocked(planAccessibleRouteFromRequest).mockResolvedValue({
    ok: true,
    data: {
      origin: { lat: 25.03, lng: 121.56 },
      destination: { lat: 25.0478, lng: 121.5171 },
      city: "Taipei",
      travelMode: "transit",
      routes: [{ routeName: "route1", totalMinutes: 12, legs: [{ type: "WALK" }] }],
    } as any,
  });
});

function textEvent(text: string): LineEvent {
  return {
    type: "message",
    replyToken: "r1",
    message: { type: "text", text },
    source: { type: "user", userId: "U1" },
  } as unknown as LineEvent;
}

describe("line.service — follow", () => {
  it("replies the welcome message", async () => {
    await handleEvents([
      { type: "follow", replyToken: "rF", source: { type: "user", userId: "U1" } } as unknown as LineEvent,
    ]);
    expect(vi.mocked(replyText)).toHaveBeenCalledWith("rF", LINE_MSG.WELCOME);
  });
});

describe("line.service — message", () => {
  it("sends text messages into the agent loop and replies with the result", async () => {
    await handleEvents([textEvent("他現在在哪")]);

    expect(vi.mocked(runToolLoop)).toHaveBeenCalled();
    expect(vi.mocked(replyAgentResult)).toHaveBeenCalledWith("r1", "agent reply", null);
  });

  it("injects the current date into the system prompt (F23)", async () => {
    await handleEvents([textEvent("明天九點的火車")]);
    const messages = vi.mocked(toGeminiHistory).mock.calls.at(-1)![0] as Array<{
      role: string;
      content: string;
    }>;
    const system = messages.find((m) => m.role === "system");
    expect(system?.content).toContain("【今天日期】");
  });

  it("turns structured route_card JSON into a text reply plus route card payload", async () => {
    vi.mocked(runToolLoop).mockResolvedValue({
      text: JSON.stringify({
        speech: "我幫你找到 3 種路線，機車最快，約 8 分鐘。",
        ui_type: "route_card",
        ui_data: {
          origin: "清華大學",
          destination: "陽明交通大學",
          scooter_time: "8 分鐘",
          car_time: "10 分鐘",
          transit_time: "25 分鐘",
          liff_url: "https://liff.example.com/route?id=abc123",
        },
      }),
      toolResults: [],
    });

    await handleEvents([textEvent("清大到交大")]);

    expect(vi.mocked(replyAgentResult)).toHaveBeenCalledWith(
      "r1",
      "我幫你找到 3 種路線，機車最快，約 8 分鐘。",
      {
        origin: "清華大學",
        destination: "陽明交通大學",
        options: [
          { label: "機車", time: "8 分鐘" },
          { label: "汽車", time: "10 分鐘" },
          { label: "大眾運輸", time: "25 分鐘" },
        ],
        liffUrl: "https://liff.example.com/route?id=abc123",
      },
    );
  });

  it("builds a route card from the planRouteToSosVictim tool result when final text is plain speech", async () => {
    process.env.PUBLIC_LIFF_ROUTE_BASE_URL = "https://liff.example.com/route";
    vi.mocked(runToolLoop).mockResolvedValue({
      text: "我幫你找到可前往的路線。",
      toolResults: [
        {
          name: "planRouteToSosVictim",
          args: { sessionId: "s1" },
          result: {
            ok: true,
            sessionId: "s1",
            ownerName: "王小明",
            destination: { address: "台北車站" },
            routes: [
              {
                routeName: "無障礙路線",
                totalMinutes: 12,
                legs: [{ type: "WALK" }, { type: "BUS", routeName: "307" }],
              },
            ],
          },
        },
      ],
    });

    await handleEvents([textEvent("我要過去")]);

    expect(vi.mocked(replyAgentResult)).toHaveBeenCalledWith(
      "r1",
      "我幫你找到可前往的路線。",
      {
        origin: "你分享的位置",
        destination: "台北車站",
        options: [
          {
            label: "無障礙路線",
            time: "約 12 分鐘",
            detail: "步行 → 公車 307",
          },
        ],
        liffUrl: "https://liff.example.com/route?sessionId=s1",
      },
    );
  });

  it("falls back to plain speech when structured JSON has no supported UI card", async () => {
    vi.mocked(runToolLoop).mockResolvedValue({
      text: JSON.stringify({ speech: "目前沒有進行中的求救。", ui_type: "none", ui_data: {} }),
      toolResults: [],
    });

    await handleEvents([textEvent("他現在在哪")]);

    expect(vi.mocked(replyAgentResult)).toHaveBeenCalledWith(
      "r1",
      "目前沒有進行中的求救。",
      null,
    );
  });

  it("falls back to the fixed info reply when the agent fails", async () => {
    vi.mocked(runToolLoop).mockRejectedValue(new Error("boom"));

    await handleEvents([textEvent("他現在在哪")]);

    expect(vi.mocked(replyText)).toHaveBeenCalledWith("r1", LINE_MSG.INFO);
  });

  it("stores shared location and acknowledges it", async () => {
    vi.mocked(runToolLoop).mockResolvedValue({
      text: JSON.stringify({ speech: "規劃路線中..." }),
      toolResults: [],
    });

    await handleEvents([
      {
        type: "message",
        replyToken: "r2",
        source: { type: "user", userId: "U1" },
        message: {
          type: "location",
          title: "現在位置",
          address: "台北車站",
          latitude: 25.0478,
          longitude: 121.5171,
        },
      } as unknown as LineEvent,
    ]);

    expect(contactModel.updateMany).toHaveBeenCalledWith(
      { lineUserId: "U1", bindStatus: "bound" },
      {
        $set: {
          lastLineLat: 25.0478,
          lastLineLng: 121.5171,
          lastLineLocationUpdatedAt: expect.any(Date),
        },
      },
    );
    expect(vi.mocked(replyAgentResult)).toHaveBeenCalledWith(
      "r2",
      "規劃路線中...",
      null
    );
  });
});

describe("line.service — unfollow", () => {
  it("resets all contacts bound to the LINE user back to pending", async () => {
    contactModel.updateMany.mockResolvedValue({ modifiedCount: 2 });

    await handleEvents([
      { type: "unfollow", source: { type: "user", userId: "U1" } } as unknown as LineEvent,
    ]);

    expect(contactModel.updateMany).toHaveBeenCalledWith(
      { lineUserId: "U1" },
      { $set: { bindStatus: "pending", lineUserId: null } },
    );
  });
});

describe("line.service — route preview", () => {
  it("plans a route from the latest bound contact location to an active SOS session", async () => {
    const sessionId = "68ef6e5b7f7f3a3b78f51291";
    sosSessionModel.findById.mockReturnValue({
      lean: () => Promise.resolve({
        _id: sessionId,
        userId: "u1",
        status: "active",
        lat: 25.0478,
        lng: 121.5171,
        address: "台北車站",
      }),
    });
    contactModel.findOne.mockReturnValue({
      sort: () => ({
        select: () => ({
          lean: () => Promise.resolve({
            lastLineLat: 25.03,
            lastLineLng: 121.56,
          }),
        }),
      }),
    });
    userModel.findById.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve({ name: "王小明" }) }),
    });

    const result = await getRoutePreview(sessionId);

    expect(result.ok).toBe(true);
    expect(vi.mocked(planAccessibleRouteFromRequest)).toHaveBeenCalledWith({
      origin: { latitude: 25.03, longitude: 121.56 },
      destination: { latitude: 25.0478, longitude: 121.5171 },
      mode: "normal",
      travelMode: "drive",
      maxTransfers: 2,
      departureTime: undefined,
    });
    expect(result.data).toMatchObject({
      sessionId,
      ownerName: "王小明",
      origin: { lat: 25.03, lng: 121.56 },
      destination: { lat: 25.0478, lng: 121.5171 },
      originLabel: "你分享的位置",
      destinationLabel: "台北車站",
      routes: [{ routeName: "route1" }],
    });
  });

  it("returns 404 when the session is not active", async () => {
    sosSessionModel.findById.mockReturnValue({
      lean: () => Promise.resolve({ _id: "68ef6e5b7f7f3a3b78f51291", status: "resolved" }),
    });

    const result = await getRoutePreview("68ef6e5b7f7f3a3b78f51291");

    expect(result.ok).toBe(false);
    expect(result.httpCode).toBe(ResponseCode.NOT_FOUND);
    expect(vi.mocked(planAccessibleRouteFromRequest)).not.toHaveBeenCalled();
  });

  it("returns 400 when no bound contact has shared a location", async () => {
    sosSessionModel.findById.mockReturnValue({
      lean: () => Promise.resolve({
        _id: "68ef6e5b7f7f3a3b78f51291",
        userId: "u1",
        status: "active",
        lat: 25.0478,
        lng: 121.5171,
      }),
    });
    contactModel.findOne.mockReturnValue({
      sort: () => ({
        select: () => ({ lean: () => Promise.resolve(null) }),
      }),
    });

    const result = await getRoutePreview("68ef6e5b7f7f3a3b78f51291");

    expect(result.ok).toBe(false);
    expect(result.httpCode).toBe(ResponseCode.INVALID_INPUT);
    expect(vi.mocked(planAccessibleRouteFromRequest)).not.toHaveBeenCalled();
  });

  it("passes travelMode, mode, and departureTime to planAccessibleRouteFromRequest", async () => {
    const sessionId = "68ef6e5b7f7f3a3b78f51291";
    sosSessionModel.findById.mockReturnValue({
      lean: () => Promise.resolve({
        _id: sessionId,
        userId: "u1",
        status: "active",
        lat: 25.0478,
        lng: 121.5171,
        address: "台北車站",
      }),
    });
    contactModel.findOne.mockReturnValue({
      sort: () => ({
        select: () => ({
          lean: () => Promise.resolve({
            lastLineLat: 25.03,
            lastLineLng: 121.56,
          }),
        }),
      }),
    });
    userModel.findById.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve({ name: "王小明" }) }),
    });

    const result = await getRoutePreview(sessionId, "drive", "wheelchair", "2026-07-09T16:00:00+08:00");

    expect(result.ok).toBe(true);
    expect(vi.mocked(planAccessibleRouteFromRequest)).toHaveBeenCalledWith({
      origin: { latitude: 25.03, longitude: 121.56 },
      destination: { latitude: 25.0478, longitude: 121.5171 },
      mode: "wheelchair",
      travelMode: "drive",
      maxTransfers: 2,
      departureTime: "2026-07-09T16:00:00+08:00",
    });
  });
});
