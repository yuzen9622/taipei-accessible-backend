import { webhook } from "@line/bot-sdk";
import { Types } from "mongoose";
import EmergencyContact from "../../model/emergency-contact.model";
import {
  buildClaimedControlsMessage,
  replyAgentResult,
  replyMessages,
  replyText,
  showLoadingAnimation,
  type RouteCardPayload,
} from "../../adapters/line.adapter";
import { LINE_MSG, SOS_MSG, SOS_REASON } from "../../constants/messages";
import SosSession from "../../model/sos-session.model";
import User from "../../model/user.model";
import { planAccessibleRouteFromRequest } from "../accessible-route/accessible-route.service";
import {
  acknowledgeSession,
  claimSession,
  getAuthorizedSessionForLineUser,
  resolveSession,
  updateHandlingStatus,
} from "../sos/sos.service";
import type { ServiceResult } from "../sos/sos.types";
import { redisSetNx } from "../../config/redis";
import { ResponseCode } from "../../types/code";
import { stripLineMarkdown } from "../../utils/strip-line-markdown";
import type {
  LineEvent,
  LineRoutePreviewData,
  LineServiceResult,
} from "./line.types";
import type { AccessibilityMode, TravelMode } from "../../types/route";
import type { OAIMessage } from "../../types/openai-chat";
import { appendLineChatTurn, getLineChatHistory } from "./line-memory";
import { runLineAgent } from "./line-agent.service";

const EVENT_DEDUP_TTL_SEC = 3600;

function getUserId(event: LineEvent): string | undefined {
  const source = event.source as webhook.UserSource | undefined;
  if (source && source.type === "user") return source.userId;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function routePreviewUrl(sessionId?: string): string | undefined {
  const explicitBase = process.env.PUBLIC_LIFF_ROUTE_BASE_URL?.trim();
  const fallbackBase = process.env.PUBLIC_TRACKING_BASE_URL?.trim();
  const base =
    explicitBase ||
    (fallbackBase ? `${fallbackBase.replace(/\/$/, "")}/liff/route` : "");
  if (!base) return undefined;
  try {
    const url = new URL(base);
    if (sessionId) url.searchParams.set("sessionId", sessionId);
    return url.toString();
  } catch {
    return undefined;
  }
}

function fail<T = never>(
  httpCode: ResponseCode,
  message: string,
): LineServiceResult<T> {
  return { ok: false, httpCode, message };
}

function describeRouteLegs(legs: unknown): string | undefined {
  if (!Array.isArray(legs)) return undefined;
  const labels = legs
    .slice(0, 3)
    .map((leg) => {
      if (!isRecord(leg)) return undefined;
      const type = asString(leg.type);
      if (type === "WALK") return "步行";
      if (type === "BUS")
        return `公車${asString(leg.routeName) ? ` ${asString(leg.routeName)}` : ""}`;
      if (type === "METRO")
        return `捷運${asString(leg.lineName) ? ` ${asString(leg.lineName)}` : ""}`;
      if (type === "THSR") return "高鐵";
      if (type === "TRA") return "台鐵";
      if (type === "DRIVE") return "汽車";
      if (type === "MOTORCYCLE") return "機車";
      return type;
    })
    .filter((value): value is string => Boolean(value));
  return labels.length ? labels.join(" → ") : undefined;
}

/**
 * Build a route card from collected tool results. Handles both the SOS route
 * tool and the general accessible-route planner so the agent can surface a card.
 *
 * @param toolResults Collected tool results from the agent loop.
 * @returns A route card payload, or null when no usable route result exists.
 */
function routeCardFromToolResults(
  toolResults: Array<{ name: string; result: unknown }>,
): RouteCardPayload | null {
  const entry = [...toolResults]
    .reverse()
    .find(
      (item) =>
        (item.name === "planRouteToSosVictim" ||
          item.name === "planAccessibleRoute") &&
        isRecord(item.result) &&
        item.result.ok === true,
    );
  if (!entry || !isRecord(entry.result)) return null;

  const result = entry.result;
  const routes = Array.isArray(result.routes) ? result.routes : [];
  const options = routes
    .slice(0, 3)
    .map((route, index): RouteCardPayload["options"][number] | null => {
      if (!isRecord(route)) return null;
      const totalMinutes =
        typeof route.totalMinutes === "number" ? route.totalMinutes : undefined;
      return {
        label: asString(route.routeName) ?? `路線 ${index + 1}`,
        time:
          totalMinutes !== undefined
            ? `約 ${Math.round(totalMinutes)} 分鐘`
            : "時間待確認",
        detail: describeRouteLegs(route.legs),
      };
    })
    .filter((value): value is RouteCardPayload["options"][number] =>
      Boolean(value),
    );

  if (!options.length) return null;

  const isSos = entry.name === "planRouteToSosVictim";
  const destination = isRecord(result.destination)
    ? (asString(result.destination.address) ??
      asString(result.destination.name) ??
      asString(result.ownerName) ??
      "目的地")
    : (asString(result.ownerName) ?? "目的地");
  return {
    origin: isSos ? "你分享的位置" : "你的位置",
    destination,
    options,
    liffUrl: routePreviewUrl(asString(result.sessionId)),
  };
}

/**
 * Extracts speech text from the agent result. The family agent may answer with a
 * plain string or a JSON envelope carrying a `speech` field; both are handled.
 *
 * @param text The raw agent text output.
 * @returns The speech to reply with, falling back to the fixed info message.
 */
function parseAgentSpeech(text: string | undefined): string {
  if (!text) return LINE_MSG.INFO;
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (
        isRecord(parsed) &&
        typeof parsed.speech === "string" &&
        parsed.speech.trim()
      ) {
        return parsed.speech;
      }
    } catch {
      return text;
    }
  }
  return text;
}

