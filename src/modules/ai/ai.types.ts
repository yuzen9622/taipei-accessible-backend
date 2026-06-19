/**
 * ai module type declarations — the OpenAI message shape used by the streaming
 * chat agent's tool loop.
 */

import type OpenAI from "openai";

export type OAIMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
