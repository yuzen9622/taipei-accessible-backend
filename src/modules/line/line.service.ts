import { webhook } from "@line/bot-sdk";
import { Types } from "mongoose";
import { executeLocalTool } from "../ai/agent-tools";
import { toGeminiHistory } from "../agent/history-adapter";
import { summarizeWithContext } from "../agent/agent-manager.service";
import { classifyIntent } from "../agent/intent-classifier.service";
import { getActionSpec } from "../agent/action-registry";
import { executeAction } from "../agent/action-executor.service";
import type {
  Action,
  ActionCtx,
  ClassifierPending,
} from "../agent/agent-intent.types";
import { LINE_FAMILY_SYSTEM_PROMPT } from "../../config/ai/line-family-prompt";
import { withCurrentDate } from "../../config/ai/chat-prompt";
import EmergencyContact from "../../model/emergency-contact.model";
import LineLinkCode from "../../model/line-link-code.model";
import {
  replyAgentResult,
  replyText,
  type RouteCardPayload,
} from "../../adapters/line.adapter";
import { LINE_MSG } from "../../constants/messages";
import { model } from "../../config/ai";
import SosSession from "../../model/sos-session.model";
import User from "../../model/user.model";
import { planAccessibleRouteFromRequest } from "../accessible-route/accessible-route.service";
import { ResponseCode } from "../../types/code";
import type {
  LineEvent,
  LineRoutePreviewData,
  LineServiceResult,
} from "./line.types";
import type { AccessibilityMode, TravelMode } from "../../types/route";
import { appendLineChatTurn, getLineChatHistory } from "./line-memory";
import type { LineChatMessage } from "./line-memory";
import {
  clearPendingIntent,
  getLineState,
  updateLineState,
  type PendingIntent,
  type SharedLocation,
} from "./line-state";

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
 * tool and the general accessible-route planner (F4 — route.plan keeps a card).
 *
 * @param toolResults Collected tool results from the action executor.
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
 * Read-only, non-consuming probe for a bare 6-char code (no bind context). Used
 * by the classifier: a hit lets the bind action complete; a miss is fail-closed.
 *
 * @param code Normalized 6-char code.
 * @returns True when a live emergency-contact or LINE-account code matches.
 */
async function probeBindCode(code: string): Promise<boolean> {
  try {
    const [emergency, link] = await Promise.all([
      EmergencyContact.exists({
        bindStatus: "pending",
        bindCode: code,
        bindCodeExpiresAt: { $gt: new Date() },
      }),
      LineLinkCode.exists({ code, expiresAt: { $gt: new Date() } }),
    ]);
    return Boolean(emergency || link);
  } catch {
    return false;
  }
}

function toClassifierPending(
  pending?: PendingIntent,
): ClassifierPending | undefined {
  if (!pending) return undefined;
  if (pending.kind === "awaiting_bind_code") return { kind: "awaiting_bind_code" };
  if (pending.kind === "awaiting_domain_choice")
    return { kind: "awaiting_domain_choice" };
  return {
    kind: "collecting_slots",
    action: pending.action,
    awaitingSlot: pending.awaitingSlot,
    candidates: pending.candidates,
  };
}

function summarizeContext(
  history: LineChatMessage[],
  userText: string,
): { systemInstruction?: string; contents: ReturnType<typeof toGeminiHistory>["contents"] } {
  return toGeminiHistory([
    { role: "system", content: withCurrentDate(LINE_FAMILY_SYSTEM_PROMPT) },
    ...history,
    ...(userText ? [{ role: "user" as const, content: userText }] : []),
  ]);
}

interface ResolvedIntent {
  replyToken: string;
  lineUserId?: string;
  action: Action;
  slots: Record<string, string | number>;
  location?: SharedLocation;
  history: LineChatMessage[];
  userText?: string;
}

function missingSlotsFor(
  requiredList: string[],
  ctx: ActionCtx,
): string[] {
  return requiredList.filter((slot) => {
    if (slot === "location") return !ctx.location;
    const value = ctx.slots[slot];
    return value === undefined || value === "";
  });
}

async function persistReplyTurn(
  lineUserId: string | undefined,
  userText: string | undefined,
  speech: string,
): Promise<void> {
  if (!lineUserId) return;
  await clearPendingIntent(lineUserId);
  await appendLineChatTurn(lineUserId, userText || "(位置訊息)", speech);
}

/**
 * Single structured entry point: text and location handlers both converge here.
 * Never fabricates text, never re-classifies. Checks slots, then either asks
 * for one missing slot, runs the action's forced steps, or clarifies.
 *
 * @param input The resolved action, slots, optional shared location and history.
 */
