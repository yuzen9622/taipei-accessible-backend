import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/ai", () => ({
  openai: {
    chat: {
      completions: { create: vi.fn() },
    },
  },
}));
vi.mock("../../config/ai/tool", () => ({
  openAiChatTools: [],
}));
vi.mock("./agent-tools", () => ({
  executeLocalTool: vi.fn(),
}));

import { openai } from "../../config/ai";
import { executeLocalTool } from "./agent-tools";
import { runToolLoop, type OAIMessage } from "./ai-chat.service";

const mockCreate = openai.chat.completions.create as unknown as ReturnType<typeof vi.fn>;
const mockExec = executeLocalTool as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

function toolCallResponse(calls: Array<{ id: string; name: string; args: Record<string, unknown> }>) {
  return {
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: calls.map(c => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      },
    }],
  };
}

function stopResponse() {
  return { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }] };
}

describe("runToolLoop dedup", () => {
  it("相同 (name, args) 且成功 → 第二次不執行 executeLocalTool", async () => {
    const args = { routeName: "307", city: "台北" };
    mockCreate
      .mockResolvedValueOnce(toolCallResponse([
        { id: "c1", name: "trackBuses", args },
      ]))
      .mockResolvedValueOnce(toolCallResponse([
        { id: "c2", name: "trackBuses", args },
      ]))
      .mockResolvedValueOnce(stopResponse());

    mockExec.mockResolvedValue(JSON.stringify({ ok: true, buses: [] }));

    const messages: OAIMessage[] = [{ role: "user", content: "test" }];
    await runToolLoop(messages, "test-model", 0.2);

    expect(mockExec).toHaveBeenCalledTimes(1);
    const toolMessages = messages.filter(m => m.role === "tool");
    expect(toolMessages).toHaveLength(2);
    expect((toolMessages[0] as any).content).toBe((toolMessages[1] as any).content);
  });

  it("相同 (name, args) 但失敗 → 第二次重新執行", async () => {
    const args = { query: "火星" };
    mockCreate
      .mockResolvedValueOnce(toolCallResponse([
        { id: "c1", name: "findA11yPlaces", args },
      ]))
      .mockResolvedValueOnce(toolCallResponse([
        { id: "c2", name: "findA11yPlaces", args },
      ]))
      .mockResolvedValueOnce(stopResponse());

    mockExec
      .mockResolvedValueOnce(JSON.stringify({ ok: false, error: "找不到" }))
      .mockResolvedValueOnce(JSON.stringify({ ok: true, places: [] }));

    const messages: OAIMessage[] = [{ role: "user", content: "test" }];
    await runToolLoop(messages, "test-model", 0.2);

    expect(mockExec).toHaveBeenCalledTimes(2);
  });

  it("不同 args → 各自執行", async () => {
    mockCreate
      .mockResolvedValueOnce(toolCallResponse([
        { id: "c1", name: "getBusArrival", args: { routeName: "307", stopName: "台北車站" } },
        { id: "c2", name: "getBusArrival", args: { routeName: "307", stopName: "忠孝復興" } },
      ]))
      .mockResolvedValueOnce(stopResponse());

    mockExec.mockResolvedValue(JSON.stringify({ ok: true, arrival: "3min" }));

    const messages: OAIMessage[] = [{ role: "user", content: "test" }];
    await runToolLoop(messages, "test-model", 0.2);

    expect(mockExec).toHaveBeenCalledTimes(2);
  });

  it("args 順序不同但值相同 → 命中 cache", async () => {
    mockCreate
      .mockResolvedValueOnce(toolCallResponse([
        { id: "c1", name: "trackBuses", args: { routeName: "307", city: "台北" } },
      ]))
      .mockResolvedValueOnce(toolCallResponse([
        { id: "c2", name: "trackBuses", args: { city: "台北", routeName: "307" } },
      ]))
      .mockResolvedValueOnce(stopResponse());

    mockExec.mockResolvedValue(JSON.stringify({ ok: true, buses: [] }));

    const messages: OAIMessage[] = [{ role: "user", content: "test" }];
    await runToolLoop(messages, "test-model", 0.2);

    expect(mockExec).toHaveBeenCalledTimes(1);
  });

  it("含 error 欄位的結果不被快取", async () => {
    const args = { latitude: 0, longitude: 0 };
    mockCreate
      .mockResolvedValueOnce(toolCallResponse([
        { id: "c1", name: "getAirQuality", args },
      ]))
      .mockResolvedValueOnce(toolCallResponse([
        { id: "c2", name: "getAirQuality", args },
      ]))
      .mockResolvedValueOnce(stopResponse());

    mockExec
      .mockResolvedValueOnce(JSON.stringify({ error: "查詢失敗" }))
      .mockResolvedValueOnce(JSON.stringify({ ok: true, pm25: 12 }));

    const messages: OAIMessage[] = [{ role: "user", content: "test" }];
    await runToolLoop(messages, "test-model", 0.2);

    expect(mockExec).toHaveBeenCalledTimes(2);
  });
});
