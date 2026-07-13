import http from "http";
import { WebSocketServer, WebSocket, RawData } from "ws";
import { verifyAccessToken } from "../../config/jwt";
import { createLiveBridge, LiveBridge } from "./live-bridge";

const VOICE_WS_PATH = "/api/v1/voice/ws";
const DEFAULT_AUTH_TIMEOUT_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 30000;
const MAX_MISSED_PONGS = 2;

interface VoiceConnection {
  ws: WebSocket;
  bridge: LiveBridge | null;
}

export interface AttachVoiceWebSocketOptions {
  authTimeoutMs?: number;
}

const connections = new Map<string, VoiceConnection>();

/**
 * Converts a ws RawData payload into a Buffer.
 *
 * @param data The raw message data from ws.
 * @returns The message as a single Buffer.
 */
function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/**
 * Parses the optional userLocation field of a session.start message.
 *
 * @param value The raw userLocation value from the client.
 * @returns A validated latitude/longitude pair, or undefined.
 */
function parseUserLocation(
  value: unknown,
): { latitude: number; longitude: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { latitude, longitude } = value as Record<string, unknown>;
  if (typeof latitude !== "number" || typeof longitude !== "number") return undefined;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return undefined;
  }
  return { latitude, longitude };
}

/**
 * Handles the lifecycle of one WebSocket connection: first-message
 * authentication with a bounded deadline, single-session-per-user
 * enforcement, heartbeat, audio forwarding to the Live bridge, and cleanup.
 *
 * @param ws The accepted WebSocket connection.
 * @param authTimeoutMs Milliseconds the client has to send session.start.
 */
function handleConnection(ws: WebSocket, authTimeoutMs: number): void {
  let authenticated = false;
  let userId: string | null = null;
  let bridge: LiveBridge | null = null;
  let missedPongs = 0;

  const sendJson = (payload: Record<string, unknown>): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  };

  const authTimer = setTimeout(() => {
    if (!authenticated) ws.close(4401, "unauthorized");
  }, authTimeoutMs);

  const heartbeatTimer = setInterval(() => {
    if (missedPongs >= MAX_MISSED_PONGS) {
      ws.terminate();
      return;
    }
    missedPongs++;
    ws.ping();
  }, HEARTBEAT_INTERVAL_MS);

  const handleAuthMessage = async (data: RawData, isBinary: boolean): Promise<void> => {
    if (isBinary) {
      ws.close(4401, "unauthorized");
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawDataToBuffer(data).toString("utf8"));
    } catch {
      ws.close(4401, "unauthorized");
      return;
    }
    if (parsed?.type !== "session.start" || typeof parsed.token !== "string") {
      ws.close(4401, "unauthorized");
      return;
    }
    const result = verifyAccessToken(parsed.token);
    const decodedUser =
      result.success && "decoded" in result ? result.decoded?.user : undefined;
    const id = decodedUser?._id;
    if (typeof id !== "string" || !id) {
      ws.close(4401, "unauthorized");
      return;
    }
    authenticated = true;
    clearTimeout(authTimer);
    userId = id;
    const userLocation = parseUserLocation(parsed.userLocation);
    const existing = connections.get(id);
    if (existing) existing.ws.close(4409, "superseded");
    const connection: VoiceConnection = { ws, bridge: null };
    connections.set(id, connection);
    try {
      bridge = await createLiveBridge({ ws, userId: id, userLocation });
      connection.bridge = bridge;
    } catch (err) {
      console.error(
        "[voice] live connect failed:",
        err instanceof Error ? err.message : String(err),
      );
      sendJson({ type: "error", code: "LIVE_CONNECT_FAILED" });
      ws.close(1011, "live-connect-failed");
      return;
    }
    sendJson({ type: "session.ready" });
  };

  const handleControlMessage = (data: RawData): void => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawDataToBuffer(data).toString("utf8"));
    } catch {
      console.warn("[voice] ignoring unparseable text message");
      return;
    }
    if (parsed?.type === "session.end") {
      ws.close(1000, "client-end");
      return;
    }
    console.warn(`[voice] ignoring unexpected message type: ${String(parsed?.type)}`);
  };

  ws.on("pong", () => {
    missedPongs = 0;
  });

  ws.on("message", (data: RawData, isBinary: boolean) => {
    if (!authenticated) {
      void handleAuthMessage(data, isBinary);
      return;
    }
    if (isBinary) {
      bridge?.sendAudio(rawDataToBuffer(data));
      return;
    }
    handleControlMessage(data);
  });

  ws.on("close", () => {
    clearTimeout(authTimer);
    clearInterval(heartbeatTimer);
    bridge?.close();
    if (userId && connections.get(userId)?.ws === ws) {
      connections.delete(userId);
    }
  });

  ws.on("error", (err) => {
    console.error("[voice] socket error:", err.message);
  });
}

/**
 * Attaches the voice WebSocket gateway to an HTTP server. Upgrade requests
 * are only accepted on the voice WS path; every other path receives an HTTP
 * 404 before the socket is destroyed.
 *
 * @param server The HTTP server created around the Express app.
 * @param options Optional overrides (auth deadline injection for tests).
 */
export function attachVoiceWebSocket(
  server: http.Server,
  options: AttachVoiceWebSocketOptions = {},
): void {
  const authTimeoutMs = options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url ?? "", "http://localhost").pathname;
    if (pathname !== VOICE_WS_PATH) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    handleConnection(ws, authTimeoutMs);
  });
}
