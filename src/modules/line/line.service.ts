import { webhook } from "@line/bot-sdk";
import { Types } from "mongoose";
import { executeLocalTool } from "../ai/agent-tools";
import { toGeminiHistory, runToolLoop } from "../ai/ai-chat.service";
import { lineFamilyTools } from "../../config/ai/tool";
import { LINE_FAMILY_SYSTEM_PROMPT } from "../../config/ai/line-family-prompt";
import { withCurrentDate } from "../../config/ai/chat-prompt";
import EmergencyContact from "../../model/emergency-contact.model";
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
import type { RunToolLoopResult } from "../ai/ai-chat.service";
import type { AccessibilityMode, TravelMode } from "../../types/route";

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

function parseStructuredAgentText(text: string): {
  speech: string;
  uiType?: string;
  uiData?: Record<string, unknown>;
} {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return { speech: trimmed };
  try {
    const parsed = JSON.parse(trimmed);
    if (!isRecord(parsed)) return { speech: trimmed };
    return {
      speech: asString(parsed.speech) ?? trimmed,
      uiType: asString(parsed.ui_type),
      uiData: isRecord(parsed.ui_data) ? parsed.ui_data : undefined,
    };
  } catch {
    return { speech: trimmed };
  }
}

function routeOptionsFromStructuredData(
  uiData: Record<string, unknown>,
  toolResults: RunToolLoopResult["toolResults"],
): RouteCardPayload | null {
  const origin = asString(uiData.origin);
  const destination = asString(uiData.destination);
  if (!origin || !destination) return null;

  const candidates: Array<[string, unknown]> = [
    ["機車", uiData.scooter_time],
    ["汽車", uiData.car_time],
    ["大眾運輸", uiData.transit_time],
  ];
  const options = candidates
    .map(([label, value]) => {
      const time = asString(value);
      return time ? { label, time } : null;
    })
    .filter((value): value is { label: string; time: string } =>
      Boolean(value),
    );

  if (!options.length) return null;

  let sessionId = asString(uiData.sessionId);
  if (!sessionId) {
    const routeResult = [...toolResults]
      .reverse()
      .find(
        (entry) =>
          entry.name === "planRouteToSosVictim" && isRecord(entry.result),
      );
    if (routeResult && isRecord(routeResult.result)) {
      sessionId = asString(routeResult.result.sessionId);
    }
  }

  return {
    origin,
    destination,
    options,
    liffUrl: asString(uiData.liff_url) ?? routePreviewUrl(sessionId),
  };
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

function routeCardFromToolResults(
  toolResults: RunToolLoopResult["toolResults"],
): RouteCardPayload | null {
  const routeResult = [...toolResults]
    .reverse()
    .find(
      (entry) =>
        entry.name === "planRouteToSosVictim" && isRecord(entry.result),
    );
  if (
    !routeResult ||
    !isRecord(routeResult.result) ||
    routeResult.result.ok !== true
  )
    return null;

  const result = routeResult.result;
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

  const destination = isRecord(result.destination)
    ? (asString(result.destination.address) ??
      asString(result.ownerName) ??
      "求救者位置")
    : (asString(result.ownerName) ?? "求救者位置");
  return {
    origin: "你分享的位置",
    destination,
    options,
    liffUrl: routePreviewUrl(asString(result.sessionId)),
  };
}

function buildAgentReply(result: RunToolLoopResult): {
  speech: string;
  routeCard?: RouteCardPayload | null;
} {
  const structured = parseStructuredAgentText(result.text ?? "");

  const structuredRouteCard =
    structured.uiType === "route_card" && structured.uiData
      ? routeOptionsFromStructuredData(
          structured.uiData,
          result.toolResults ?? [],
        )
      : null;
  return {
    speech: structured.speech || LINE_MSG.INFO,
    routeCard:
      structuredRouteCard ?? routeCardFromToolResults(result.toolResults ?? []),
  };
}

async function handleTextMessage(
  replyToken: string,
  text: string,
  lineUserId?: string,
): Promise<void> {
  try {
    const { systemInstruction, contents } = toGeminiHistory([
      { role: "system", content: withCurrentDate(LINE_FAMILY_SYSTEM_PROMPT) },
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

    const reply = buildAgentReply(result);
    await replyAgentResult(replyToken, reply.speech, reply.routeCard);
  } catch (error) {
    console.error("[line.service] family agent failed", error);
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

  if (replyToken) {
    await handleTextMessage(
      replyToken,
      `我的目前位置為${message.latitude}, ${message.longitude}，我要過去`,
      lineUserId,
    );
  }
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
