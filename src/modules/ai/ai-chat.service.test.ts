import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/ai", () => ({
  googleGenAi: {
    models: { generateContent: vi.fn() },
  },
}));
vi.mock("../../config/ai/tool", () => ({
  openAiChatTools: [],
  memoryTools: [],
}));
vi.mock("./agent-tools", () => ({
  executeLocalTool: vi.fn(),
}));

import { googleGenAi } from "../../config/ai";
import { executeLocalTool } from "./agent-tools";
import { runToolLoop } from "./ai-chat.service";
import type { Content } from "@google/genai";

const mockCreate = googleGenAi.models.generateContent as unknown as ReturnType<typeof vi.fn>;
const mockExec = executeLocalTool as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

function functionCallResponse(calls: Array<{ name: string; args: Record<string, unknown> }>) {
  return {
    functionCalls: calls.map((c) => ({ name: c.name, args: c.args })),
    candidates: [
      {
        content: {
          role: "model",
          parts: calls.map((c) => ({ functionCall: { name: c.name, args: c.args } })),
        },
      },
    ],
  };
}

function stopResponse() {
  return {
    functionCalls: undefined,
    text: "done",
    candidates: [{ content: { role: "model", parts: [{ text: "done" }] } }],
  };
}

function functionResponseParts(contents: Content[]) {
  return contents
    .flatMap((c) => c.parts ?? [])
    .filter((p) => "functionResponse" in p && p.functionResponse);
}

describe("runToolLoop dedup", () => {
  it("沒有工具呼叫但模型有文字時回傳文字", async () => {
    mockCreate.mockResolvedValueOnce(stopResponse());

    const contents: Content[] = [{ role: "user", parts: [{ text: "hello" }] }];
    const result = await runToolLoop(contents, undefined, "test-model");

    expect(result.text).toBe("done");
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("相同 (name, args) 且成功 → 第二次不執行 executeLocalTool", async () => {
    const args = { routeName: "307", city: "台北" };
    mockCreate
      .mockResolvedValueOnce(functionCallResponse([{ name: "trackBuses", args }]))
      .mockResolvedValueOnce(functionCallResponse([{ name: "trackBuses", args }]))
      .mockResolvedValueOnce(stopResponse());

    mockExec.mockResolvedValue(JSON.stringify({ ok: true, buses: [] }));

    const contents: Content[] = [{ role: "user", parts: [{ text: "test" }] }];
    await runToolLoop(contents, undefined, "test-model");

    expect(mockExec).toHaveBeenCalledTimes(1);
    const fnResponses = functionResponseParts(contents);
    expect(fnResponses).toHaveLength(2);
    expect((fnResponses[0] as any).functionResponse.response).toEqual(
      (fnResponses[1] as any).functionResponse.response,
    );
  });

  it("相同 (name, args) 但失敗 → 第二次重新執行", async () => {
    const args = { query: "火星" };
    mockCreate
      .mockResolvedValueOnce(functionCallResponse([{ name: "findA11yPlaces", args }]))
      .mockResolvedValueOnce(functionCallResponse([{ name: "findA11yPlaces", args }]))
      .mockResolvedValueOnce(stopResponse());

    mockExec
      .mockResolvedValueOnce(JSON.stringify({ ok: false, error: "找不到" }))
      .mockResolvedValueOnce(JSON.stringify({ ok: true, places: [] }));

    const contents: Content[] = [{ role: "user", parts: [{ text: "test" }] }];
    await runToolLoop(contents, undefined, "test-model");

    expect(mockExec).toHaveBeenCalledTimes(2);
  });

  it("不同 args → 各自執行", async () => {
    mockCreate
      .mockResolvedValueOnce(
        functionCallResponse([
          { name: "getBusArrival", args: { routeName: "307", stopName: "台北車站" } },
          { name: "getBusArrival", args: { routeName: "307", stopName: "忠孝復興" } },
        ]),
      )
      .mockResolvedValueOnce(stopResponse());

    mockExec.mockResolvedValue(JSON.stringify({ ok: true, arrival: "3min" }));

    const contents: Content[] = [{ role: "user", parts: [{ text: "test" }] }];
    await runToolLoop(contents, undefined, "test-model");

    expect(mockExec).toHaveBeenCalledTimes(2);
  });

  it("args 順序不同但值相同 → 命中 cache", async () => {
    mockCreate
      .mockResolvedValueOnce(
        functionCallResponse([{ name: "trackBuses", args: { routeName: "307", city: "台北" } }]),
      )
      .mockResolvedValueOnce(
        functionCallResponse([{ name: "trackBuses", args: { city: "台北", routeName: "307" } }]),
      )
      .mockResolvedValueOnce(stopResponse());

    mockExec.mockResolvedValue(JSON.stringify({ ok: true, buses: [] }));

    const contents: Content[] = [{ role: "user", parts: [{ text: "test" }] }];
    await runToolLoop(contents, undefined, "test-model");

    expect(mockExec).toHaveBeenCalledTimes(1);
  });

  it("含 error 欄位的結果不被快取", async () => {
    const args = { latitude: 0, longitude: 0 };
    mockCreate
      .mockResolvedValueOnce(functionCallResponse([{ name: "getAirQuality", args }]))
      .mockResolvedValueOnce(functionCallResponse([{ name: "getAirQuality", args }]))
      .mockResolvedValueOnce(stopResponse());

    mockExec
      .mockResolvedValueOnce(JSON.stringify({ error: "查詢失敗" }))
      .mockResolvedValueOnce(JSON.stringify({ ok: true, pm25: 12 }));

    const contents: Content[] = [{ role: "user", parts: [{ text: "test" }] }];
    await runToolLoop(contents, undefined, "test-model");

    expect(mockExec).toHaveBeenCalledTimes(2);
  });
});
