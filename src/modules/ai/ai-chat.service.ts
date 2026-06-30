import type OpenAI from "openai";
import type { Content, Part, Tool, FunctionDeclaration } from "@google/genai";
import { FunctionCallingConfigMode } from "@google/genai";
import { googleGenAi } from "../../config/ai";
import { openAiChatTools, memoryTools } from "../../config/ai/tool";
import { executeLocalTool } from "./agent-tools";
import type { OAIMessage } from "./ai.types";

export type { OAIMessage };

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

/**
 * Build Gemini function declarations from the existing OpenAI tool specs by
 * passing their JSON Schema straight through (`parametersJsonSchema`), so the
 * tool catalogue stays defined in one place.
 *
 * @param userId When present, memory tools are appended to the catalogue
 * @returns A single-entry Tool list holding every function declaration
 */
export function buildGeminiTools(userId?: string): Tool[] {
  const specs = userId ? [...openAiChatTools, ...memoryTools] : openAiChatTools;
  const functionDeclarations: FunctionDeclaration[] = specs
    .filter(
      (t): t is Extract<OpenAI.Chat.Completions.ChatCompletionTool, { type: "function" }> =>
        t.type === "function",
    )
    .map((t) => ({
      name: t.function.name,
      description: t.function.description,
      parametersJsonSchema: t.function.parameters,
    }));
  return [{ functionDeclarations }];
}

/**
 * Convert an OpenAI-format chat history into the Gemini request shape. System
 * messages collapse into `systemInstruction`; user/assistant/tool turns become
 * `contents`. Assistant `tool_calls` map to `functionCall` parts and `tool`
 * results map to `functionResponse` parts (name resolved via the preceding
 * tool_call id).
 *
 * @param messages OpenAI chat messages (system prompt already prepended)
 * @returns The Gemini `systemInstruction` text and `contents` array
 */
export function toGeminiHistory(
  messages: OAIMessage[],
): { systemInstruction?: string; contents: Content[] } {
  let systemInstruction: string | undefined;
  const contents: Content[] = [];
  const idToName = new Map<string, string>();

  for (const m of messages) {
    if (m.role === "system") {
      const text = typeof m.content === "string" ? m.content : "";
      systemInstruction = systemInstruction ? `${systemInstruction}\n\n${text}` : text;
    } else if (m.role === "user") {
      const text = typeof m.content === "string" ? m.content : "";
      contents.push({ role: "user", parts: [{ text }] });
    } else if (m.role === "assistant") {
      const parts: Part[] = [];
      if (typeof m.content === "string" && m.content) parts.push({ text: m.content });
      const toolCalls = m.tool_calls;
      if (toolCalls?.length) {
        for (const tc of toolCalls) {
          if (tc.type !== "function") continue;
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(tc.function.arguments); } catch { /* keep {} */ }
          idToName.set(tc.id, tc.function.name);
          parts.push({ functionCall: { name: tc.function.name, args } });
        }
      }
      if (parts.length) contents.push({ role: "model", parts });
    } else if (m.role === "tool") {
      const name = idToName.get(m.tool_call_id) ?? "unknown";
      const raw = typeof m.content === "string" ? m.content : "";
      let response: Record<string, unknown>;
      try {
        const parsed = JSON.parse(raw);
        response = parsed && typeof parsed === "object" ? parsed : { result: parsed };
      } catch {
        response = { result: raw };
      }
      contents.push({ role: "user", parts: [{ functionResponse: { name, response } }] });
    }
  }

  return { systemInstruction, contents };
}

/**
 * Run the Gemini tool-calling loop (max 5 rounds) over `contents`, executing
 * local tools and appending the model's function-call turns and our function
 * responses in place. The model's returned content is pushed back verbatim so
 * thought signatures round-trip across rounds. Leaves `contents` ready for the
 * final tool-free completion.
 *
 * @param contents Gemini conversation contents, mutated in place
 * @param systemInstruction System prompt passed on every round
 * @param useModel Model name to call
 * @param userLocation Optional user coordinates passed to tools
 * @param onToolCall Hook invoked when a tool call starts
 * @param onToolResult Hook invoked with a tool's parsed result
 * @param userId Authenticated user id, enabling memory tools
 */
export async function runToolLoop(
  contents: Content[],
  systemInstruction: string | undefined,
  useModel: string,
  userLocation?: { latitude: number; longitude: number },
  onToolCall?: (name: string, args: Record<string, unknown>) => void,
  onToolResult?: (name: string, result: unknown) => void,
  userId?: string,
): Promise<void> {
  const MAX_ROUNDS = 5;
  const toolCache = new Map<string, string>();
  const tools = buildGeminiTools(userId);

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const response = await googleGenAi.models.generateContent({
      model: useModel,
      contents,
      config: {
        systemInstruction,
        tools,
        toolConfig: {
          functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO },
        },
        temperature: 0,
      },
    });

    const calls = response.functionCalls;
    if (!calls?.length) break;

    const modelContent = response.candidates?.[0]?.content;
    if (modelContent) contents.push(modelContent);

    const responseParts: Part[] = [];
    for (const call of calls) {
      const name = call.name ?? "";
      const args = (call.args ?? {}) as Record<string, unknown>;

      onToolCall?.(name, args);

      const cacheKey = stableCacheKey(name, args);
      let resultStr: string;
      if (toolCache.has(cacheKey)) {
        resultStr = toolCache.get(cacheKey)!;
      } else {
        resultStr = await executeLocalTool(name, args, userLocation, userId);
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

      onToolResult?.(name, parsedResult);

      const responseObj =
        parsedResult && typeof parsedResult === "object"
          ? (parsedResult as Record<string, unknown>)
          : { result: parsedResult };
      responseParts.push({ functionResponse: { name, response: responseObj } });
    }

    contents.push({ role: "user", parts: responseParts });
  }
}