async function handleTextMessage(
  replyToken: string,
  text: string,
  lineUserId?: string,
): Promise<void> {
  try {
    if (lineUserId) await showLoadingAnimation(lineUserId).catch(() => {});
    const history = lineUserId ? await getLineChatHistory(lineUserId) : [];
    const messages: OAIMessage[] = [
      ...history.map((turn): OAIMessage => ({
        role: turn.role,
        content: turn.content,
      })),
      { role: "user", content: text },
    ];
    const result = await runLineAgent({
      lineUserId: lineUserId ?? "",
      messages,
    });
    const speech = stripLineMarkdown(parseAgentSpeech(result.text));
    const routeCard = routeCardFromToolResults(result.toolResults);
    await replyAgentResult(replyToken, speech, routeCard);
    if (lineUserId) await appendLineChatTurn(lineUserId, text, speech);
  } catch (error) {
    console.error("[line.service] family agent failed", error);
    await replyText(replyToken, LINE_MSG.INFO);
  }
}

/**
 * Detects whether an SOS action observed an already-resolved / not-active session,
 * so every postback action can be normalized to one unified "resolved" reply. Narrows
 * `ServiceResult.data` (typed `unknown`) with an object guard before reading `reason`.
 *
 * @param result The result returned by an SOS action service.
 * @returns True when the action saw a resolved / closed session.
 */
function observedResolved(result: ServiceResult): boolean {
  const data = result.data;
  if (typeof data !== "object" || data === null) return false;
  const reason = (data as { reason?: unknown }).reason;
  return (
    reason === SOS_REASON.ALREADY_RESOLVED ||
    reason === SOS_REASON.SESSION_NOT_ACTIVE
  );
}

/**
 * Handles an SOS control postback from a notification or claim-controls message.
 * Each action maps to a deterministic SOS service call (never the agent). Malformed
 * postbacks are answered with the generic info message without any session lookup;
 * once the action is known-valid, an authorization-preserving pre-check replies with
 * the unified "resolved" message for an already-closed session (and unauthorized
 * callers get the standard permission reply), before the action runs. A resolution
 * that races the action is normalized to the same unified reply.
 *
 * @param event The LINE postback event.
 */
async function handlePostback(event: webhook.PostbackEvent): Promise<void> {
  const replyToken = event.replyToken;
  if (!replyToken) return;

  const params = new URLSearchParams(event.postback.data);
  const action = params.get("action");
  const sid = params.get("sid");
  const value = params.get("v");
  const lineUserId = getUserId(event);

  if (!sid || !lineUserId) {
    await replyText(replyToken, LINE_MSG.INFO);
    return;
  }
  if (
    action !== "ack" &&
    action !== "claim" &&
    action !== "status" &&
    action !== "resolve"
  ) {
    await replyText(replyToken, LINE_MSG.INFO);
    return;
  }
  if (action === "status" && value !== "en_route" && value !== "arrived") {
    await replyText(replyToken, LINE_MSG.INFO);
    return;
  }

  try {
    const auth = await getAuthorizedSessionForLineUser(lineUserId, sid);
    if (!auth?.session) {
      await replyText(replyToken, SOS_MSG.NOT_AUTHORIZED_CONTACT);
      return;
    }
    if (auth.session.status === "resolved") {
      await replyText(replyToken, LINE_MSG.SOS_ALREADY_RESOLVED);
      return;
    }

    await showLoadingAnimation(lineUserId).catch(() => {});

    if (action === "claim") {
      const result = await claimSession({ sessionId: sid, lineUserId });
      if (observedResolved(result)) {
        await replyText(replyToken, LINE_MSG.SOS_ALREADY_RESOLVED);
        return;
      }
      if (result.ok) {
        await replyMessages(replyToken, [
          { type: "text", text: result.message },
          buildClaimedControlsMessage(sid),
        ]);
        return;
      }
      await replyText(replyToken, result.message);
      return;
    }

    let result: ServiceResult;
    if (action === "ack") {
      result = await acknowledgeSession({ sessionId: sid, lineUserId });
    } else if (action === "status") {
      result = await updateHandlingStatus({
        sessionId: sid,
        lineUserId,
        handlingStatus: value as "en_route" | "arrived",
      });
    } else {
      result = await resolveSession({ sessionId: sid, lineUserId });
    }

    if (observedResolved(result)) {
      await replyText(replyToken, LINE_MSG.SOS_ALREADY_RESOLVED);
      return;
    }
    await replyText(replyToken, result.message);
  } catch (error) {
    console.error("[line.service] postback handling failed", error);
    await replyText(replyToken, LINE_MSG.INFO);
  }
}

