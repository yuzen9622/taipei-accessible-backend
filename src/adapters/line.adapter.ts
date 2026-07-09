import { messagingApi } from "@line/bot-sdk";
import { LINE_MSG, SOS_TYPE_LABEL } from "../constants/messages";
import type { SosType } from "../modules/sos/sos.types";

let client: messagingApi.MessagingApiClient | null = null;

/**
 * Lazily constructs (and caches) the LINE Messaging API client. Reads
 * `LINE_CHANNEL_ACCESS_TOKEN` on first use so the module stays importable in
 * environments where LINE is not configured (tests fully mock this adapter).
 *
 * @returns The shared `MessagingApiClient` instance.
 */
function getClient(): messagingApi.MessagingApiClient {
  if (!client) {
    client = new messagingApi.MessagingApiClient({
      channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN ?? "",
    });
  }
  return client;
}

/**
 * Builds the official add-friend URL from the configured bot basic id.
 *
 * @returns The `https://line.me/R/ti/p/@...` deep link shown to the user.
 */
export function buildBindUrl(): string {
  const basicId = process.env.LINE_BOT_BASIC_ID ?? "@xxxxxxx";
  return `https://line.me/R/ti/p/${basicId}`;
}

interface SosNotificationPayload {
  userName?: string;
  type: SosType;
  trackingUrl: string;
  address?: string | null;
}

/**
 * Builds the SOS notification Flex Message (§7.5).
 *
 * @param payload SOS details used to populate the card.
 * @returns A LINE Flex Message ready to push.
 */
function buildSosNotificationFlex(
  payload: SosNotificationPayload,
): messagingApi.FlexMessage {
  const bodyContents: messagingApi.FlexComponent[] = [
    {
      type: "text",
      text: LINE_MSG.SOS_NOTIFY_TITLE,
      weight: "bold",
      size: "lg",
      color: "#D0021B",
    },
    {
      type: "text",
      text: `類型：${SOS_TYPE_LABEL[payload.type]}`,
      wrap: true,
      margin: "md",
    },
  ];
  if (payload.userName) {
    bodyContents.push({ type: "text", text: `求救者：${payload.userName}`, wrap: true });
  }
  if (payload.address) {
    bodyContents.push({ type: "text", text: `位置：${payload.address}`, wrap: true });
  }

  return {
    type: "flex",
    altText: `${LINE_MSG.SOS_NOTIFY_TITLE}（${SOS_TYPE_LABEL[payload.type]}）`,
    contents: {
      type: "bubble",
      body: { type: "box", layout: "vertical", contents: bodyContents },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "button",
            style: "primary",
            color: "#D0021B",
            action: {
              type: "uri",
              label: LINE_MSG.VIEW_LOCATION,
              uri: payload.trackingUrl,
            },
          },
        ],
      },
    },
  };
}

/**
 * Builds the SOS resolved Flex Message (§7.7).
 *
 * @param userName Optional name of the person who was in distress.
 * @returns A LINE Flex Message ready to push.
 */
function buildSosResolvedFlex(userName?: string): messagingApi.FlexMessage {
  const contents: messagingApi.FlexComponent[] = [
    {
      type: "text",
      text: LINE_MSG.SOS_RESOLVED_TITLE,
      weight: "bold",
      size: "lg",
      color: "#2E7D32",
    },
  ];
  if (userName) {
    contents.push({ type: "text", text: `${userName} 的求救已解除，目前平安。`, wrap: true, margin: "md" });
  }
  return {
    type: "flex",
    altText: LINE_MSG.SOS_RESOLVED_TITLE,
    contents: { type: "bubble", body: { type: "box", layout: "vertical", contents } },
  };
}

/**
 * Multicasts the SOS notification to bound contacts (best-effort; individual
 * push failures are swallowed so they never block SOS creation).
 *
 * @param lineUserIds Bound contacts' LINE user ids.
 * @param payload SOS notification content.
 * @returns The number of recipients the notification was attempted for.
 */
export async function sendSosNotification(
  lineUserIds: string[],
  payload: SosNotificationPayload,
): Promise<number> {
  if (lineUserIds.length === 0) return 0;
  try {
    await getClient().multicast({
      to: lineUserIds,
      messages: [buildSosNotificationFlex(payload)],
    });
  } catch (err) {
    console.error("[line.adapter] sendSosNotification failed", err);
  }
  return lineUserIds.length;
}

/**
 * Multicasts the SOS resolved notice to bound contacts (best-effort).
 *
 * @param lineUserIds Bound contacts' LINE user ids.
 * @param userName Optional name of the person who was in distress.
 * @returns The number of recipients the notification was attempted for.
 */
export async function sendSosResolved(
  lineUserIds: string[],
  userName?: string,
): Promise<number> {
  if (lineUserIds.length === 0) return 0;
  try {
    await getClient().multicast({
      to: lineUserIds,
      messages: [buildSosResolvedFlex(userName)],
    });
  } catch (err) {
    console.error("[line.adapter] sendSosResolved failed", err);
  }
  return lineUserIds.length;
}

/**
 * Replies to a webhook event with plain text via the (free) reply token.
 *
 * @param replyToken One-time reply token from the webhook event.
 * @param text Message text.
 */
export async function replyText(replyToken: string, text: string): Promise<void> {
  try {
    await getClient().replyMessage({
      replyToken,
      messages: [{ type: "text", text }],
    });
  } catch (err) {
    console.error("[line.adapter] replyText failed", err);
  }
}
