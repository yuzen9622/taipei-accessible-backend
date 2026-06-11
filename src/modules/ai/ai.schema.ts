import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { registry } from "../../openapi/registry";

extendZodWithOpenApi(z);

export const IntentBodySchema = z
  .object({
    query: z
      .string()
      .min(1)
      .openapi({
        description: "Natural-language travel query",
        example: "我要從台中火車站坐到高鐵新竹站，我坐輪椅",
      }),
  })
  .strict();

const RouteIntentSchema = z
  .object({
    from: z.string().openapi({ example: "台中車站" }),
    to: z.string().openapi({ example: "高鐵新竹站" }),
    mode: z
      .enum(["wheelchair", "elderly", "visual_impaired", "normal"])
      .openapi({ example: "wheelchair" }),
    departureTime: z.string().openapi({
      example: "now",
      description: "'now' or HH:mm / ISO8601",
    }),
    preferences: z.object({
      minimizeTransfers: z.boolean().openapi({ example: false }),
      preferElevator: z.boolean().openapi({ example: true }),
    }),
  })
  .openapi("RouteIntent");

const IntentResponseSchema = z
  .object({
    ok: z.boolean().openapi({ example: true }),
    status: z.enum(["success", "error"]).openapi({ example: "success" }),
    code: z.number().openapi({ example: 200 }),
    message: z.string().openapi({ example: "OK" }),
    data: RouteIntentSchema.optional(),
    accessToken: z.string().optional(),
  })
  .openapi("IntentResponse");

const IntentErrorSchema = z
  .object({
    ok: z.boolean().openapi({ example: false }),
    status: z.enum(["success", "error"]).openapi({ example: "error" }),
    code: z.number().openapi({ example: 400 }),
    message: z
      .string()
      .openapi({ example: "無法解析您的查詢，請改用『從 A 到 B』的描述方式" }),
    data: z.unknown().optional(),
  })
  .openapi("IntentErrorResponse");

// ─── Phase 10 — /ai/explain ──────────────────────────────────────────────────

export const ExplainBodySchema = z
  .object({
    route: z
      .object({
        routeName: z.string().optional(),
        totalMinutes: z.number().optional(),
        transferCount: z.number().optional(),
        legs: z.array(z.record(z.string(), z.unknown())).optional(),
      })
      .passthrough()
      .openapi({
        description:
          "An AccessibleRoute object as returned by POST /a11y/accessible-route",
      }),
    mode: z
      .enum(["wheelchair", "elderly", "visual_impaired", "normal"])
      .default("normal")
      .openapi({ example: "wheelchair" }),
    language: z.enum(["zh-TW", "en"]).default("zh-TW").openapi({
      example: "zh-TW",
    }),
  })
  .strict();

const RouteExplanationSchema = z
  .object({
    summary: z.string().openapi({
      example: "建議搭乘台鐵轉高鐵，全程均有電梯，約 95 分鐘抵達",
    }),
    accessibilityHighlights: z.array(z.string()).openapi({
      example: ["台中站設有無障礙電梯通往月台", "高鐵新竹站 5 號出口有坡道"],
    }),
    warnings: z.array(z.string()).openapi({ example: [] }),
    alternatives: z.string().nullable().openapi({
      example: null,
      description: "Fallback suggestion; null when there are no warnings",
    }),
  })
  .openapi("RouteExplanation");

const ExplainResponseSchema = z
  .object({
    ok: z.boolean().openapi({ example: true }),
    status: z.enum(["success", "error"]).openapi({ example: "success" }),
    code: z.number().openapi({ example: 200 }),
    message: z.string().openapi({ example: "OK" }),
    data: RouteExplanationSchema.optional(),
    accessToken: z.string().optional(),
  })
  .openapi("ExplainResponse");

registry.registerPath({
  method: "post",
  path: "/ai/explain",
  tags: ["AI"],
  summary: "Route explanation generation",
  description:
    "Generates a human-readable RouteExplanation (summary, accessibility highlights, warnings, fallback suggestion) for a planned AccessibleRoute via a single structured Gemini call. Pass a route object from POST /a11y/accessible-route. Highlights are strictly grounded in the route data — the model is instructed not to invent facilities.",
  request: {
    body: {
      content: { "application/json": { schema: ExplainBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Generated RouteExplanation",
      content: { "application/json": { schema: ExplainResponseSchema } },
    },
    500: {
      description: "Internal error or model produced no usable explanation",
      content: { "application/json": { schema: IntentErrorSchema } },
    },
  },
});

// ─── Phase 17 — /ai/chat (Agent Streaming) ───────────────────────────────────

export const ToolCallSchema = z
  .object({
    id: z.string(),
    type: z.literal("function"),
    function: z.object({
      name: z.string(),
      arguments: z.string().openapi({ description: "JSON 字串格式的工具參數" }),
    }),
  })
  .openapi("ToolCall");

export const ChatMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.string().nullable().optional(),
    name: z.string().optional().openapi({ description: "role 為 tool 時必填，對應工具名稱" }),
    tool_calls: z.array(ToolCallSchema).optional(),
    tool_call_id: z.string().optional().openapi({ description: "role 為 tool 時必填" }),
  })
  .openapi("ChatMessage");

