import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

const { connect } = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("../../config/ai", () => ({ googleGenAi: { live: { connect } } }));
vi.mock("../agent/tool-catalog", () => ({ buildGeminiTools: vi.fn(() => []) }));
vi.mock("../ai/agent-tools", () => ({ executeLocalTool: vi.fn() }));

import { createLiveBridge } from "./live-bridge";
import { executeLocalTool } from "../ai/agent-tools";

function makeWs(): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as WebSocket;
}

function makeSession() {
  return { sendRealtimeInput: vi.fn(), sendToolResponse: vi.fn(), close: vi.fn() };
}

describe("createLiveBridge transcript forwarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GEMINI_LIVE_TEMPERATURE;
    delete process.env.GEMINI_LIVE_LANGUAGE_CODE;
  });

  it("normalizes both user and model transcripts before sending them to the client", async () => {
    let onmessage: ((message: unknown) => void) | undefined;
    connect.mockImplementation(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return makeSession();
    });
    const ws = makeWs();

    await createLiveBridge({ ws, userId: "voice-user" });
    onmessage?.({
      serverContent: {
        inputTranscription: { text: "带我去火车站" },
        outputTranscription: { text: "好的，我帮您查询" },
      },
    });

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({
      type: "transcript",
      role: "user",
      text: "帶我去火車站",
    }));
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({
      type: "transcript",
      role: "model",
      text: "好的，我幫您查詢",
    }));
  });
});

describe("createLiveBridge Live config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GEMINI_LIVE_TEMPERATURE;
    delete process.env.GEMINI_LIVE_LANGUAGE_CODE;
    connect.mockResolvedValue(makeSession());
  });

  it("defaults temperature to 0 (aligned with the text agent)", async () => {
    await createLiveBridge({ ws: makeWs(), userId: "u" });
    expect(connect.mock.calls[0][0].config.temperature).toBe(0);
  });

  it("uses a valid GEMINI_LIVE_TEMPERATURE and falls back for an invalid one", async () => {
    process.env.GEMINI_LIVE_TEMPERATURE = "0.4";
    await createLiveBridge({ ws: makeWs(), userId: "u" });
    expect(connect.mock.calls[0][0].config.temperature).toBe(0.4);

    connect.mockClear();
    process.env.GEMINI_LIVE_TEMPERATURE = "abc";
    await createLiveBridge({ ws: makeWs(), userId: "u" });
    expect(connect.mock.calls[0][0].config.temperature).toBe(0);
  });

  it("adds speechConfig only for a validly-formatted language code", async () => {
    process.env.GEMINI_LIVE_LANGUAGE_CODE = "cmn-TW";
    await createLiveBridge({ ws: makeWs(), userId: "u" });
    expect(connect.mock.calls[0][0].config.speechConfig).toEqual({ languageCode: "cmn-TW" });
  });

  it("omits speechConfig when the language code is unset or malformed", async () => {
    await createLiveBridge({ ws: makeWs(), userId: "u" });
    expect(connect.mock.calls[0][0].config.speechConfig).toBeUndefined();

    connect.mockClear();
    process.env.GEMINI_LIVE_LANGUAGE_CODE = "zh_TW";
    await createLiveBridge({ ws: makeWs(), userId: "u" });
    expect(connect.mock.calls[0][0].config.speechConfig).toBeUndefined();
  });
});

describe("createLiveBridge consecutive tool calls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GEMINI_LIVE_TEMPERATURE;
    delete process.env.GEMINI_LIVE_LANGUAGE_CODE;
  });

  it("returns each tool response to the same session across consecutive toolCalls without dropping or closing early", async () => {
    let onmessage: ((message: unknown) => Promise<void> | void) | undefined;
    const session = makeSession();
    connect.mockImplementation(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return session;
    });
    vi.mocked(executeLocalTool).mockResolvedValue(JSON.stringify({ ok: true }));

    await createLiveBridge({ ws: makeWs(), userId: "voice-user" });

    onmessage?.({ toolCall: { functionCalls: [{ id: "c1", name: "findGooglePlaces", args: {} }] } });
    onmessage?.({ toolCall: { functionCalls: [{ id: "c2", name: "planAccessibleRoute", args: {} }] } });

    // handleServerMessage is fire-and-forget from onmessage; wait for both
    // executions to finish resolving before asserting (deferred sync point).
    await vi.waitFor(() => expect(session.sendToolResponse).toHaveBeenCalledTimes(2));

    expect(session.sendToolResponse).toHaveBeenNthCalledWith(1, {
      functionResponses: [
        { id: "c1", name: "findGooglePlaces", response: { output: JSON.stringify({ ok: true }) } },
      ],
    });
    expect(session.sendToolResponse).toHaveBeenNthCalledWith(2, {
      functionResponses: [
        { id: "c2", name: "planAccessibleRoute", response: { output: JSON.stringify({ ok: true }) } },
      ],
    });
    expect(session.close).not.toHaveBeenCalled();
  });
});