async function handleLocationMessage(
  replyToken: string,
  message: Extract<LineEvent, { type: "message" }>["message"] & {
    type: "location";
  },
  lineUserId?: string,
): Promise<void> {
  if (!lineUserId) return;

  await EmergencyContact.updateMany(
    { lineUserId, bindStatus: "bound" },
    {
      $set: {
        lastLineLat: message.latitude,
        lastLineLng: message.longitude,
        lastLineLocationUpdatedAt: new Date(),
      },
    },
  );

  if (!replyToken) return;

  await replyText(
    replyToken,
    "收到您的位置！請問要查這個位置的天氣、找附近無障礙設施，還是規劃前往路線呢？",
  );
}

async function handleEvent(event: LineEvent): Promise<void> {
  switch (event.type) {
    case "follow":
      if (event.replyToken) await replyText(event.replyToken, LINE_MSG.WELCOME);
      return;
    case "postback":
      await handlePostback(event);
      return;
    case "message": {
      const message = event.message;
      if (!event.replyToken) return;
      const lineUserId = getUserId(event);
      if (message.type === "text") {
        await handleTextMessage(event.replyToken, message.text, lineUserId);
        return;
      }
      if (message.type === "location") {
        await handleLocationMessage(event.replyToken, message, lineUserId);
        return;
      }
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
      const eventId = (event as { webhookEventId?: string }).webhookEventId;
      if (eventId) {
        const fresh = await redisSetNx(
          `line:evt:${eventId}`,
          EVENT_DEDUP_TTL_SEC,
        );
        if (!fresh) continue;
      }
      await handleEvent(event);
    } catch (err) {
      console.error("[line.service] event handling failed", err);
    }
  }
}

export async function getRoutePreview(
  sessionId: string,
  travelMode?: TravelMode,
  mode?: AccessibilityMode,
  departureTime?: string,
): Promise<LineServiceResult<LineRoutePreviewData>> {
  if (!Types.ObjectId.isValid(sessionId)) {
    return fail(ResponseCode.NOT_FOUND, "找不到進行中的求救紀錄");
  }

  const session = await SosSession.findById(sessionId).lean();
  if (!session || session.status !== "active") {
    return fail(ResponseCode.NOT_FOUND, "找不到進行中的求救紀錄");
  }

  const contact = await EmergencyContact.findOne({
    userId: String(session.userId),
    bindStatus: "bound",
    lineUserId: { $ne: null },
    lastLineLat: { $ne: null },
    lastLineLng: { $ne: null },
  })
    .sort({ lastLineLocationUpdatedAt: -1, updatedAt: -1 })
    .select("lastLineLat lastLineLng lastLineLocationUpdatedAt")
    .lean();

  if (
    typeof contact?.lastLineLat !== "number" ||
    typeof contact?.lastLineLng !== "number"
  ) {
    return fail(ResponseCode.INVALID_INPUT, "尚未取得家人目前位置");
  }

  const routeResult = await planAccessibleRouteFromRequest({
    origin: {
      latitude: contact.lastLineLat,
      longitude: contact.lastLineLng,
    },
    destination: {
      latitude: session.lat,
      longitude: session.lng,
    },
    mode: mode ?? "normal",
    travelMode: travelMode ?? "drive",
    maxTransfers: 2,
    departureTime,
  });

  if (!routeResult.ok) {
    return fail(routeResult.status, routeResult.error);
  }

  const owner = await User.findById(session.userId).select("name").lean();
  return {
    ok: true,
    httpCode: ResponseCode.OK,
    message: "OK",
    data: {
      ...routeResult.data,
      sessionId: String(session._id),
      ownerName: owner?.name ?? "未知使用者",
      originLabel: "你分享的位置",
      destinationLabel: session.address ?? "求救者位置",
      travelMode: routeResult.data.travelMode ?? travelMode ?? "drive",
    },
  };
}
