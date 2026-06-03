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

// ── Response envelope helper ────────────────────────────────────────────────

const ApiResponseSchema = <T extends z.ZodTypeAny>(data: T) =>
  z.object({
    ok: z.boolean().openapi({ example: true }),
    status: z.enum(["success", "error"]).openapi({ example: "success" }),
    code: z.number().openapi({ example: 200 }),
    message: z.string().openapi({ example: "OK" }),
    data: data.optional(),
    accessToken: z.string().optional(),
  });

// ── Domain schemas ──────────────────────────────────────────────────────────

const CoordinateSchema = z.object({
  latitude: z.number().openapi({ example: 25.0418 }),
  longitude: z.number().openapi({ example: 121.565 }),
});

const GooglePlaceSchema = z.object({
  name: z.string().openapi({ example: "台北101" }),
  place_id: z.string().openapi({ example: "ChIJH56c2rarQjQRphHd9TVbgCo" }),
  formatted_address: z.string().openapi({ example: "110台北市信義區信義路五段7號" }),
  rating: z.number().optional().openapi({ example: 4.5 }),
  location: z
    .object({
      latitude: z.number().openapi({ example: 25.0339 }),
      longitude: z.number().openapi({ example: 121.5645 }),
    })
    .openapi({ description: "Place coordinate" }),
});

const A11yPlaceSchema = z.object({
  _id: z.string().openapi({ example: "65f1a2b3c4d5e6f7a8b9c0d1" }),
  項次: z.string().openapi({ example: "1" }),
  "出入口電梯/無障礙坡道名稱": z.string().openapi({ example: "1號出口電梯" }),
  經度: z.number().openapi({ example: 121.565 }),
  緯度: z.number().openapi({ example: 25.0418 }),
  location: z
    .object({
      type: z.literal("Point").openapi({ example: "Point" }),
      coordinates: z
        .tuple([z.number(), z.number()])
        .openapi({ example: [121.565, 25.0418] }),
    })
    .openapi({ description: "GeoJSON point" }),
});

const BathroomPlaceSchema = z.object({
  _id: z.string().openapi({ example: "65f1a2b3c4d5e6f7a8b9c0d2" }),
  contury: z.string().openapi({ example: "台北市" }),
  areacode: z.string().openapi({ example: "100" }),
  village: z.string().openapi({ example: "黎明里" }),
  number: z.string().openapi({ example: "A001" }),
  name: z.string().openapi({ example: "台北車站無障礙廁所" }),
  address: z.string().openapi({ example: "台北市中正區北平西路3號" }),
  administration: z.string().openapi({ example: "台北市政府" }),
  latitude: z.number().openapi({ example: 25.0478 }),
  longitude: z.number().openapi({ example: 121.517 }),
  grade: z.string().openapi({ example: "特優級" }),
  type2: z.string().openapi({ example: "獨立式" }),
  type: z.string().openapi({ example: "無障礙廁所" }),
  exec: z.string().openapi({ example: "交通部臺灣鐵路管理局" }),
  diaper: z.string().openapi({ example: "有" }),
});

// ── Named response schemas ──────────────────────────────────────────────────

export const AIRankResponseSchema = ApiResponseSchema(
  z.object({
    route_description: z.string().openapi({
      example: "此路線全程無障礙，電梯與坡道皆完善",
    }),
    route_total_score: z.number().openapi({ example: 95 }),
  })
).openapi("AIRankResponse");

export const RouteSelectResponseSchema = ApiResponseSchema(
  z.object({
    route_index: z.number().openapi({ example: 0 }),
  })
).openapi("RouteSelectResponse");

const ChatbotDataSchema = z.object({
  message: z
    .string()
    .openapi({ example: "附近有以下無障礙設施可供參考" }),
  googlePlacesResults: z
    .array(GooglePlaceSchema)
    .optional()
    .openapi({ description: "Present when findGooglePlaces tool was invoked" }),
  a11yPlacesResults: z
    .array(z.union([A11yPlaceSchema, BathroomPlaceSchema]))
    .optional()
    .openapi({ description: "Present when findA11yPlaces tool was invoked" }),
  planRouteResult: z
    .object({
      origin: CoordinateSchema,
      destination: CoordinateSchema,
      travelMode: z.string().optional().openapi({ example: "WALK" }),
    })
    .optional()
    .openapi({ description: "Present when planRoute tool was invoked successfully" }),
});

export const ChatbotResponseSchema = ApiResponseSchema(ChatbotDataSchema).openapi(
  "ChatbotResponse"
);

export const AIErrorResponseSchema = ApiResponseSchema(z.unknown()).openapi(
  "AIErrorResponse"
);

// ── OpenAPI path registrations ──────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/a11y/route-rank",
  tags: ["Accessibility", "AI"],
  summary: "AI route ranking",
  description: "Passes a list of candidate routes to Gemini, which scores and ranks them by wheelchair accessibility based on instructions, duration, and A11y annotations.",
  request: {
    body: {
      content: { "application/json": { schema: RouteRankBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "AI accessibility ranking result",
      content: { "application/json": { schema: AIRankResponseSchema } },
    },
    500: {
      description: "AI error (fallback ranking returned in data)",
      content: { "application/json": { schema: AIRankResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/a11y/route-select",
  tags: ["Accessibility", "AI"],
  summary: "AI best route selection",
  description: "Asks Gemini to pick the single best route from a list and return a plain-language explanation of why it was chosen.",
  request: {
    body: {
      content: { "application/json": { schema: RouteSelectBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Selected route description",
      content: { "application/json": { schema: RouteSelectResponseSchema } },
    },
    500: {
      description: "AI error (fallback returned in data)",
      content: { "application/json": { schema: AIErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/a11y/chatbot",
  tags: ["Accessibility", "AI"],
  summary: "Accessibility AI chatbot",
  description: "Two-step Gemini tool-calling loop. The model may invoke `findGooglePlaces`, `findA11yPlaces`, or `planRoute` before producing its final text response. Supply `lat`/`lng` for location-aware queries.",
  request: {
    body: {
      content: { "application/json": { schema: ChatbotBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "AI text response, optionally with Places or route data",
      content: { "application/json": { schema: ChatbotResponseSchema } },
    },
    400: {
      description: "AI could not generate a response",
      content: { "application/json": { schema: AIErrorResponseSchema } },
    },
    500: {
      description: "Internal error",
      content: { "application/json": { schema: AIErrorResponseSchema } },
    },
  },
});
