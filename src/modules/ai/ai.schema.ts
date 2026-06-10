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
