import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../adapters/line.adapter", () => ({
  replyAgentResult: vi.fn().mockResolvedValue(undefined),
  replyText: vi.fn().mockResolvedValue(undefined),
  replyMessages: vi.fn().mockResolvedValue(undefined),
  buildClaimedControlsMessage: vi.fn((sessionId: string) => ({
    type: "text",
    text: "controls",
    _sid: sessionId,
  })),
}));

vi.mock("./line-agent.service", () => ({
  runLineAgent: vi.fn(),
}));

vi.mock("./line-memory", () => ({
  getLineChatHistory: vi.fn(),
  appendLineChatTurn: vi.fn(),
}));

vi.mock("../sos/sos.service", () => ({
  acknowledgeSession: vi.fn(),
  claimSession: vi.fn(),
  updateHandlingStatus: vi.fn(),
  resolveSession: vi.fn(),
}));

vi.mock("../../config/redis", () => ({
  redisSetNx: vi.fn(),
}));

vi.mock("../../model/emergency-contact.model", () => ({
  default: {
    find: vi.fn(),
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
    find: vi.fn(),
    findById: vi.fn(),
  },
}));

vi.mock("../accessible-route/accessible-route.service", () => ({
  planAccessibleRouteFromRequest: vi.fn(),
}));

import { getRoutePreview, handleEvents } from "./line.service";
import {
  buildClaimedControlsMessage,
  replyAgentResult,
  replyMessages,
  replyText,
} from "../../adapters/line.adapter";
import { runLineAgent } from "./line-agent.service";
import { appendLineChatTurn, getLineChatHistory } from "./line-memory";
import {
  acknowledgeSession,
  claimSession,
  resolveSession,
  updateHandlingStatus,
} from "../sos/sos.service";
import { redisSetNx } from "../../config/redis";
import EmergencyContact from "../../model/emergency-contact.model";
import SosSession from "../../model/sos-session.model";
import User from "../../model/user.model";
import { planAccessibleRouteFromRequest } from "../accessible-route/accessible-route.service";
import { LINE_MSG } from "../../constants/messages";
import { ResponseCode } from "../../types/code";
import type { LineEvent } from "./line.types";

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

