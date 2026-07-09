import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../adapters/line.adapter", () => ({
  replyText: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../ai/ai-chat.service", () => ({
  runToolLoop: vi.fn().mockResolvedValue({ text: "agent reply" }),
  toGeminiHistory: vi.fn(() => ({ systemInstruction: "sys", contents: [] })),
}));

vi.mock("../../config/ai", () => ({
  model: "test-model",
}));

vi.mock("../../config/ai/line-family-prompt", () => ({
  LINE_FAMILY_SYSTEM_PROMPT: "family prompt",
}));

vi.mock("../../model/emergency-contact.model", () => ({
  default: {
    updateMany: vi.fn(),
  },
}));

import { handleEvents } from "./line.service";
import { replyText } from "../../adapters/line.adapter";
import { runToolLoop } from "../ai/ai-chat.service";
import EmergencyContact from "../../model/emergency-contact.model";
import { LINE_MSG } from "../../constants/messages";
import type { LineEvent } from "./line.types";

const contactModel = EmergencyContact as unknown as {
  updateMany: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(replyText).mockResolvedValue(undefined);
  vi.mocked(runToolLoop).mockResolvedValue({ text: "agent reply" });
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
    expect(vi.mocked(replyText)).toHaveBeenCalledWith("r1", "agent reply");
  });

  it("falls back to the fixed info reply when the agent fails", async () => {
    vi.mocked(runToolLoop).mockRejectedValue(new Error("boom"));

    await handleEvents([textEvent("他現在在哪")]);

    expect(vi.mocked(replyText)).toHaveBeenCalledWith("r1", LINE_MSG.INFO);
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
