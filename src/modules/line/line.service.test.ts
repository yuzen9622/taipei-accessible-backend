import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../adapters/line.adapter", () => ({
  replyAgentResult: vi.fn().mockResolvedValue(undefined),
  replyText: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../agent/history-adapter", () => ({
  toGeminiHistory: vi.fn(() => ({ systemInstruction: "sys", contents: [] })),
}));

vi.mock("../agent/agent-manager.service", () => ({
  summarizeWithContext: vi.fn(),
}));

vi.mock("../agent/intent-classifier.service", () => ({
  classifyIntent: vi.fn(),
}));

vi.mock("../agent/action-registry", () => ({
  getActionSpec: vi.fn(),
}));

vi.mock("../agent/action-executor.service", () => ({
  executeAction: vi.fn(),
}));

vi.mock("../ai/agent-tools", () => ({
  executeLocalTool: vi.fn(),
}));

vi.mock("./line-state", () => ({
  getLineState: vi.fn(),
  updateLineState: vi.fn(),
  clearPendingIntent: vi.fn(),
}));

vi.mock("../../config/ai", () => ({
  model: "test-model",
}));

vi.mock("../../config/ai/line-family-prompt", () => ({
  LINE_FAMILY_SYSTEM_PROMPT: "family prompt",
}));

vi.mock("../../config/ai/chat-prompt", () => ({
  withCurrentDate: (value: string) => value,
}));

vi.mock("./line-memory", () => ({
  getLineChatHistory: vi.fn(),
  appendLineChatTurn: vi.fn(),
}));

vi.mock("../../model/emergency-contact.model", () => ({
  default: {
    find: vi.fn(),
    findOne: vi.fn(),
    exists: vi.fn(),
    updateMany: vi.fn(),
  },
}));

vi.mock("../../model/line-link-code.model", () => ({
  default: {
    exists: vi.fn(),
  },
}));

vi.mock("../../model/sos-session.model", () => ({
  default: {
    findById: vi.fn(),
  },
}));

vi.mock("../../model/user.model", () => ({
  default: {
    find: vi.fn(),
    findById: vi.fn(),
  },
}));

vi.mock("../accessible-route/accessible-route.service", () => ({
  planAccessibleRouteFromRequest: vi.fn(),
}));

import { getRoutePreview, handleEvents } from "./line.service";
import { replyAgentResult, replyText } from "../../adapters/line.adapter";
import { classifyIntent } from "../agent/intent-classifier.service";
import { getActionSpec } from "../agent/action-registry";
import { executeAction } from "../agent/action-executor.service";
import { summarizeWithContext } from "../agent/agent-manager.service";
import {
  clearPendingIntent,
  getLineState,
  updateLineState,
} from "./line-state";
import EmergencyContact from "../../model/emergency-contact.model";
import SosSession from "../../model/sos-session.model";
import User from "../../model/user.model";
import { planAccessibleRouteFromRequest } from "../accessible-route/accessible-route.service";
import { LINE_MSG } from "../../constants/messages";
import { ResponseCode } from "../../types/code";
import type { LineEvent } from "./line.types";
import type { ActionSpec } from "../agent/agent-intent.types";
import { appendLineChatTurn, getLineChatHistory } from "./line-memory";

const contactModel = EmergencyContact as unknown as {
  find: ReturnType<typeof vi.fn>;
  findOne: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
};
const sosSessionModel = SosSession as unknown as {
  findById: ReturnType<typeof vi.fn>;
};
const userModel = User as unknown as {
  find: ReturnType<typeof vi.fn>;
  findById: ReturnType<typeof vi.fn>;
};

