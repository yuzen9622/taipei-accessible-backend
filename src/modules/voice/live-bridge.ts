import { WebSocket } from "ws";
import {
  FunctionCall,
  FunctionResponse,
  LiveServerMessage,
  Modality,
  Session,
} from "@google/genai";
import { googleGenAi } from "../../config/ai";
import { buildGeminiTools } from "../ai/ai-chat.service";
import { executeLocalTool } from "../ai/agent-tools";
import { buildVoiceSystemPrompt } from "./voice-prompt";
import { withCurrentDate } from "../../config/ai/chat-prompt";

const MAX_BUFFERED_BYTES = 1024 * 1024;
const ERROR_SUMMARY_MAX_CHARS = 200;
const INPUT_AUDIO_MIME_TYPE = "audio/pcm;rate=16000";

export interface LiveBridgeOptions {
  ws: WebSocket;
  userId: string;
  userLocation?: { latitude: number; longitude: number };
}

export interface LiveBridge {
  sendAudio(data: Buffer): void;
  close(): void;
}

/**
 * Truncates an error message to a bounded length and strips values that could
 * identify a user (precise coordinates, long token-like strings).
 *
 * @param message The raw error message.
 * @returns A bounded, de-identified summary safe for server logs.
 */
function summarizeError(message?: string): string {
  const text = (message ?? "unknown error")
    .replace(/-?\d{1,3}\.\d{3,}/g, (m) => Number(m).toFixed(2))
    .replace(/[A-Za-z0-9_-]{25,}/g, "[redacted]");
  return text.slice(0, ERROR_SUMMARY_MAX_CHARS);
}

/**
 * Recursively masks personally identifiable fields in a value for trace logs:
 * token/secret-like keys, user ids, contact fields, and coordinate values
 * truncated to two decimals.
 *
 * @param value The value to redact.
 * @param key The property name of the value in its parent object, if any.
 * @returns A redacted copy safe for local trace output.
 */
function redactValue(value: unknown, key?: string): unknown {
  if (key) {
    if (/token|secret|password|authorization/i.test(key)) return "[redacted]";
    if (/user_?id/i.test(key)) return "[redacted]";
    if (/phone|email|contact/i.test(key)) return "[redacted]";
    if (/^(lat|latitude|lng|lon|longitude)$/i.test(key) && typeof value === "number") {
      return Number(value.toFixed(2));
    }
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(v, k);
    return out;
  }
  if (typeof value === "string") {
    return value.replace(/-?\d{1,3}\.\d{3,}/g, (m) => Number(m).toFixed(2));
  }
  return value;
}

/**
 * Emits a full tool trace to the local console when VOICE_POC_TRACE=true,
 * with arguments and results passed through the redactor first.
 *
 * @param tool The tool name.
 * @param args The tool call arguments.
 * @param result The raw tool result string.
 */
function traceToolCall(tool: string, args: unknown, result: string): void {
  if (process.env.VOICE_POC_TRACE !== "true") return;
  let redactedResult: unknown;
  try {
    redactedResult = redactValue(JSON.parse(result));
  } catch {
    redactedResult = redactValue(result);
  }
  console.log(
    "[voice-trace]",
    JSON.stringify({ tool, args: redactValue(args), result: redactedResult }),
  );
}

/**
 * Opens a Gemini Live API session bound to one authenticated WebSocket
 * connection: upstream PCM16/16kHz audio flows into the session, downstream
 * audio/transcripts/tool events flow back to the client, and model tool calls
 * are executed locally and returned to the session.
 *
 * @param options The client socket, authenticated user id, and optional location.
 * @returns A bridge handle for forwarding audio and closing the session.
 */