beforeEach(() => {
  vi.resetAllMocks();
  delete process.env.PUBLIC_LIFF_ROUTE_BASE_URL;
  vi.mocked(replyAgentResult).mockResolvedValue(undefined);
  vi.mocked(replyText).mockResolvedValue(undefined);
  vi.mocked(replyMessages).mockResolvedValue(undefined);
  vi.mocked(buildClaimedControlsMessage).mockReturnValue({
    type: "text",
    text: "controls",
  } as any);
  vi.mocked(getLineChatHistory).mockResolvedValue([]);
  vi.mocked(appendLineChatTurn).mockResolvedValue(undefined);
  vi.mocked(runLineAgent).mockResolvedValue({ text: "ok", toolResults: [] });
  vi.mocked(redisSetNx).mockResolvedValue(true);
  vi.mocked(acknowledgeSession).mockResolvedValue({
    ok: true,
    httpCode: 200,
    message: "已確認收到通知",
  });
  vi.mocked(claimSession).mockResolvedValue({
    ok: true,
    httpCode: 200,
    message: "你已承接此事件",
  });
  vi.mocked(updateHandlingStatus).mockResolvedValue({
    ok: true,
    httpCode: 200,
    message: "已更新處理狀態",
  });
  vi.mocked(resolveSession).mockResolvedValue({
    ok: true,
    httpCode: 200,
    message: "已解除求救",
  });
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

function textEvent(text: string, webhookEventId?: string): LineEvent {
  return {
    type: "message",
    replyToken: "r1",
    message: { type: "text", text },
    source: { type: "user", userId: "U1" },
    ...(webhookEventId ? { webhookEventId } : {}),
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

function postbackEvent(data: string): LineEvent {
  return {
    type: "postback",
    replyToken: "rp",
    source: { type: "user", userId: "U1" },
    postback: { data },
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

describe("line.service — text message (agent loop)", () => {
  it("runs the agent, replies the speech, and persists the turn", async () => {
    vi.mocked(runLineAgent).mockResolvedValue({
      text: "你好呀",
      toolResults: [],
    });

    await handleEvents([textEvent("你好嗎")]);

    expect(vi.mocked(runLineAgent)).toHaveBeenCalledWith({
      lineUserId: "U1",
      messages: [{ role: "user", content: "你好嗎" }],
    });
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

  it("prepends prior chat history to the agent messages", async () => {
    vi.mocked(getLineChatHistory).mockResolvedValue([
      { role: "user", content: "先前問題" },
      { role: "assistant", content: "先前回答" },
    ]);

    await handleEvents([textEvent("接續問題")]);

    expect(vi.mocked(runLineAgent)).toHaveBeenCalledWith({
      lineUserId: "U1",
      messages: [
        { role: "user", content: "先前問題" },
        { role: "assistant", content: "先前回答" },
        { role: "user", content: "接續問題" },
      ],
    });
  });

  it("unwraps a JSON speech envelope from the agent text", async () => {
    vi.mocked(runLineAgent).mockResolvedValue({
      text: JSON.stringify({ speech: "台北目前多雲。" }),
      toolResults: [],
    });

    await handleEvents([textEvent("台北天氣")]);

    expect(vi.mocked(replyAgentResult)).toHaveBeenCalledWith(
      "r1",
      "台北目前多雲。",
      null,
    );
  });

  it("surfaces a route card built from a plan tool result", async () => {
    process.env.PUBLIC_LIFF_ROUTE_BASE_URL = "https://liff.example.com/route";
    vi.mocked(runLineAgent).mockResolvedValue({
      text: "我幫你找到可前往的路線。",
      toolResults: [
        {
          name: "planAccessibleRoute",
          args: {},
          result: {
            ok: true,
            sessionId: "s1",
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
          { label: "無障礙路線", time: "約 12 分鐘", detail: "步行 → 公車 307" },
        ],
        liffUrl: "https://liff.example.com/route?sessionId=s1",
      },
    );
  });

  it("falls back to the fixed info reply when the agent throws", async () => {
    vi.mocked(runLineAgent).mockRejectedValue(new Error("boom"));

    await handleEvents([textEvent("他現在在哪")]);

    expect(vi.mocked(replyText)).toHaveBeenCalledWith("r1", LINE_MSG.INFO);
  });
});

describe("line.service — postback (deterministic SOS controls)", () => {
  it("ack delegates to acknowledgeSession and surfaces the message", async () => {
    await handleEvents([postbackEvent("action=ack&sid=s1")]);

    expect(vi.mocked(acknowledgeSession)).toHaveBeenCalledWith({
      sessionId: "s1",
      lineUserId: "U1",
    });
    expect(vi.mocked(replyText)).toHaveBeenCalledWith("rp", "已確認收到通知");
  });

  it("claim success replies the message plus the claim-controls message", async () => {
    await handleEvents([postbackEvent("action=claim&sid=s1")]);

    expect(vi.mocked(claimSession)).toHaveBeenCalledWith({
      sessionId: "s1",
      lineUserId: "U1",
    });
    expect(vi.mocked(buildClaimedControlsMessage)).toHaveBeenCalledWith("s1");
    expect(vi.mocked(replyMessages)).toHaveBeenCalledWith("rp", [
      { type: "text", text: "你已承接此事件" },
      { type: "text", text: "controls" },
    ]);
  });

  it("claim failure surfaces the service message via replyText", async () => {
    vi.mocked(claimSession).mockResolvedValue({
      ok: false,
      httpCode: 200,
      message: "此事件已由他人承接",
    } as any);

    await handleEvents([postbackEvent("action=claim&sid=s1")]);

    expect(vi.mocked(replyMessages)).not.toHaveBeenCalled();
    expect(vi.mocked(replyText)).toHaveBeenCalledWith("rp", "此事件已由他人承接");
  });

  it("status delegates handlingStatus to updateHandlingStatus", async () => {
    await handleEvents([postbackEvent("action=status&sid=s1&v=en_route")]);

    expect(vi.mocked(updateHandlingStatus)).toHaveBeenCalledWith({
      sessionId: "s1",
      lineUserId: "U1",
      handlingStatus: "en_route",
    });
    expect(vi.mocked(replyText)).toHaveBeenCalledWith("rp", "已更新處理狀態");
  });

  it("rejects an invalid status value", async () => {
    await handleEvents([postbackEvent("action=status&sid=s1&v=bogus")]);

    expect(vi.mocked(updateHandlingStatus)).not.toHaveBeenCalled();
    expect(vi.mocked(replyText)).toHaveBeenCalledWith("rp", LINE_MSG.INFO);
  });

  it("resolve delegates to resolveSession", async () => {
    await handleEvents([postbackEvent("action=resolve&sid=s1")]);

    expect(vi.mocked(resolveSession)).toHaveBeenCalledWith({
      sessionId: "s1",
      lineUserId: "U1",
    });
    expect(vi.mocked(replyText)).toHaveBeenCalledWith("rp", "已解除求救");
  });

  it("replies the info message when sid or user id is missing", async () => {
    await handleEvents([postbackEvent("action=ack")]);

    expect(vi.mocked(acknowledgeSession)).not.toHaveBeenCalled();
    expect(vi.mocked(replyText)).toHaveBeenCalledWith("rp", LINE_MSG.INFO);
  });
});

describe("line.service — webhook dedup", () => {
  it("skips an event whose webhookEventId was already processed", async () => {
    vi.mocked(redisSetNx).mockResolvedValue(false);

    await handleEvents([textEvent("你好", "evt-1")]);

    expect(vi.mocked(redisSetNx)).toHaveBeenCalledWith(
      "line:evt:evt-1",
      3600,
    );
    expect(vi.mocked(runLineAgent)).not.toHaveBeenCalled();
  });

  it("processes an event when the webhookEventId is fresh", async () => {
    vi.mocked(redisSetNx).mockResolvedValue(true);

    await handleEvents([textEvent("你好", "evt-2")]);

    expect(vi.mocked(runLineAgent)).toHaveBeenCalled();
  });
});

describe("line.service — location message", () => {
  it("caches the shared location on bound contacts and acknowledges", async () => {
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
    expect(vi.mocked(replyText)).toHaveBeenCalledWith(
      "r2",
      "收到您的位置！請問要查這個位置的天氣、找附近無障礙設施，還是規劃前往路線呢？",
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