function makeSpec(overrides: Partial<ActionSpec> = {}): ActionSpec {
  return {
    requiredSlots: () => [],
    askFor: {},
    steps: [],
    allowList: [],
    needsUserLocation: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  delete process.env.PUBLIC_LIFF_ROUTE_BASE_URL;
  vi.mocked(replyAgentResult).mockResolvedValue(undefined);
  vi.mocked(replyText).mockResolvedValue(undefined);
  vi.mocked(getLineChatHistory).mockResolvedValue([]);
  vi.mocked(appendLineChatTurn).mockResolvedValue(undefined);
  vi.mocked(getLineState).mockResolvedValue(null);
  vi.mocked(updateLineState).mockResolvedValue({ ok: true });
  vi.mocked(clearPendingIntent).mockResolvedValue({ ok: true });
  vi.mocked(classifyIntent).mockResolvedValue({
    action: "smalltalk",
    slots: {},
    confidence: "high",
  });
  vi.mocked(getActionSpec).mockReturnValue(makeSpec());
  vi.mocked(executeAction).mockResolvedValue({
    kind: "speech",
    speech: "ok",
    toolResults: [],
  });
  vi.mocked(summarizeWithContext).mockResolvedValue("哈囉");
  contactModel.find.mockReturnValue({
    select: () => ({ lean: () => Promise.resolve([]) }),
  });
  userModel.find.mockReturnValue({
    select: () => ({ lean: () => Promise.resolve([]) }),
  });
  vi.mocked(planAccessibleRouteFromRequest).mockResolvedValue({
    ok: true,
    data: {
      origin: { lat: 25.03, lng: 121.56 },
      destination: { lat: 25.0478, lng: 121.5171 },
      city: "Taipei",
      travelMode: "transit",
      routes: [
        { routeName: "route1", totalMinutes: 12, legs: [{ type: "WALK" }] },
      ],
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

function locationEvent(replyToken: string): LineEvent {
  return {
    type: "message",
    replyToken,
    source: { type: "user", userId: "U1" },
    message: {
      type: "location",
      title: "現在位置",
      address: "台北車站",
      latitude: 25.0478,
      longitude: 121.5171,
    },
  } as unknown as LineEvent;
}

describe("line.service — follow", () => {
  it("replies the welcome message", async () => {
    await handleEvents([
      {
        type: "follow",
        replyToken: "rF",
        source: { type: "user", userId: "U1" },
      } as unknown as LineEvent,
    ]);
    expect(vi.mocked(replyText)).toHaveBeenCalledWith("rF", LINE_MSG.WELCOME);
  });
});

describe("line.service — handleResolvedIntent branches", () => {
  it("app_info action replies the fixed app-info message", async () => {
    vi.mocked(classifyIntent).mockResolvedValue({
      action: "app_info",
      slots: {},
      confidence: "high",
    });

    await handleEvents([textEvent("這個服務是什麼")]);

    expect(vi.mocked(replyText)).toHaveBeenCalledWith("r1", LINE_MSG.APP_INFO);
    expect(vi.mocked(executeAction)).not.toHaveBeenCalled();
  });

  it("unknown action replies the clarify prompt", async () => {
    vi.mocked(classifyIntent).mockResolvedValue({
      action: "unknown",
      slots: {},
      confidence: "low",
    });

    await handleEvents([textEvent("嗯嗯")]);

    expect(vi.mocked(replyText)).toHaveBeenCalledWith("r1", LINE_MSG.CLARIFY);
  });

  it("smalltalk summarizes with context and persists the turn", async () => {
    vi.mocked(classifyIntent).mockResolvedValue({
      action: "smalltalk",
      slots: {},
      confidence: "high",
    });
    vi.mocked(summarizeWithContext).mockResolvedValue("你好呀");

    await handleEvents([textEvent("你好嗎")]);

    expect(vi.mocked(summarizeWithContext)).toHaveBeenCalled();
    expect(vi.mocked(replyAgentResult)).toHaveBeenCalledWith(
      "r1",
      "你好呀",
      null,
    );
    expect(vi.mocked(appendLineChatTurn)).toHaveBeenCalledWith(
      "U1",
      "你好嗎",
      "你好呀",
    );
  });

  it("asks for a missing required slot and persists a collecting_slots intent", async () => {
    vi.mocked(classifyIntent).mockResolvedValue({
      action: "weather.query",
      slots: {},
      confidence: "high",
    });
    vi.mocked(getActionSpec).mockReturnValue(
      makeSpec({
        requiredSlots: () => ["query"],
        askFor: { query: "請問要查哪個地區的天氣？" },
        needsUserLocation: true,
      }),
    );

    await handleEvents([textEvent("天氣如何")]);

    expect(vi.mocked(executeAction)).not.toHaveBeenCalled();
    expect(vi.mocked(replyText)).toHaveBeenCalledWith(
      "r1",
      "請問要查哪個地區的天氣？",
    );

    const call = vi.mocked(updateLineState).mock.calls.at(-1)!;
    expect(call[0]).toBe("U1");
    const content = (call[1] as (prev: unknown) => unknown)(null);
    expect(content).toEqual({
      pendingIntent: {
        kind: "collecting_slots",
        action: "weather.query",
        filledSlots: {},
        location: undefined,
        awaitingSlot: "query",
        missingSlots: ["query"],
      },
      lastSharedLocation: undefined,
    });
  });

  it("asks with a recoverable message when persisting the pending intent fails", async () => {
    vi.mocked(classifyIntent).mockResolvedValue({
      action: "weather.query",
      slots: {},
      confidence: "high",
    });
    vi.mocked(getActionSpec).mockReturnValue(
      makeSpec({
        requiredSlots: () => ["query"],
        askFor: { query: "請問要查哪個地區的天氣？" },
      }),
    );
    vi.mocked(updateLineState).mockResolvedValue({ ok: false });

    await handleEvents([textEvent("天氣如何")]);

    expect(vi.mocked(replyText)).toHaveBeenCalledWith(
      "r1",
      LINE_MSG.RECOVERABLE_ASK,
    );
  });

  it("runs a fully-slotted action and returns a plan route card from the tool result", async () => {
    process.env.PUBLIC_LIFF_ROUTE_BASE_URL = "https://liff.example.com/route";
    vi.mocked(classifyIntent).mockResolvedValue({
      action: "route.plan",
      slots: { destination: "台北車站" },
      confidence: "high",
    });
    vi.mocked(getActionSpec).mockReturnValue(
      makeSpec({ needsUserLocation: true, allowList: ["planAccessibleRoute"] }),
    );
    vi.mocked(executeAction).mockResolvedValue({
      kind: "speech",
      speech: "我幫你找到可前往的路線。",
      toolResults: [
        {
          name: "planAccessibleRoute",
          args: {},
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

    await handleEvents([textEvent("規劃到台北車站的路線")]);

    expect(vi.mocked(replyAgentResult)).toHaveBeenCalledWith(
      "r1",
      "我幫你找到可前往的路線。",
      {
        origin: "你的位置",
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

  it("builds a SOS route card whose origin is the shared location", async () => {
    process.env.PUBLIC_LIFF_ROUTE_BASE_URL = "https://liff.example.com/route";
    vi.mocked(classifyIntent).mockResolvedValue({
      action: "sos.route",
      slots: {},
      confidence: "high",
    });
    vi.mocked(getActionSpec).mockReturnValue(
      makeSpec({ allowList: ["getActiveSosContext", "planRouteToSosVictim"] }),
    );
    vi.mocked(executeAction).mockResolvedValue({
      kind: "speech",
      speech: "我幫你找到可前往的路線。",
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

  it("replies plain speech with a null card when the outcome has no route tool result", async () => {
    vi.mocked(classifyIntent).mockResolvedValue({
      action: "weather.query",
      slots: { query: "台北" },
      confidence: "high",
    });
    vi.mocked(executeAction).mockResolvedValue({
      kind: "speech",
      speech: "台北目前多雲。",
      toolResults: [
        { name: "getEnvironmentInfo", args: {}, result: { ok: true } },
      ],
    });

    await handleEvents([textEvent("台北天氣")]);

    expect(vi.mocked(replyAgentResult)).toHaveBeenCalledWith(
      "r1",
      "台北目前多雲。",
      null,
    );
    expect(vi.mocked(appendLineChatTurn)).toHaveBeenCalledWith(
      "U1",
      "台北天氣",
      "台北目前多雲。",
    );
  });

  it("replies a canned message and persists the turn", async () => {
    vi.mocked(classifyIntent).mockResolvedValue({
      action: "sos.location",
      slots: {},
      confidence: "high",
    });
    vi.mocked(executeAction).mockResolvedValue({
      kind: "canned",
      speech: "目前沒有進行中的求救。",
    });

    await handleEvents([textEvent("他現在在哪")]);

    expect(vi.mocked(replyAgentResult)).toHaveBeenCalledWith(
      "r1",
      "目前沒有進行中的求救。",
      null,
    );
    expect(vi.mocked(appendLineChatTurn)).toHaveBeenCalledWith(
      "U1",
      "他現在在哪",
      "目前沒有進行中的求救。",
    );
  });

  it("clarify outcome persists candidates and replies the clarify message", async () => {
    vi.mocked(classifyIntent).mockResolvedValue({
      action: "sos.route",
      slots: {},
      confidence: "high",
    });
    vi.mocked(executeAction).mockResolvedValue({
      kind: "clarify",
      message: "目前有多筆進行中的求救，請回覆編號選擇：\n1. 王小明｜台北車站",
      persist: {
        awaitingSlot: "sosSessionId",
        candidates: [{ id: "s1", label: "王小明｜台北車站" }],
      },
    });

    await handleEvents([textEvent("我要過去")]);

    expect(vi.mocked(replyText)).toHaveBeenCalledWith(
      "r1",
      "目前有多筆進行中的求救，請回覆編號選擇：\n1. 王小明｜台北車站",
    );

    const call = vi.mocked(updateLineState).mock.calls.at(-1)!;
    const content = (call[1] as (prev: unknown) => unknown)(null);
    expect(content).toEqual({
      pendingIntent: {
        kind: "collecting_slots",
        action: "sos.route",
        filledSlots: {},
        location: undefined,
        awaitingSlot: "sosSessionId",
        candidates: [{ id: "s1", label: "王小明｜台北車站" }],
        missingSlots: ["sosSessionId"],
      },
      lastSharedLocation: undefined,
    });
  });

  it("falls back to the fixed info reply when classification throws", async () => {
    vi.mocked(classifyIntent).mockRejectedValue(new Error("boom"));

    await handleEvents([textEvent("他現在在哪")]);

    expect(vi.mocked(replyText)).toHaveBeenCalledWith("r1", LINE_MSG.INFO);
  });
});

describe("line.service — location message", () => {
  it("stores the shared location and asks for a domain choice when nothing consumes it", async () => {
    await handleEvents([locationEvent("r2")]);

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

    const call = vi.mocked(updateLineState).mock.calls.at(-1)!;
    const content = (call[1] as (prev: unknown) => unknown)(null) as {
      pendingIntent: { kind: string; location: { lat: number; lng: number } };
    };
    expect(content.pendingIntent.kind).toBe("awaiting_domain_choice");
    expect(content.pendingIntent.location).toMatchObject({
      lat: 25.0478,
      lng: 121.5171,
    });

    expect(vi.mocked(replyText)).toHaveBeenCalledWith(
      "r2",
      "收到您的位置！請問要查這個位置的天氣、找附近無障礙設施，還是規劃前往路線呢？",
    );
  });

  it("resumes a pending location-hungry action when a location arrives", async () => {
    vi.mocked(getLineState).mockResolvedValue({
      version: 1,
      updatedAt: "2026-07-21T00:00:00.000Z",
      pendingIntent: {
        kind: "collecting_slots",
        action: "route.plan",
        filledSlots: { destination: "台北車站" },
        awaitingSlot: "location",
        missingSlots: ["location"],
      },
    });
    vi.mocked(getActionSpec).mockReturnValue(
      makeSpec({
        requiredSlots: (ctx) => (ctx.location ? [] : ["location"]),
        needsUserLocation: true,
        allowList: ["planAccessibleRoute"],
      }),
    );
    vi.mocked(executeAction).mockResolvedValue({
      kind: "speech",
      speech: "路線已規劃完成。",
      toolResults: [],
    });

    await handleEvents([locationEvent("r2")]);

    expect(vi.mocked(executeAction)).toHaveBeenCalled();
    expect(vi.mocked(replyAgentResult)).toHaveBeenCalledWith(
      "r2",
      "路線已規劃完成。",
      null,
    );
  });
});

describe("line.service — unfollow", () => {
  it("resets all contacts bound to the LINE user back to pending", async () => {
    contactModel.updateMany.mockResolvedValue({ modifiedCount: 2 });

    await handleEvents([
      {
        type: "unfollow",
        source: { type: "user", userId: "U1" },
      } as unknown as LineEvent,
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
      lean: () =>
        Promise.resolve({
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
          lean: () =>
            Promise.resolve({
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
      lean: () =>
        Promise.resolve({
          _id: "68ef6e5b7f7f3a3b78f51291",
          status: "resolved",
        }),
    });

    const result = await getRoutePreview("68ef6e5b7f7f3a3b78f51291");

    expect(result.ok).toBe(false);
    expect(result.httpCode).toBe(ResponseCode.NOT_FOUND);
    expect(vi.mocked(planAccessibleRouteFromRequest)).not.toHaveBeenCalled();
  });

  it("returns 400 when no bound contact has shared a location", async () => {
    sosSessionModel.findById.mockReturnValue({
      lean: () =>
        Promise.resolve({
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
      lean: () =>
        Promise.resolve({
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
          lean: () =>
            Promise.resolve({
              lastLineLat: 25.03,
              lastLineLng: 121.56,
            }),
        }),
      }),
    });
    userModel.findById.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve({ name: "王小明" }) }),
    });

    const result = await getRoutePreview(
      sessionId,
      "drive",
      "wheelchair",
      "2026-07-09T16:00:00+08:00",
    );

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
