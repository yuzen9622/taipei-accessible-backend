import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { registry } from "../../openapi/registry";

extendZodWithOpenApi(z);

const CoordSchema = z.object({
  lat: z.number().openapi({ description: "Latitude" }),
  lng: z.number().openapi({ description: "Longitude" }),
});

const RankRequestItemSchema = z.object({
  start: CoordSchema,
  end: CoordSchema,
  instructions: z.string().openapi({ description: "Route instructions text" }),
  duration: z.number().openapi({ description: "Estimated duration in seconds" }),
  a11y: z.array(z.unknown()).openapi({ description: "Accessibility annotations" }),
});

export const RouteRankBodySchema = z
  .object({
    routes: z.array(RankRequestItemSchema).min(1),
  })
  .strict();

export const RouteSelectBodySchema = z
  .object({
    routes: z.array(RankRequestItemSchema).min(1),
  })
  .strict();

export const ChatbotBodySchema = z
  .object({
    message: z.string().min(1).openapi({ description: "User message to the AI chatbot" }),
    lat: z.number().optional().openapi({ description: "User latitude" }),
    lng: z.number().optional().openapi({ description: "User longitude" }),
    lang: z.string().optional().openapi({ example: "Zh_tw" }),
  })
  .strict();

// ── OpenAPI path registrations ──────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/a11y/route-rank",
  tags: ["Accessibility", "AI"],
  summary: "AI-rank multiple routes by accessibility score",
  request: {
    body: {
      content: { "application/json": { schema: RouteRankBodySchema } },
      required: true,
    },
  },
  responses: {
    200: { description: "AI accessibility ranking result" },
    500: { description: "AI error" },
  },
});

registry.registerPath({
  method: "post",
  path: "/a11y/route-select",
  tags: ["Accessibility", "AI"],
  summary: "AI-select the best route from a list",
  request: {
    body: {
      content: { "application/json": { schema: RouteSelectBodySchema } },
      required: true,
    },
  },
  responses: {
    200: { description: "Selected route description" },
    500: { description: "AI error" },
  },
});

registry.registerPath({
  method: "post",
  path: "/a11y/chatbot",
  tags: ["Accessibility", "AI"],
  summary: "AI accessibility chatbot with tool-calling support",
  request: {
    body: {
      content: { "application/json": { schema: ChatbotBodySchema } },
      required: true,
    },
  },
  responses: {
    200: { description: "AI text response, optionally with Places or route data" },
    400: { description: "AI could not generate a response" },
    500: { description: "Internal error" },
  },
});
