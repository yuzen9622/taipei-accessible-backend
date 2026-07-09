import type { webhook } from "@line/bot-sdk";
import type { AccessibleRoute } from "../accessible-route/accessible-route.service";
import type { ResponseCode } from "../../types/code";

export type LineEvent = webhook.Event;

export interface LineWebhookBody {
  destination?: string;
  events: LineEvent[];
}

export interface LineRoutePreviewPoint {
  label: string;
  lat: number;
  lng: number;
  address?: string | null;
}

export interface LineRoutePreviewData {
  sessionId: string;
  ownerName: string;
  origin: LineRoutePreviewPoint;
  destination: LineRoutePreviewPoint;
  city: string;
  travelMode: "transit" | "drive" | "motorcycle" | "walk";
  routes: AccessibleRoute[];
}

export interface LineServiceResult<T = unknown> {
  ok: boolean;
  httpCode: ResponseCode;
  message: string;
  data?: T;
}
