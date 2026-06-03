import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { registry } from "../../openapi/registry";

extendZodWithOpenApi(z);

export const BusBodySchema = z
  .object({
    route_name: z.string().min(1).openapi({ example: "299" }),
    arrival_stop: z.string().min(1).openapi({ example: "台北車站" }),
    departure_stop: z.string().min(1).openapi({ example: "忠孝復興" }),
    arrival_lat: z.number().openapi({ example: 25.0478 }),
    arrival_lng: z.number().openapi({ example: 121.5171 }),
    language: z
      .enum(["Zh_tw", "En"])
      .default("Zh_tw")
      .openapi({ description: "Response language" }),
  })
  .strict();

export const BusRealtimeQuerySchema = z
  .object({
    plate_number: z
      .string()
      .regex(/^[\w-]{1,15}$/, "Invalid plate number")
      .openapi({ example: "KKA-1234" }),
    arrival_lat: z
      .string()
      .regex(/^-?\d+(\.\d+)?$/)
      .openapi({ example: "25.0478" }),
    arrival_lng: z
      .string()
      .regex(/^-?\d+(\.\d+)?$/)
      .openapi({ example: "121.5171" }),
    route_name: z.string().min(1).openapi({ example: "299" }),
  })
  .strict();

// ── OpenAPI path registrations ──────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/transit/bus",
  tags: ["Transit"],
  summary: "Get bus arrival estimates for a stop on a route",
  request: {
    body: {
      content: { "application/json": { schema: BusBodySchema } },
      required: true,
    },
  },
  responses: {
    200: { description: "Real-time bus arrival data from TDX" },
    400: { description: "Missing parameters or unrecognised route direction" },
    500: { description: "TDX API error" },
  },
});

registry.registerPath({
  method: "get",
  path: "/transit/bus/realtime",
  tags: ["Transit"],
  summary: "Get real-time GPS position of a specific bus by plate number",
  request: {
    query: BusRealtimeQuerySchema,
  },
  responses: {
    200: { description: "Real-time bus location data" },
    400: { description: "Missing or invalid parameters" },
    500: { description: "TDX API error" },
  },
});
