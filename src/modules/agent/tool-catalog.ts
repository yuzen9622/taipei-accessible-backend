import type OpenAI from "openai";
import type { Tool, FunctionDeclaration } from "@google/genai";
import { openAiChatTools, memoryTools } from "../../config/ai/tool";

/**
 * Build Gemini function declarations from the existing OpenAI tool specs by
 * passing their JSON Schema straight through (`parametersJsonSchema`), so the
 * tool catalogue stays defined in one place.
 *
 * @param userId Authenticated user id.
 * @param memoryEnabled When true, memory tools are appended to the catalogue.
 * @param extraTools Additional OpenAI tool specs to append (e.g. LINE family).
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