async function handleResolvedIntent(input: ResolvedIntent): Promise<void> {
  const { replyToken, lineUserId, action, slots, location, history } = input;
  const userText = input.userText;
  const { systemInstruction, contents } = summarizeContext(
    history,
    userText ?? "",
  );

  if (action === "app_info") {
    await replyText(replyToken, LINE_MSG.APP_INFO);
    return;
  }
  if (action === "unknown") {
    await replyText(replyToken, LINE_MSG.CLARIFY);
    return;
  }
  if (action === "smalltalk") {
    let speech = "";
    try {
      speech = await summarizeWithContext({ contents, systemInstruction, model });
    } catch (error) {
      console.error("[line.service] smalltalk summarize failed", error);
    }
    await replyAgentResult(replyToken, speech || LINE_MSG.INFO, null);
    await persistReplyTurn(lineUserId, userText, speech || LINE_MSG.INFO);
    return;
  }

  const spec = getActionSpec(action);
  const ctx: ActionCtx = {
    slots: { ...slots },
    location: location ? { lat: location.lat, lng: location.lng } : undefined,
    prev: [],
  };

  const missing = missingSlotsFor(spec.requiredSlots(ctx), ctx);
  if (missing.length) {
    const awaitingSlot = missing[0];
    const ask = spec.askFor[awaitingSlot] ?? LINE_MSG.CLARIFY;
    if (lineUserId) {
      const write = await updateLineState(lineUserId, (prev) => ({
        pendingIntent: {
          kind: "collecting_slots",
          action,
          filledSlots: ctx.slots,
          location,
          awaitingSlot,
          missingSlots: missing,
        },
        lastSharedLocation: location ?? prev?.lastSharedLocation,
      }));
      if (!write.ok) {
        await replyText(replyToken, LINE_MSG.RECOVERABLE_ASK);
        return;
      }
    }
    await replyText(replyToken, ask);
    return;
  }

  const userLocation =
    spec.needsUserLocation && ctx.location
      ? { latitude: ctx.location.lat, longitude: ctx.location.lng }
      : undefined;
  const outcome = await executeAction(spec, ctx, {
    execTool: (name, args) =>
      executeLocalTool(name, args, userLocation, undefined, { lineUserId }),
    summarize: (seedParts) =>
      summarizeWithContext({ contents, systemInstruction, model, seedParts }),
  });

  if (outcome.kind === "canned") {
    await replyAgentResult(replyToken, outcome.speech, null);
    await persistReplyTurn(lineUserId, userText, outcome.speech);
    return;
  }

  if (outcome.kind === "clarify") {
    if (lineUserId && outcome.persist) {
      const write = await updateLineState(lineUserId, (prev) => ({
        pendingIntent: {
          kind: "collecting_slots",
          action,
          filledSlots: ctx.slots,
          location,
          awaitingSlot: outcome.persist!.awaitingSlot,
          candidates: outcome.persist!.candidates,
          missingSlots: [outcome.persist!.awaitingSlot],
        },
        lastSharedLocation: location ?? prev?.lastSharedLocation,
      }));
      if (!write.ok) {
        await replyText(replyToken, LINE_MSG.RECOVERABLE_ASK);
        return;
      }
    }
    await replyText(replyToken, outcome.message);
    return;
  }

  const routeCard = routeCardFromToolResults(outcome.toolResults);
  const speech = outcome.speech || LINE_MSG.INFO;
  await replyAgentResult(replyToken, speech, routeCard);
  await persistReplyTurn(lineUserId, userText, speech);
}

async function handleTextMessage(
  replyToken: string,
  text: string,
  lineUserId?: string,
): Promise<void> {
  try {
    const [history, state] = await Promise.all([
      lineUserId ? getLineChatHistory(lineUserId) : Promise.resolve([]),
      lineUserId ? getLineState(lineUserId) : Promise.resolve(null),
    ]);
    const pending = state?.pendingIntent;

    const intent = await classifyIntent(
      { text, pending: toClassifierPending(pending) },
      { probeBindCode },
    );

    const action = intent.action;
    let slots: Record<string, string | number> = { ...intent.slots };
    let location: SharedLocation | undefined = state?.lastSharedLocation;

    if (pending?.kind === "collecting_slots") {
      if (action === pending.action) {
        slots = { ...pending.filledSlots, ...intent.slots };
        location = pending.location ?? location;
      } else if (lineUserId) {
        await clearPendingIntent(lineUserId);
      }
    } else if (pending?.kind === "awaiting_domain_choice") {
      location = pending.location ?? location;
      if (lineUserId) await clearPendingIntent(lineUserId);
    } else if (pending?.kind === "awaiting_bind_code" && action !== "bind.code") {
      if (lineUserId) await clearPendingIntent(lineUserId);
    }

    await handleResolvedIntent({
      replyToken,
      lineUserId,
      action,
      slots,
      location,
      history,
      userText: text,
    });
  } catch (error) {
    console.error("[line.service] family agent failed", error);
    await replyText(replyToken, LINE_MSG.INFO);
  }
}

/**
 * @param spec The pending action's spec.
 * @param filledSlots Slots already collected on the pending intent.
 * @returns True when supplying a shared location would advance the action.
 */
function locationAdvancesAction(
  action: Action,
  filledSlots: Record<string, string | number>,
): boolean {
  const spec = getActionSpec(action);
  const ctx: ActionCtx = { slots: { ...filledSlots }, prev: [] };
  const missing = missingSlotsFor(spec.requiredSlots(ctx), ctx);
  return spec.needsUserLocation === true && missing.length > 0;
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

  const shared: SharedLocation = {
    lat: message.latitude,
    lng: message.longitude,
    ts: new Date().toISOString(),
  };
  const [history, state] = await Promise.all([
    getLineChatHistory(lineUserId),
    getLineState(lineUserId),
  ]);
  const pending = state?.pendingIntent;

  if (
    pending?.kind === "collecting_slots" &&
    locationAdvancesAction(pending.action, pending.filledSlots)
  ) {
    await updateLineState(lineUserId, (prev) => ({
      pendingIntent: prev?.pendingIntent,
      lastSharedLocation: shared,
    }));
    await handleResolvedIntent({
      replyToken,
      lineUserId,
      action: pending.action,
      slots: pending.filledSlots,
      location: shared,
      history,
      userText: "",
    });
    return;
  }

  const write = await updateLineState(lineUserId, () => ({
    pendingIntent: { kind: "awaiting_domain_choice", location: shared },
    lastSharedLocation: shared,
  }));
  if (!write.ok) {
    await replyText(replyToken, LINE_MSG.RECOVERABLE_ASK);
    return;
  }
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