describe("createLiveBridge tool_result payload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GEMINI_LIVE_TEMPERATURE;
    delete process.env.GEMINI_LIVE_LANGUAGE_CODE;
  });

  /**
   * Finds the last `tool_result` JSON message sent over the WebSocket. `ws.send`
   * also receives binary audio frames, so string args are filtered and parsed
   * first.
   *
   * @param ws The mocked WebSocket whose `send` calls are inspected.
   * @returns The parsed `tool_result` message, or undefined if none was sent.
   */
  function findToolResult(ws: WebSocket): Record<string, unknown> | undefined {
    const calls = (ws.send as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const messages = calls
      .map((c) => c[0])
      .filter((arg): arg is string => typeof arg === "string")
      .map((arg) => JSON.parse(arg) as Record<string, unknown>);
    return messages.filter((m) => m.type === "tool_result").at(-1);
  }

  it("forwards the parsed tool result and the call args on success", async () => {
    let onmessage: ((message: unknown) => Promise<void> | void) | undefined;
    connect.mockImplementation(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return makeSession();
    });
    const places = [{ id: "a11y_123", name: "台北車站無障礙電梯" }];
    vi.mocked(executeLocalTool).mockResolvedValue(JSON.stringify({ places }));
    const ws = makeWs();

    await createLiveBridge({ ws, userId: "voice-user" });
    const args = { latitude: 25.033, longitude: 121.5654, radius: 500 };
    onmessage?.({ toolCall: { functionCalls: [{ id: "c1", name: "findA11yPlaces", args }] } });

    await vi.waitFor(() => expect(findToolResult(ws)).toBeDefined());
    const msg = findToolResult(ws)!;
    expect(msg.name).toBe("findA11yPlaces");
    expect(msg.ok).toBe(true);
    expect(typeof msg.durationMs).toBe("number");
    expect(msg.result).toEqual({ places });
    expect(msg.args).toEqual(args);
  });

  it("wraps a non-JSON tool return in { result } to match the SSE fallback", async () => {
    let onmessage: ((message: unknown) => Promise<void> | void) | undefined;
    connect.mockImplementation(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return makeSession();
    });
    vi.mocked(executeLocalTool).mockResolvedValue("plain string result");
    const ws = makeWs();

    await createLiveBridge({ ws, userId: "voice-user" });
    onmessage?.({ toolCall: { functionCalls: [{ id: "c1", name: "findA11yPlaces", args: {} }] } });

    await vi.waitFor(() => expect(findToolResult(ws)).toBeDefined());
    expect(findToolResult(ws)!.result).toEqual({ result: "plain string result" });
  });

  it("omits result but keeps args when the tool throws", async () => {
    let onmessage: ((message: unknown) => Promise<void> | void) | undefined;
    connect.mockImplementation(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return makeSession();
    });
    vi.mocked(executeLocalTool).mockRejectedValue(new Error("tool blew up"));
    const ws = makeWs();

    await createLiveBridge({ ws, userId: "voice-user" });
    const args = { latitude: 25.033, longitude: 121.5654 };
    onmessage?.({ toolCall: { functionCalls: [{ id: "c1", name: "findA11yPlaces", args }] } });

    await vi.waitFor(() => expect(findToolResult(ws)).toBeDefined());
    const msg = findToolResult(ws)!;
    expect(msg.ok).toBe(false);
    expect("result" in msg).toBe(false);
    expect(msg.args).toEqual(args);
  });
});
