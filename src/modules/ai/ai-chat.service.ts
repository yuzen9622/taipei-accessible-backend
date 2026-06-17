import OpenAI from "openai";
import { openai } from "../../config/ai";
import { openAiChatTools } from "../../config/ai/tool";
import { executeLocalTool } from "./agent-tools";

export type OAIMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

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
export async function runToolLoop(
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
