import { webhook } from "@line/bot-sdk";
import { executeLocalTool } from "../ai/agent-tools";
import { toGeminiHistory, runToolLoop } from "../ai/ai-chat.service";
import { lineFamilyTools } from "../../config/ai/tool";
import { LINE_FAMILY_SYSTEM_PROMPT } from "../../config/ai/line-family-prompt";
import EmergencyContact from "../../model/emergency-contact.model";
import { replyText } from "../../adapters/line.adapter";
import { LINE_MSG } from "../../constants/messages";
import { model } from "../../config/ai";
import type { LineEvent } from "./line.types";

function getUserId(event: LineEvent): string | undefined {
  const source = event.source as webhook.UserSource | undefined;
  if (source && source.type === "user") return source.userId;
  return undefined;
}

async function handleTextMessage(
  replyToken: string,
  text: string,
  lineUserId?: string,
): Promise<void> {
  try {
    const { systemInstruction, contents } = toGeminiHistory([
      { role: "system", content: LINE_FAMILY_SYSTEM_PROMPT },
      { role: "user", content: text },
    ]);

    const result = await runToolLoop(
      contents,
      systemInstruction,
      model,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      false,
      false,
      (name, args, userLocation, userId, options) =>
        executeLocalTool(name, args, userLocation, userId, {
          ...options,
          lineUserId,
        }),
      { extraTools: lineFamilyTools },
    );

    const message = result.text?.trim() || LINE_MSG.INFO;
    await replyText(replyToken, message);
  } catch (error) {
    console.error("[line.service] family agent failed", error);
    await replyText(replyToken, LINE_MSG.INFO);
  }
}

async function handleEvent(event: LineEvent): Promise<void> {
  switch (event.type) {
    case "follow":
      if (event.replyToken) await replyText(event.replyToken, LINE_MSG.WELCOME);
      return;
    case "message": {
      const message = event.message;
      if (!event.replyToken || message.type !== "text") return;
      await handleTextMessage(event.replyToken, message.text, getUserId(event));
      return;
    }
    case "unfollow": {
      const userId = getUserId(event);
      if (userId) {
        await EmergencyContact.updateMany(
          { lineUserId: userId },
          { $set: { bindStatus: "pending", lineUserId: null } },
        );
      }
      return;
    }
    default:
      return;
  }
}

export async function handleEvents(events: LineEvent[]): Promise<void> {
  for (const event of events) {
    try {
      await handleEvent(event);
    } catch (err) {
      console.error("[line.service] event handling failed", err);
    }
  }
}
