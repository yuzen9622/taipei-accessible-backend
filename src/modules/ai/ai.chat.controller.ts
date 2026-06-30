import type { Request, Response } from "express";
import { googleGenAi, model } from "../../config/ai";
import { sendResponse } from "../../config/lib";
import { ResponseCode } from "../../types/code";
import { MSG, ERROR_MESSAGE } from "../../constants/messages";
import { verifyAccessToken } from "../../config/jwt";
import { runToolLoop, toGeminiHistory, type OAIMessage } from "./ai-chat.service";
import { loadMemories } from "./memory.service";
import { CHAT_SYSTEM_PROMPT, withUserLocation } from "../../config/ai/chat-prompt";
import type { IUser } from "../../types";

function sendSse(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function resolveAuthUser(req: Request): IUser | null {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return null;
  const v = verifyAccessToken(token);
  if (!v.success || !v.decoded) return null;
  return (v.decoded as { user?: IUser }).user ?? null;
}

const CATEGORY_LABELS: Record<string, string> = {
  preference: "偏好",
  place: "地點",
  habit: "習慣",
  context: "情境",
};

export async function aiChat(req: Request, res: Response): Promise<void> {
  const {
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

  const useTemp = temperature ?? 0.2;
  const authUser = resolveAuthUser(req);
  const userId = authUser ? String(authUser._id) : undefined;

  let systemPrompt = withUserLocation(CHAT_SYSTEM_PROMPT, userLocation);
  if (userId) {
    try {
      const memories = await loadMemories(userId);
      if (memories.length) {
        systemPrompt += `\n\n【使用者記憶】以下是你對這位使用者的了解，請自然地運用：`;
        for (const m of memories) {
          const label = CATEGORY_LABELS[m.category] ?? m.category;
          systemPrompt += `\n- [${label}] ${m.content} (id:${m._id})`;
        }
        systemPrompt += `\n\n當使用者說「回家」「去上班」「老地方」等，根據記憶推斷地點。路線規劃自動套用記憶中的無障礙模式。`;
      }
    } catch (err) {
      console.error("[ai/chat] loadMemories failed:", err);
    }
  }

  const messages: OAIMessage[] = [{ role: "system", content: systemPrompt }];
  messages.push(...rawMessages.filter((m) => m.role !== "system"));

  const { systemInstruction, contents } = toGeminiHistory(messages);

  if (stream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    try {
      await runToolLoop(
        contents,
        systemInstruction,
        model,
        userLocation,
        (name, args) => sendSse(res, "tool_call", { name, args }),
        (name, result) => sendSse(res, "tool_result", { name, result }),
        userId,
      );

      const finalStream = await googleGenAi.models.generateContentStream({
        model,
        contents,
        config: { systemInstruction, temperature: useTemp },
      });

      for await (const chunk of finalStream) {
        const text = chunk.text;
        if (text) sendSse(res, "token", { text });
      }

      res.write("event: done\ndata: done\n\n");
      res.end();
    } catch (error: any) {
      console.error("[ai/chat stream]", error);
      sendSse(res, "error", {
        code: ResponseCode.INTERNAL_ERROR,
        message: error?.message ?? ERROR_MESSAGE.INTERNAL,
      });
      res.write("event: done\ndata: done\n\n");
      res.end();
    }
    return;
  }

  try {
    await runToolLoop(contents, systemInstruction, model, userLocation, undefined, undefined, userId);

    const response = await googleGenAi.models.generateContent({
      model,
      contents,
      config: { systemInstruction, temperature: useTemp },
    });

    const text = response.text ?? "";
    const usage = response.usageMetadata;
    sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, {
      id: `chatcmpl-${Date.now().toString(36)}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: usage?.promptTokenCount ?? 0,
        completion_tokens: usage?.candidatesTokenCount ?? 0,
        total_tokens: usage?.totalTokenCount ?? 0,
      },
    });
  } catch (error: any) {
    console.error("[ai/chat]", error);
    sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      error?.message ?? ERROR_MESSAGE.INTERNAL,
    );
  }
}
