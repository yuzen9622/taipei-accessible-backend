import { messagingApi } from "@line/bot-sdk";
import { LINE_MSG, SOS_TYPE_LABEL } from "../constants/messages";
import type { SosType } from "../modules/sos/sos.types";

let client: messagingApi.MessagingApiClient | null = null;

export type LineReplyMessage = messagingApi.Message;

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

export interface RouteCardOption {
  label: string;
  time: string;
  detail?: string;
}

export interface RouteCardPayload {
  origin: string;
  destination: string;
  options: RouteCardOption[];
  liffUrl?: string;
}

/**
 * Extracts the SOS session id from a tracking URL. The tracking URL is built by
 * the SOS service as `${base}/zh-TW?sos=<sessionId>`, so the id is read from the
 * `sos` query parameter without coupling this adapter to the service layer.
 *
 * @param trackingUrl The public tracking URL embedded in the notification.
 * @returns The session id, or undefined when the URL cannot be parsed.
 */
function extractSessionId(trackingUrl: string): string | undefined {
  try {
    return new URL(trackingUrl).searchParams.get("sos") ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Builds the SOS notification Flex Message (§7.5). Adds postback action buttons
 * so a bound contact can acknowledge or claim the event directly from the card.
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

  const sessionId = extractSessionId(payload.trackingUrl);
  const footerContents: messagingApi.FlexComponent[] = [];
  if (sessionId) {
    footerContents.push(
      {
        type: "button",
        style: "primary",
        color: "#D0021B",
        action: {
          type: "postback",
          label: "我收到了",
          data: `action=ack&sid=${sessionId}`,
          displayText: "我收到通知了",
        },
      },
      {
        type: "button",
        style: "primary",
        color: "#1F4E79",
        action: {
          type: "postback",
          label: "我來處理",
          data: `action=claim&sid=${sessionId}`,
          displayText: "我來處理這件事",
        },
      },
    );
  }
  footerContents.push({
    type: "button",
    style: sessionId ? "link" : "primary",
    ...(sessionId ? {} : { color: "#D0021B" }),
    action: {
      type: "uri",
      label: LINE_MSG.VIEW_LOCATION,
      uri: payload.trackingUrl,
    },
  });

  return {
    type: "flex",
    altText: `${LINE_MSG.SOS_NOTIFY_TITLE}（${SOS_TYPE_LABEL[payload.type]}）`,
    contents: {
      type: "bubble",
      body: { type: "box", layout: "vertical", contents: bodyContents },
      footer: {
        type: "box",
        layout: "vertical",
        contents: footerContents,
      },
    },
  };
}

/**
 * Builds the control message replied to a contact right after they claim an SOS
 * event. Quick-reply postback buttons let the claimer update the handling status
 * or resolve the alert without typing.
 *
 * @param sessionId The claimed session id, embedded in each postback payload.
 * @returns A LINE text message carrying quick-reply postback actions.
 */
export function buildClaimedControlsMessage(
  sessionId: string,
): messagingApi.TextMessage {
  return {
    type: "text",
    text: "可使用下方按鈕更新處理狀態，或在抵達後解除警報。",
    quickReply: {
      items: [
        {
          type: "action",
          action: {
            type: "postback",
            label: "前往中",
            data: `action=status&sid=${sessionId}&v=en_route`,
            displayText: "我正在前往",
          },
        },
        {
          type: "action",
          action: {
            type: "postback",
            label: "已抵達",
            data: `action=status&sid=${sessionId}&v=arrived`,
            displayText: "我已抵達現場",
          },
        },
        {
          type: "action",
          action: {
            type: "postback",
            label: "解除警報",
            data: `action=resolve&sid=${sessionId}`,
            displayText: "解除警報",
          },
        },
      ],
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
 * Builds a route summary card for LINE chat. The route data is deliberately
 * small and already normalized by the service layer; this function only owns
 * LINE Flex presentation details.
 *
 * @param payload Normalized route card content.
 * @returns A LINE Flex Message ready to reply.
 */
export function buildRouteCardFlex(payload: RouteCardPayload): messagingApi.FlexMessage {
  const optionContents: messagingApi.FlexComponent[] = payload.options.slice(0, 3).map((option) => ({
    type: "box",
    layout: "vertical",
    margin: "md",
    contents: [
      {
        type: "text",
        text: `${option.label}：${option.time}`,
        weight: "bold",
        size: "sm",
        wrap: true,
      },
      ...(option.detail
        ? [{
            type: "text" as const,
            text: option.detail,
            size: "xs" as const,
            color: "#666666",
            margin: "xs" as const,
            wrap: true,
          }]
        : []),
    ],
  }));

  const footerContents: messagingApi.FlexComponent[] = payload.liffUrl
    ? [
        {
          type: "button",
          style: "primary",
          action: {
            type: "uri",
            label: "查看地圖",
            uri: payload.liffUrl,
          },
        },
      ]
    : [];

  return {
    type: "flex",
    altText: "路線規劃結果",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: "路線規劃結果",
            weight: "bold",
            size: "lg",
            color: "#1F4E79",
          },
          {
            type: "text",
            text: `${payload.origin} → ${payload.destination}`,
            margin: "md",
            wrap: true,
          },
          ...optionContents,
        ],
      },
      ...(footerContents.length
        ? { footer: { type: "box" as const, layout: "vertical" as const, contents: footerContents } }
        : {}),
    },
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
 * Multicasts a plain-text SOS status update to bound contacts (best-effort;
 * push failures are swallowed so they never block the originating action).
 *
 * @param lineUserIds Recipient LINE user ids.
 * @param message The status update text.
 * @returns The number of recipients the update was attempted for.
 */
export async function pushSosUpdate(
  lineUserIds: string[],
  message: string,
): Promise<number> {
  if (lineUserIds.length === 0) return 0;
  try {
    await getClient().multicast({
      to: lineUserIds,
      messages: [{ type: "text", text: message }],
    });
  } catch (err) {
    console.error("[line.adapter] pushSosUpdate failed", err);
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
  await replyMessages(replyToken, [{ type: "text", text }]);
}

/**
 * Replies with speech text and, when available, a route preview Flex card.
 *
 * @param replyToken One-time reply token from the webhook event.
 * @param text Plain speech text shown before the card.
 * @param routeCard Optional normalized route card content.
 */
export async function replyAgentResult(
  replyToken: string,
  text: string,
  routeCard?: RouteCardPayload | null,
): Promise<void> {
  const messages: LineReplyMessage[] = [{ type: "text", text }];
  if (routeCard) messages.push(buildRouteCardFlex(routeCard));
  await replyMessages(replyToken, messages);
}

/**
 * Replies to a webhook event with one or more LINE messages via the reply token.
 *
 * @param replyToken One-time reply token from the webhook event.
 * @param messages LINE messages to send in order.
 */
export async function replyMessages(
  replyToken: string,
  messages: LineReplyMessage[],
): Promise<void> {
  try {
    await getClient().replyMessage({
      replyToken,
      messages,
    });
  } catch (err) {
    console.error("[line.adapter] replyMessages failed", err);
  }
}
