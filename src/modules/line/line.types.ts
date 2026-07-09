import type { webhook } from "@line/bot-sdk";

export type LineEvent = webhook.Event;

export interface LineWebhookBody {
  destination?: string;
  events: LineEvent[];
}
