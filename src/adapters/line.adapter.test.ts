import { describe, it, expect, vi, beforeEach } from "vitest";

const mockReplyMessage = vi.fn();
const mockShowLoadingAnimation = vi.fn();

vi.mock("@line/bot-sdk", () => ({
  messagingApi: {
    MessagingApiClient: vi.fn(function MessagingApiClient() {
      return {
        replyMessage: mockReplyMessage,
        multicast: vi.fn(),
        showLoadingAnimation: mockShowLoadingAnimation,
      };
    }),
  },
}));

import { replyAgentResult, showLoadingAnimation } from "./line.adapter";

beforeEach(() => {
  vi.clearAllMocks();
  mockReplyMessage.mockResolvedValue(undefined);
  mockShowLoadingAnimation.mockResolvedValue({});
});

describe("line.adapter — agent replies", () => {
  it("replies with speech text and a route Flex Message", async () => {
    await replyAgentResult("reply-token", "我幫你找到可前往的路線。", {
      origin: "你分享的位置",
      destination: "台北車站",
      options: [{ label: "無障礙路線", time: "約 12 分鐘", detail: "步行 → 公車 307" }],
      liffUrl: "https://liff.example.com/route?sessionId=s1",
    });

    expect(mockReplyMessage).toHaveBeenCalledWith({
      replyToken: "reply-token",
      messages: [
        { type: "text", text: "我幫你找到可前往的路線。" },
        expect.objectContaining({
          type: "flex",
          altText: "路線規劃結果",
          contents: expect.objectContaining({
            type: "bubble",
            footer: expect.objectContaining({
              contents: [
                expect.objectContaining({
                  type: "button",
                  action: expect.objectContaining({
                    type: "uri",
                    label: "查看地圖",
                    uri: "https://liff.example.com/route?sessionId=s1",
                  }),
                }),
              ],
            }),
          }),
        }),
      ],
    });
  });
});

describe("line.adapter — showLoadingAnimation", () => {
  it("requests the maximum 60s loading animation for the chat", async () => {
    await showLoadingAnimation("U1");

    expect(mockShowLoadingAnimation).toHaveBeenCalledWith({
      chatId: "U1",
      loadingSeconds: 60,
    });
  });

  it("swallows an immediately rejecting client call", async () => {
    mockShowLoadingAnimation.mockRejectedValue(new Error("line down"));

    await expect(showLoadingAnimation("U1")).resolves.toBeUndefined();
  });

  it("returns within the timeout bound when the client call never settles", async () => {
    vi.useFakeTimers();
    try {
      mockShowLoadingAnimation.mockReturnValue(new Promise<never>(() => {}));

      const pending = showLoadingAnimation("U1");
      await vi.advanceTimersByTimeAsync(2000);

      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves no pending timer when the client call settles quickly", async () => {
    vi.useFakeTimers();
    try {
      mockShowLoadingAnimation.mockResolvedValue({});

      await showLoadingAnimation("U1");

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
