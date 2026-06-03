import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { registry } from "../../openapi/registry";

extendZodWithOpenApi(z);

const CoordSchema = z.object({
  lat: z.number().openapi({ description: "Latitude" }),
  lng: z.number().openapi({ description: "Longitude" }),
});

export const AccessibleRouteBodySchema = z
  .object({
    origin: z
      .union([
        z.string().openapi({ description: "Place name to geocode" }),
        CoordSchema.extend({
          latitude: z.number(),
          longitude: z.number(),
        }).openapi({ description: "Explicit coordinates" }),
      ])
      .openapi({ description: "Origin — place name or {latitude, longitude}" }),
    destination: z
      .union([
        z.string().openapi({ description: "Place name to geocode" }),
        CoordSchema.extend({
          latitude: z.number(),
          longitude: z.number(),
        }).openapi({ description: "Explicit coordinates" }),
      ])
      .openapi({ description: "Destination — place name or {latitude, longitude}" }),
  })
  .strict();

// ── OpenAPI path registrations ──────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/a11y/accessible-route",
  tags: ["Accessibility"],
  summary: "Find accessible bus routes between two points",
  request: {
    body: {
      content: { "application/json": { schema: AccessibleRouteBodySchema } },
      required: true,
    },
  },
  responses: {
    200: { description: "Accessible route list with bus stops" },
    400: { description: "Missing params or unresolvable coordinates" },
    404: { description: "No connected bus routes found" },
    500: { description: "Internal error" },
  },
});
