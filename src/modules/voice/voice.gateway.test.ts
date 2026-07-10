import http from "http";
import { AddressInfo } from "net";
import jwt from "jsonwebtoken";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("./live-bridge", () => ({
  createLiveBridge: vi.fn(async () => ({ sendAudio: vi.fn(), close: vi.fn() })),
}));

import app from "../../app";
import { attachVoiceWebSocket } from "./voice.gateway";

const AUTH_TIMEOUT_MS = 300;

let server: http.Server;
let port: number;
const openSockets: WebSocket[] = [];

/**
 * Signs a valid access token with the same payload shape and secret used by
 * test/test-helpers.ts buildAuthorizationHeader.
 *
 * @param userId The user _id embedded in the JWT payload.
 * @returns A signed access token string.
 */
function signToken(userId: string): string {
  return jwt.sign(
    { user: { _id: userId, email: `${userId}@example.com` } },
    process.env.JWT_ACCESS_SECRET ?? "test-access-secret",
  );
}

/**
 * Opens a WebSocket client against the test server and tracks it for cleanup.
 *
 * @param path The request path for the upgrade.
 * @returns The connecting WebSocket client.
 */
function connect(path = "/api/v1/voice/ws"): WebSocket {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  openSockets.push(ws);
  return ws;
}

/**
 * Resolves when the socket emits open.
 *
 * @param ws The WebSocket client.
 * @returns A promise resolved on open, rejected on error.
 */
function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
}

/**
 * Resolves with the close code and reason once the socket closes.
 *
 * @param ws The WebSocket client.
 * @returns A promise of the close code and reason string.
 */
function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

/**
 * Resolves with the next JSON message received on the socket.
 *
 * @param ws The WebSocket client.
 * @returns A promise of the parsed JSON message.
 */
function waitForJson(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once("message", (data) => resolve(JSON.parse(data.toString())));
  });
}

/**
 * Sends an authenticating session.start message for the given user.
 *
 * @param ws The open WebSocket client.
 * @param userId The user to authenticate as.
 */
function sendSessionStart(ws: WebSocket, userId: string): void {
  ws.send(JSON.stringify({ type: "session.start", token: signToken(userId) }));
}

beforeAll(async () => {
  server = http.createServer(app);
  attachVoiceWebSocket(server, { authTimeoutMs: AUTH_TIMEOUT_MS });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(() => {
  for (const ws of openSockets.splice(0)) {
    ws.removeAllListeners();
    ws.terminate();
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("voice gateway", () => {
  it("closes 4401 when no session.start arrives before the auth deadline", async () => {
    const ws = connect();
    await waitForOpen(ws);
    const { code } = await waitForClose(ws);
    expect(code).toBe(4401);
  });

  it("closes 4401 when session.start carries an invalid token", async () => {
    const ws = connect();
    await waitForOpen(ws);
    ws.send(JSON.stringify({ type: "session.start", token: "not-a-valid-token" }));
    const { code } = await waitForClose(ws);
    expect(code).toBe(4401);
  });

  it("closes 4401 when a binary frame arrives before authentication", async () => {
    const ws = connect();
    await waitForOpen(ws);
    ws.send(Buffer.from([0x01, 0x02, 0x03]));
    const { code } = await waitForClose(ws);
    expect(code).toBe(4401);
  });

  it("replies session.ready and keeps the connection alive for a valid token", async () => {
    const ws = connect();
    await waitForOpen(ws);
    const ready = waitForJson(ws);
    sendSessionStart(ws, "voice-user-valid");
    const message = await ready;
    expect(message).toEqual({ type: "session.ready" });
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it("closes the first connection with 4409 when the same user reconnects", async () => {
    const first = connect();
    await waitForOpen(first);
    const firstReady = waitForJson(first);
    sendSessionStart(first, "voice-user-dup");
    await firstReady;

    const firstClosed = waitForClose(first);
    const second = connect();
    await waitForOpen(second);
    const secondReady = waitForJson(second);
    sendSessionStart(second, "voice-user-dup");
    await secondReady;

    const { code } = await firstClosed;
    expect(code).toBe(4409);
    expect(second.readyState).toBe(WebSocket.OPEN);
  });

  it("rejects the upgrade with 404 on any other path", async () => {
    const ws = connect("/api/v1/voice/other");
    const error = await new Promise<Error>((resolve) => {
      ws.on("error", (err) => resolve(err));
    });
    expect(error.message).toContain("404");
  });
});
