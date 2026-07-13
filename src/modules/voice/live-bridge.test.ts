import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

const { connect } = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("../../config/ai", () => ({ googleGenAi: { live: { connect } } }));
vi.mock("../ai/ai-chat.service", () => ({ buildGeminiTools: vi.fn(() => []) }));
vi.mock("../ai/agent-tools", () => ({ executeLocalTool: vi.fn() }));

import { createLiveBridge } from "./live-bridge";

describe("createLiveBridge transcript forwarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes both user and model transcripts before sending them to the client", async () => {
    let onmessage: ((message: unknown) => void) | undefined;
    connect.mockImplementation(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return { sendRealtimeInput: vi.fn(), sendToolResponse: vi.fn(), close: vi.fn() };
    });
    const send = vi.fn();
    const ws = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send,
      close: vi.fn(),
    } as unknown as WebSocket;

    await createLiveBridge({ ws, userId: "voice-user" });
    onmessage?.({
      serverContent: {
        inputTranscription: { text: "带我去火车站" },
        outputTranscription: { text: "好的，我帮您查询" },
      },
    });

    expect(send).toHaveBeenCalledWith(JSON.stringify({
      type: "transcript",
      role: "user",
      text: "帶我去火車站",
    }));
    expect(send).toHaveBeenCalledWith(JSON.stringify({
      type: "transcript",
      role: "model",
      text: "好的，我幫您查詢",
    }));
  });
});