export const AgentChatRequestSchema = z
  .object({
    model: z
      .string()
      .optional()
      .openapi({
        description: "模型名稱，未設定時使用環境變數 GEMINI_MODEL 或 gemini-2.5-flash",
        example: "gemini-2.5-flash",
      }),
    messages: z
      .array(ChatMessageSchema)
      .min(1)
      .openapi({
        description: "對話歷程，格式與 OpenAI Chat Completions API 一致",
        example: [{ role: "user", content: "我坐輪椅，從台北車站到台北101怎麼去？" }],
      }),
    stream: z
      .boolean()
      .optional()
      .default(false)
      .openapi({ description: "是否啟用 SSE 串流回應", example: true }),
    temperature: z.number().min(0).max(2).optional().default(0.2).openapi({ example: 0.2 }),
    userLocation: z
      .object({
        latitude: z.number().openapi({ example: 25.0478 }),
        longitude: z.number().openapi({ example: 121.517 }),
      })
      .optional()
      .openapi({ description: "使用者目前位置，供路線規劃與無障礙設施查詢使用" }),
  })
  .openapi("AgentChatRequest");

const AgentChatResponseSchema = z
  .object({
    ok: z.boolean().openapi({ example: true }),
    status: z.enum(["success", "error"]).openapi({ example: "success" }),
    code: z.number().openapi({ example: 200 }),
    message: z.string().openapi({ example: "OK" }),
    data: z
      .object({
        id: z.string(),
        object: z.string(),
        created: z.number(),
        model: z.string(),
        choices: z.array(z.record(z.string(), z.unknown())),
        usage: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
  })
  .openapi("AgentChatResponse");

registry.registerPath({
  method: "post",
  path: "/ai/chat",
  tags: ["AI"],
  summary: "Agent Chat (OpenAI-Compatible, SSE Streaming)",
  description:
    `無障礙導航 AI 對話代理。後端擔任 **Agent Orchestrator**，負責工具呼叫迴圈：\n\n` +
    `1. 收到使用者訊息後，後端以 OpenAI SDK 呼叫 LLM\n` +
    `2. 若模型要求呼叫工具（planAccessibleRoute、findA11yPlaces 等），後端在本地執行工具並將結果送回模型\n` +
    `3. 重複直到模型生成最終文字回答\n\n` +
    `**stream: true** — 回應為 \`text/event-stream\` SSE 流，包含三種事件類型：\n` +
    `- \`event: tool_call\` — 工具開始執行通知\n` +
    `- \`event: tool_result\` — 工具執行結果\n` +
    `- \`data: {...}\` (message 事件) — OpenAI 格式文字 delta chunks\n` +
    `- \`data: [DONE]\` — 串流結束\n\n` +
    `**stream: false** — 回應為標準 JSON（ApiResponse 格式）`,
  request: {
    body: {
      content: { "application/json": { schema: AgentChatRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "SSE stream (stream=true) 或 JSON (stream=false)",
      content: {
        "application/json": { schema: AgentChatResponseSchema },
        "text/event-stream": {
          schema: z.string().openapi({
            description:
              "SSE 串流。每筆 data 為 OpenAI ChatCompletionChunk JSON；工具事件另以 event: tool_call / tool_result 發送",
          }),
        },
      },
    },
    400: {
      description: "請求參數驗證失敗",
      content: { "application/json": { schema: IntentErrorSchema } },
    },
    500: {
      description: "伺服器錯誤",
      content: { "application/json": { schema: IntentErrorSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/ai/intent",
  tags: ["AI"],
  summary: "Natural-language intent parsing",
  description:
    "Parses a free-form travel query (e.g. \"我坐輪椅要從台中車站到高鐵新竹站\") into a structured RouteIntent: origin, destination, accessibility mode, departure time, and preferences. Powered by a single structured Gemini call. The same RouteIntent can be fed into POST /a11y/accessible-route via its optional `query` field.",
  request: {
    body: {
      content: { "application/json": { schema: IntentBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Parsed RouteIntent",
      content: { "application/json": { schema: IntentResponseSchema } },
    },
    400: {
      description: "Query could not be parsed into a route intent",
      content: { "application/json": { schema: IntentErrorSchema } },
    },
    500: {
      description: "Internal error",
      content: { "application/json": { schema: IntentErrorSchema } },
    },
  },
});
