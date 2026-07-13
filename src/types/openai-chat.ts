import type OpenAI from "openai";

/** The OpenAI message shape used by the streaming chat agent's tool loop. */
export type OAIMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
