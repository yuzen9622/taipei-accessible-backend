import type { Request, Response } from "express";
import { ResponseCode } from "../../types/code";
import * as service from "./line.service";
import type { LineEvent } from "./line.types";

/**
 * Webhook handler: acknowledges with 200 immediately (LINE resends on slow
 * ACK), then processes events asynchronously.
 *
 * @param req Express request (body already signature-verified and parsed).
 * @param res Express response.
 */
export function handleWebhook(req: Request, res: Response) {
  res.status(ResponseCode.OK).json({ ok: true });

  const events = ((req.body?.events as LineEvent[]) ?? []) as LineEvent[];
  void service.handleEvents(events).catch((err) => {
    console.error("[line.controller] handleEvents failed", err);
  });
}
