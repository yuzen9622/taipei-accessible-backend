import type OpenAI from "openai";
import type {
  Content,
  Part,
  Tool,
  FunctionDeclaration,
  GenerateContentConfig,
  GenerateContentResponse,
} from "@google/genai";
import { FunctionCallingConfigMode } from "@google/genai";
import { googleGenAi, model } from "../../config/ai";
import { openAiChatTools, memoryTools } from "../../config/ai/tool";
import { executeLocalTool } from "./agent-tools";
import type { OAIMessage } from "./ai.types";

export type { OAIMessage };

export interface RunToolLoopResult {
  text?: string;
  toolResults: Array<{
    name: string;
    args: Record<string, unknown>;
    result: unknown;
  }>;
}

/**
 * The routing-round generate config, shared by `runToolLoop` and `routeOnce`
 * so the offline eval can never drift from the production routing decision.
 *
 * @param systemInstruction System prompt for this round
 * @param tools The Gemini tool catalogue
 * @returns The GenerateContentConfig used for every tool-selection round
 */
function buildRoutingConfig(
  systemInstruction: string | undefined,
  tools: Tool[],
): GenerateContentConfig {
  return {
    systemInstruction,
    tools,
    toolConfig: {
      functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO },
    },
    temperature: 0,
  };
}

/**
 * The final-answer generate config. Identical to `buildRoutingConfig` except
 * function calling is disabled (`mode: NONE`), so the model must emit text. The
 * tool catalogue is still declared so the model's thought signatures round-trip
 * exactly as they did on the routing rounds — the same reason `runToolLoop`
 * pushes the model's content back verbatim.
 *
 * @param systemInstruction System prompt for the final round
 * @param tools The Gemini tool catalogue (declared but not callable)
 * @returns The GenerateContentConfig used to force the final text answer
 */
function buildFinalConfig(
  systemInstruction: string | undefined,
  tools: Tool[],
): GenerateContentConfig {
  return {
    systemInstruction,
    tools,
    toolConfig: {
      functionCallingConfig: { mode: FunctionCallingConfigMode.NONE },
    },
    temperature: 0,
  };
}

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
 * @param userId Authenticated user id.
 * @param memoryEnabled When true, memory tools are appended to the catalogue.
 * @returns A single-entry Tool list holding every function declaration
 */
export function buildGeminiTools(
  userId?: string,
  memoryEnabled = false,
  extraTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [],
): Tool[] {
  const specs =
    userId && memoryEnabled
      ? [...openAiChatTools, ...memoryTools, ...extraTools]
      : [...openAiChatTools, ...extraTools];
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
 * @param userId Authenticated user id.
 * @param memoryEnabled Enables memory tools when userId is present.
 * @param execTool Tool executor, injectable for offline eval; defaults to the
 *   real `executeLocalTool`.
 * @returns The model's final text answer plus parsed tool results. Always
 *   resolves with a `text` field (possibly empty); never returns without one,
 *   so callers never need a divergent fallback generation.
 */
export async function runToolLoop(
  contents: Content[],
  systemInstruction: string | undefined,
  useModel: string,
  userLocation?: { latitude: number; longitude: number },
  onToolCall?: (name: string, args: Record<string, unknown>) => void,
  onToolResult?: (name: string, result: unknown) => void,
  userId?: string,
  memoryToolsEnabled = false,
  allowMemoryWrite = false,
  explicitMemoryRequest = false,
  execTool: typeof executeLocalTool = executeLocalTool,
  options: { extraTools?: OpenAI.Chat.Completions.ChatCompletionTool[] } = {},
): Promise<RunToolLoopResult> {
  const MAX_ROUNDS = 5;
  const toolCache = new Map<string, string>();
  const extraTools = options.extraTools ?? [];
  const tools = buildGeminiTools(userId, memoryToolsEnabled, extraTools);
  const toolResults: RunToolLoopResult["toolResults"] = [];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const response = await googleGenAi.models.generateContent({
      model: useModel,
      contents,
      config: buildRoutingConfig(systemInstruction, tools),
    });

    const calls = response.functionCalls;
    if (!calls?.length) {
      const text = response.text ?? "";
      if (text) return { text, toolResults };
      break;
    }

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
        resultStr = await execTool(name, args, userLocation, userId, {
          allowMemoryWrite,
          explicitMemoryRequest,
        });
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
      toolResults.push({ name, args, result: parsedResult });

      const responseObj =
        parsedResult && typeof parsedResult === "object"
          ? (parsedResult as Record<string, unknown>)
          : { result: parsedResult };
      responseParts.push({ functionResponse: { name, response: responseObj } });
    }

    contents.push({ role: "user", parts: responseParts });
  }

  const finalResp = await googleGenAi.models.generateContent({
    model: useModel,
    contents,
    config: buildFinalConfig(systemInstruction, tools),
  });
  return { text: finalResp.text ?? "", toolResults };
}

export interface RouteOnceResult {
  calledTools: string[];
  text: string;
  raw: GenerateContentResponse;
}

/**
 * Run EXACTLY ONE routing round against the real tool catalogue and routing
 * config, reporting which tools the model chose. Does NOT execute any tool and
 * never touches MongoDB or external APIs — for the offline tool-selection eval
 * only. Mirrors the first round of `runToolLoop` via the shared
 * `buildRoutingConfig`.
 *
 * @param userMessage The single user query to route
 * @param systemInstruction System prompt (assemble via withUserLocation upstream)
 * @param opts userLocation is unused here (location belongs in systemInstruction);
 *   memoryEnabled toggles memory tools into the catalogue when userId is present;
 *   model overrides the default
 * @returns The called tool names (in order), any emitted text, and the raw response
 */
export async function routeOnce(
  userMessage: string,
  systemInstruction: string | undefined,
  opts: {
    userLocation?: { latitude: number; longitude: number };
    userId?: string;
    memoryEnabled?: boolean;
    model?: string;
  } = {},
): Promise<RouteOnceResult> {
  const useModel = opts.model ?? model;
  const tools = buildGeminiTools(opts.userId, opts.memoryEnabled ?? Boolean(opts.userId));
  const contents: Content[] = [{ role: "user", parts: [{ text: userMessage }] }];

  const response = await googleGenAi.models.generateContent({
    model: useModel,
    contents,
    config: buildRoutingConfig(systemInstruction, tools),
  });

  const calledTools = (response.functionCalls ?? [])
    .map((c) => c.name ?? "")
    .filter(Boolean);

  // Only read `.text` when no tool fired — the SDK warns when `.text` is
  // accessed on a response that also has functionCall parts.
  const text = calledTools.length ? "" : response.text ?? "";

  return { calledTools, text, raw: response };
}
