import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// Spread-actual so the real SignatureValidationFailed class is preserved
// (the route-level error handler relies on `instanceof`), overriding only the
// signature middleware to branch on a test header.
vi.mock("@line/bot-sdk", async (orig) => {
  const actual = (await orig()) as typeof import("@line/bot-sdk");
  return {
    ...actual,
    middleware: () => (req: any, _res: any, next: any) => {
      if (req.headers["x-line-signature"] !== "valid-sig") {
        return next(new actual.SignatureValidationFailed("signature validation failed"));
      }
      try {
        req.body = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString() : JSON.stringify(req.body));
      } catch {
        req.body = {};
      }
      next();
    },
  };
});

vi.mock("./line.service", () => ({
  handleEvents: vi.fn().mockResolvedValue(undefined),
}));

import { buildTestApp } from "../../../test/test-helpers";
import * as service from "./line.service";
import { ResponseCode } from "../../types/code";

const app = buildTestApp();
const URL = "/api/v1/line/webhook";

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(service.handleEvents).mockResolvedValue(undefined);
});

describe("POST /line/webhook", () => {
  it("returns 401 when the signature is invalid (error handler, controller not reached)", async () => {
    const res = await request(app)
      .post(URL)
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ events: [] }));
    expect(res.status).toBe(ResponseCode.UNAUTHORIZED);
    expect(vi.mocked(service.handleEvents)).not.toHaveBeenCalled();
  });

  it("acks 200 and delegates events to the service on a valid signature", async () => {
    const events = [{ type: "follow", replyToken: "r1", source: { type: "user", userId: "U1" } }];
    const res = await request(app)
      .post(URL)
      .set("Content-Type", "application/json")
      .set("x-line-signature", "valid-sig")
      .send(JSON.stringify({ events }));
    expect(res.status).toBe(200);
    expect(vi.mocked(service.handleEvents)).toHaveBeenCalledWith(events);
  });
});
