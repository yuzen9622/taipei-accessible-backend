import type { webhook } from "@line/bot-sdk";
import type { AccessibleRoute } from "../accessible-route/accessible-route.service";
import type { PlanRouteResult } from "../accessible-route/accessible-route.service";
import type { ResponseCode } from "../../types/code";

export type LineEvent = webhook.Event;

export interface LineWebhookBody {
  destination?: string;
  events: LineEvent[];
}

export type PlanRouteData = Exclude<PlanRouteResult, { ok: false }>["data"];

export interface LineRoutePreviewData extends PlanRouteData {
  sessionId: string;
  ownerName: string;
  originLabel: string;
  destinationLabel: string;
}

export interface LineServiceResult<T = unknown> {
  ok: boolean;
  httpCode: ResponseCode;
  message: string;
  data?: T;
}
