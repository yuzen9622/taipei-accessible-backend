import type OpenAI from "openai";
import { openai } from "../../config/ai";
import { openAiChatTools, memoryTools } from "../../config/ai/tool";
import { executeLocalTool } from "./agent-tools";
import type { OAIMessage } from "./ai.types";

export type { OAIMessage };

/**
 * Run the OpenAI tool-calling loop (max 5 rounds) over `messages`, executing
 * local tools and appending their results in place. Leaves `messages` ready
 * for the final completion.
 *
 * @param messages Conversation history, mutated in place with tool turns
 * @param useModel Model name to call
 * @param useTemp Sampling temperature
 * @param userLocation Optional user coordinates passed to tools
 * @param onToolCall Hook invoked when a tool call starts
 * @param onToolResult Hook invoked with a tool's parsed result
 */
function stableCacheKey(name: string, args: Record<string, unknown>): string {
  const sorted = Object.keys(args)
    .sort()
    .reduce<Record<string, unknown>>((o, k) => { o[k] = args[k]; return o; }, {});
  return name + "\0" + JSON.stringify(sorted);
}

function isSuccessResult(json: string): boolean {
  try {
    const parsed = JSON.parse(json);
    if (parsed.error) return false;
    if (parsed.ok === false) return false;
    return true;
  } catch {
    return false;
  }
}

export async function runToolLoop(
  messages: OAIMessage[],
  useModel: string,
  useTemp: number,
  userLocation?: { latitude: number; longitude: number },
  onToolCall?: (name: string, args: Record<string, unknown>) => void,
  onToolResult?: (name: string, result: unknown) => void,
  userId?: string,
): Promise<void> {
  const MAX_ROUNDS = 5;
  const toolCache = new Map<string, string>();
  const tools = userId
    ? [...openAiChatTools, ...memoryTools]
    : openAiChatTools;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const response = await openai.chat.completions.create({
      model: useModel,
      messages,
      tools,
      tool_choice: "auto",
      temperature: useTemp,
      stream: false,
    });

    const choice = response.choices[0];

    if (choice.finish_reason !== "tool_calls" || !choice.message.tool_calls?.length) {
      break;
    }

    messages.push(
      choice.message as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam
    );

    for (const tc of choice.message.tool_calls) {
      if (tc.type !== "function" || !("function" in tc)) continue;
      const fnCall = tc as OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall;

      let toolArgs: Record<string, unknown> = {};
      try {
        toolArgs = JSON.parse(fnCall.function.arguments);
      } catch {
      }

      onToolCall?.(fnCall.function.name, toolArgs);

      const cacheKey = stableCacheKey(fnCall.function.name, toolArgs);
      let resultStr: string;
      if (toolCache.has(cacheKey)) {
        resultStr = toolCache.get(cacheKey)!;
      } else {
        resultStr = await executeLocalTool(fnCall.function.name, toolArgs, userLocation, userId);
        if (isSuccessResult(resultStr)) {
          toolCache.set(cacheKey, resultStr);
        }
      }

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
