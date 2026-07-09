import { describe, it, expect, vi, beforeEach } from "vitest";

const mockReplyMessage = vi.fn();

vi.mock("@line/bot-sdk", () => ({
  messagingApi: {
    MessagingApiClient: vi.fn(function MessagingApiClient() {
      return {
        replyMessage: mockReplyMessage,
        multicast: vi.fn(),
      };
    }),
  },
}));

import { replyAgentResult } from "./line.adapter";

beforeEach(() => {
  vi.clearAllMocks();
  mockReplyMessage.mockResolvedValue(undefined);
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
