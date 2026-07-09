import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

vi.mock("./sos.service", () => ({
  createSession: vi.fn(),
  updateLocation: vi.fn(),
  resolveSession: vi.fn(),
  getPublicByToken: vi.fn(),
}));

import { buildTestApp, buildAuthorizationHeader } from "../../../test/test-helpers";
import * as service from "./sos.service";
import { ResponseCode } from "../../types/code";
import { SOS_MSG, SOS_REASON } from "../../constants/messages";

const app = buildTestApp();
const BASE = "/api/v1/sos/sessions";
const auth = buildAuthorizationHeader();
const TOKEN_32 = "9f3a1c000000000000000000000000e0";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("POST /sos/sessions", () => {
  it("rejects without a token with 403", async () => {
    const res = await request(app).post(BASE).send({ type: "trapped", lat: 25, lng: 121 });
    expect(res.status).toBe(ResponseCode.FORBIDDEN);
    expect(vi.mocked(service.createSession)).not.toHaveBeenCalled();
  });

  it("returns 201 with notifiedCount when a new session is created", async () => {
    vi.mocked(service.createSession).mockResolvedValue({
      ok: true,
      httpCode: ResponseCode.CREATED,
      message: SOS_MSG.CREATED,
      data: { sessionId: "s1", shareToken: TOKEN_32, notifiedCount: 2 },
    });
    const res = await request(app)
      .post(BASE)
      .set("Authorization", auth)
      .send({ type: "trapped", lat: 25.033, lng: 121.5654, address: "台北市信義區" });
    expect(res.status).toBe(201);
    expect(res.body.data.notifiedCount).toBe(2);
    expect(res.body.data.shareToken).toBe(TOKEN_32);
  });

  it("returns 200 (not 201) with the existing session when one is already active", async () => {
    vi.mocked(service.createSession).mockResolvedValue({
      ok: true,
      httpCode: ResponseCode.OK,
      message: SOS_MSG.ALREADY_ACTIVE,
      data: { sessionId: "s1", shareToken: TOKEN_32, notifiedCount: 2 },
    });
    const res = await request(app).post(BASE).set("Authorization", auth).send({ type: "body", lat: 25, lng: 121 });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe(SOS_MSG.ALREADY_ACTIVE);
  });
});

describe("PATCH /sos/sessions/:id/location", () => {
  it("returns 403 NOT_SESSION_OWNER for another user's session", async () => {
    vi.mocked(service.updateLocation).mockResolvedValue({
      ok: false,
      httpCode: ResponseCode.FORBIDDEN,
      message: SOS_MSG.NOT_SESSION_OWNER,
      data: { reason: SOS_REASON.NOT_SESSION_OWNER },
    });
    const res = await request(app).patch(`${BASE}/s1/location`).set("Authorization", auth).send({ lat: 25, lng: 121 });
    expect(res.status).toBe(403);
    expect(res.body.data.reason).toBe(SOS_REASON.NOT_SESSION_OWNER);
  });

  it("returns 400 SESSION_NOT_ACTIVE when the session is resolved", async () => {
    vi.mocked(service.updateLocation).mockResolvedValue({
      ok: false,
      httpCode: ResponseCode.INVALID_INPUT,
      message: SOS_MSG.SESSION_NOT_ACTIVE,
      data: { reason: SOS_REASON.SESSION_NOT_ACTIVE },
    });
    const res = await request(app).patch(`${BASE}/s1/location`).set("Authorization", auth).send({ lat: 25, lng: 121 });
    expect(res.status).toBe(400);
    expect(res.body.data.reason).toBe(SOS_REASON.SESSION_NOT_ACTIVE);
  });
});

describe("GET /sos/sessions/:token/public", () => {
  it("returns 200 without an Authorization header for a valid token", async () => {
    vi.mocked(service.getPublicByToken).mockResolvedValue({
      ok: true,
      httpCode: ResponseCode.OK,
      message: SOS_MSG.PUBLIC_OK,
      data: { type: "trapped", status: "active", lat: 25, lng: 121, address: null, updatedAt: new Date().toISOString() },
    });
    const res = await request(app).get(`${BASE}/${TOKEN_32}/public`);
    expect(res.status).toBe(200);
    expect(res.body.data.type).toBe("trapped");
    expect(vi.mocked(service.getPublicByToken)).toHaveBeenCalledWith(TOKEN_32);
  });

  it("returns 404 for an unknown token", async () => {
    vi.mocked(service.getPublicByToken).mockResolvedValue({
      ok: false,
      httpCode: ResponseCode.NOT_FOUND,
      message: SOS_MSG.TRACKING_NOT_FOUND,
      data: { reason: SOS_REASON.SESSION_NOT_FOUND },
    });
    const res = await request(app).get(`${BASE}/${TOKEN_32}/public`);
    expect(res.status).toBe(404);
  });

  it("returns 410 GONE for a resolved session older than 24h", async () => {
    vi.mocked(service.getPublicByToken).mockResolvedValue({
      ok: false,
      httpCode: ResponseCode.GONE,
      message: SOS_MSG.TRACKING_EXPIRED,
      data: { reason: SOS_REASON.TRACKING_EXPIRED },
    });
    const res = await request(app).get(`${BASE}/${TOKEN_32}/public`);
    expect(res.status).toBe(410);
    expect(res.body.data.reason).toBe(SOS_REASON.TRACKING_EXPIRED);
  });

  it("rejects a token of the wrong length with 400 at the schema", async () => {
    const res = await request(app).get(`${BASE}/short/public`);
    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(vi.mocked(service.getPublicByToken)).not.toHaveBeenCalled();
  });
});
