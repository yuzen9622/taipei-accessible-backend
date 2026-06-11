import type { Request, Response } from "express";
import OpenAI from "openai";
import { openai, model as defaultModel } from "../../config/ai";
import { openAiChatTools } from "../../config/ai/tool";
import { executeLocalTool } from "./agent-tools";

// ─── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `你是「無障礙交通導航 AI 助理」，專為輪椅使用者、年長者及視障人士設計。
你的職責是協助使用者查詢無障礙設施、規劃無障礙路線、查詢公車即時到站資訊，以及提供出行前的空氣品質建議。

【工具使用優先順序與觸發規則】
1. findA11yPlaces（無障礙設施查詢）
   - 觸發條件：使用者提到「無障礙、電梯、坡道、廁所、輪椅通道」等關鍵字，且意圖為查找設施
   - 範例：「台北車站附近的無障礙廁所」→ 使用此工具

2. planAccessibleRoute（無障礙路線規劃）
   - 觸發條件：使用者說「從 A 到 B」、「A 去 B 怎麼走」、「怎麼去」、「路線規劃」、「導航」
   - 此工具會呼叫真實路線計算引擎，回傳完整的公車/捷運/步行組合方案
   - 範例：「我坐輪椅，從台北車站到台北101怎麼去」→ 使用此工具（mode: wheelchair）

3. getBusArrivalEstimate（公車即時到站）
   - 觸發條件：詢問特定公車「還有多久」、「到站時間」
   - 需要路線名稱、出發站、抵達站

4. getBusPosition（公車即時位置）
   - 觸發條件：追蹤特定車牌號碼的公車目前位置

5. getAirQuality（空氣品質查詢）
   - 觸發條件：詢問「空氣品質」、「PM2.5」、「今天適合出門嗎」

6. getA11yFacilityDetails（設施詳細資訊）
   - 觸發條件：需要查詢特定 OSM 設施的完整標籤資料

7. findGooglePlaces（一般地點搜尋）
   - 觸發條件：一般地點、商家、景點查詢，且不涉及無障礙設施

【行為規則】
- 直接呼叫工具，不要預先告知「我要查詢了」或「請稍等」
- 收到工具結果後，以自然親切的語言回覆使用者
- 使用「您」稱呼使用者
- 使用者使用何種語言，就以該語言回覆
- 不要將 JSON 原始資料直接輸出給使用者，請整理成自然語言`;

// ─── SSE helpers ──────────────────────────────────────────────────────────────

function sendSse(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ─── Tool execution loop (shared by streaming and non-streaming paths) ────────

type OAIMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

async function runToolLoop(
  messages: OAIMessage[],
  useModel: string,
  useTemp: number,
  userLocation?: { latitude: number; longitude: number },
  onToolCall?: (name: string, args: Record<string, unknown>) => void,
  onToolResult?: (name: string, result: unknown) => void
): Promise<void> {
  const MAX_ROUNDS = 5;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const response = await openai.chat.completions.create({
      model: useModel,
      messages,
      tools: openAiChatTools,
      tool_choice: "auto",
      temperature: useTemp,
      stream: false,
    });

    const choice = response.choices[0];

    if (choice.finish_reason !== "tool_calls" || !choice.message.tool_calls?.length) {
      break;
    }

    // Add assistant's tool-call turn to history
    messages.push(
      choice.message as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam
    );

    for (const tc of choice.message.tool_calls) {
      // Only process standard function tool calls (not custom tool calls)
      if (tc.type !== "function" || !("function" in tc)) continue;
      const fnCall = tc as OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall;

      let toolArgs: Record<string, unknown> = {};
      try {
        toolArgs = JSON.parse(fnCall.function.arguments);
      } catch {
        // keep empty object
      }

      onToolCall?.(fnCall.function.name, toolArgs);

      const resultStr = await executeLocalTool(fnCall.function.name, toolArgs, userLocation);

      let parsedResult: unknown;
      try {
        parsedResult = JSON.parse(resultStr);
      } catch {
        parsedResult = { result: resultStr };
      }

      onToolResult?.(tc.function.name, parsedResult);

      messages.push({
        role: "tool",
        tool_call_id: fnCall.id,
        content: resultStr,
      } as OpenAI.Chat.Completions.ChatCompletionToolMessageParam);
    }
  }
}

// ─── Controller ───────────────────────────────────────────────────────────────

export async function aiChat(req: Request, res: Response): Promise<void> {
  const {
    model: requestModel,
    messages: rawMessages,
    stream,
    temperature,
    userLocation,
  } = req.body as {
    model?: string;
    messages: OAIMessage[];
    stream?: boolean;
    temperature?: number;
    userLocation?: { latitude: number; longitude: number };
  };

  const useModel = requestModel || defaultModel;
  const useTemp = temperature ?? 0.2;

  // Build conversation: prepend system prompt when not already supplied
  const messages: OAIMessage[] = [];
  if (!rawMessages.length || rawMessages[0].role !== "system") {
    let systemPrompt = SYSTEM_PROMPT;
    if (userLocation) {
      systemPrompt += `\n\n【使用者目前位置】緯度 ${userLocation.latitude}，經度 ${userLocation.longitude}`;
    }
    messages.push({ role: "system", content: systemPrompt });
  }
  messages.push(...rawMessages);

  // ── Streaming path ──────────────────────────────────────────────────────────
  if (stream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    try {
      // Phase 1: tool-calling loop (non-streaming, emits tool_call / tool_result events)
      await runToolLoop(
        messages,
        useModel,
        useTemp,
        userLocation,
        (name, args) => sendSse(res, "tool_call", { name, arguments: args }),
        (name, result) => sendSse(res, "tool_result", { name, result })
      );

      // Phase 2: final answer as SSE text chunks
      const finalStream = await openai.chat.completions.create({
        model: useModel,
        messages,
        temperature: useTemp,
        stream: true,
      });

      for await (const chunk of finalStream) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }

      res.write("data: [DONE]\n\n");
      res.end();
    } catch (error: any) {
      console.error("[ai/chat stream]", error);
      sendSse(res, "error", {
        code: 500,
        message: error?.message ?? "Internal server error",
      });
      res.write("data: [DONE]\n\n");
      res.end();
    }
    return;
  }

  // ── Non-streaming path ──────────────────────────────────────────────────────
  try {
    await runToolLoop(messages, useModel, useTemp, userLocation);

    const response = await openai.chat.completions.create({
      model: useModel,
      messages,
      temperature: useTemp,
      stream: false,
    });

    res.json({
      ok: true,
      status: "success",
      code: 200,
      message: "OK",
      data: {
        id: response.id,
        object: response.object,
        created: response.created,
        model: response.model,
        choices: response.choices,
        usage: response.usage,
      },
    });
  } catch (error: any) {
    console.error("[ai/chat]", error);
    res.status(500).json({
      ok: false,
      status: "error",
      code: 500,
      message: error?.message ?? "Internal server error",
    });
  }
}
