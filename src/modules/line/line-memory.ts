import { redisClient } from "../../config/redis";

export interface LineChatMessage {
  role: "user" | "assistant";
  content: string;
}

const LINE_CHAT_TTL_SEC = 30 * 60;
const MAX_LINE_CHAT_MESSAGES = 20;

function lineChatKey(lineUserId: string): string {
  return `line:chat:${lineUserId}`;
}

function isLineChatMessage(value: unknown): value is LineChatMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return (
    (message.role === "user" || message.role === "assistant") &&
    typeof message.content === "string"
  );
}

/**
 * @param lineUserId LINE user identifier used to scope the conversation.
 * @returns Up to the latest 20 valid user and assistant messages.
 */
export async function getLineChatHistory(
  lineUserId: string,
): Promise<LineChatMessage[]> {
  if (!redisClient) {
    console.error("[line-memory] Redis unavailable");
    return [];
  }

  try {
    const raw = await redisClient.get(lineChatKey(lineUserId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isLineChatMessage).slice(-MAX_LINE_CHAT_MESSAGES);
  } catch (error) {
    console.error("[line-memory] failed to read chat history", error);
    return [];
  }
}

/**
 * @param lineUserId LINE user identifier used to scope the conversation.
 * @param userText User message to append.
 * @param assistantText User-facing assistant reply to append.
 * @returns Nothing; Redis failures are logged and ignored.
 */
export async function appendLineChatTurn(
  lineUserId: string,
  userText: string,
  assistantText: string,
): Promise<void> {
  if (!redisClient) {
    console.error("[line-memory] Redis unavailable");
    return;
  }

  try {
    const history = await getLineChatHistory(lineUserId);
    const updated = [
      ...history,
      { role: "user" as const, content: userText },
      { role: "assistant" as const, content: assistantText },
    ].slice(-MAX_LINE_CHAT_MESSAGES);
    await redisClient.set(
      lineChatKey(lineUserId),
      JSON.stringify(updated),
      "EX",
      LINE_CHAT_TTL_SEC,
    );
  } catch (error) {
    console.error("[line-memory] failed to append chat turn", error);
  }
}