export async function createLiveBridge(options: LiveBridgeOptions): Promise<LiveBridge> {
  const { ws, userId, userLocation } = options;
  let session: Session | null = null;
  let closedByGateway = false;
  let cumulativeTokens = 0;

  const sendJson = (payload: Record<string, unknown>): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  };

  const forwardAudio = (base64Data: string): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      console.warn(
        "[voice] dropping downstream audio frame",
        JSON.stringify({ bufferedAmount: ws.bufferedAmount }),
      );
      return;
    }
    ws.send(Buffer.from(base64Data, "base64"), { binary: true });
  };

  const handleToolCalls = async (functionCalls: FunctionCall[]): Promise<void> => {
    const functionResponses: FunctionResponse[] = [];
    for (const call of functionCalls) {
      const name = call.name ?? "";
      sendJson({ type: "tool_call", name });
      const startedAt = Date.now();
      let ok = true;
      let response: Record<string, unknown>;
      try {
        const result = await executeLocalTool(
          name,
          (call.args ?? {}) as Record<string, unknown>,
          userLocation,
          userId,
        );
        response = { output: result };
        traceToolCall(name, call.args ?? {}, result);
      } catch (err) {
        ok = false;
        response = {
          error: summarizeError(err instanceof Error ? err.message : String(err)),
        };
      }
      const durationMs = Date.now() - startedAt;
      console.log(
        "[voice] tool",
        JSON.stringify({ tool: name, ok, durationMs, ...(ok ? {} : { error: response.error }) }),
      );
      sendJson({ type: "tool_result", name, ok, durationMs });
      functionResponses.push({ id: call.id, name, response });
    }
    session?.sendToolResponse({ functionResponses });
  };

  const handleServerMessage = async (message: LiveServerMessage): Promise<void> => {
    const content = message.serverContent;
    if (content) {
      for (const part of content.modelTurn?.parts ?? []) {
        if (part.inlineData?.data) forwardAudio(part.inlineData.data);
      }
      if (content.inputTranscription?.text) {
        sendJson({ type: "transcript", role: "user", text: content.inputTranscription.text });
      }
      if (content.outputTranscription?.text) {
        sendJson({ type: "transcript", role: "model", text: content.outputTranscription.text });
      }
      if (content.interrupted) sendJson({ type: "interrupted" });
      if (content.turnComplete) sendJson({ type: "turn.complete" });
    }
    if (message.toolCall?.functionCalls?.length) {
      await handleToolCalls(message.toolCall.functionCalls);
    }
    if (message.usageMetadata?.totalTokenCount != null) {
      cumulativeTokens += message.usageMetadata.totalTokenCount;
      console.log("[voice] usage", JSON.stringify({ cumulativeTokens }));
    }
  };

  session = await googleGenAi.live.connect({
    model: process.env.GEMINI_LIVE_MODEL ?? "gemini-3.1-flash-live-preview",
    config: {
      responseModalities: [Modality.AUDIO],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      systemInstruction: withCurrentDate(buildVoiceSystemPrompt(userLocation)),
      tools: buildGeminiTools(userId, false),
    },
    callbacks: {
      onmessage: (message: LiveServerMessage) => {
        handleServerMessage(message).catch((err) => {
          console.error(
            "[voice] server message handling failed:",
            summarizeError(err instanceof Error ? err.message : String(err)),
          );
        });
      },
      onerror: (e) => {
        console.error("[voice] live session error:", summarizeError(e?.message));
      },
      onclose: () => {
        if (closedByGateway || ws.readyState !== WebSocket.OPEN) return;
        sendJson({ type: "error", code: "LIVE_SESSION_ENDED" });
        ws.close(1000, "live-session-ended");
      },
    },
  });

  return {
    sendAudio(data: Buffer): void {
      session?.sendRealtimeInput({
        audio: { data: data.toString("base64"), mimeType: INPUT_AUDIO_MIME_TYPE },
      });
    },
    close(): void {
      closedByGateway = true;
      try {
        session?.close();
      } catch (err) {
        console.warn(
          "[voice] live session close failed:",
          summarizeError(err instanceof Error ? err.message : String(err)),
        );
      }
    },
  };
}
