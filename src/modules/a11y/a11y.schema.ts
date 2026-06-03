import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { registry } from "../../openapi/registry";

extendZodWithOpenApi(z);

export const NearbyA11yQuerySchema = z
  .object({
    lat: z
      .string()
      .regex(/^-?\d+(\.\d+)?$/, "Must be a valid latitude")
      .openapi({ example: "25.0330" }),
    lng: z
      .string()
      .regex(/^-?\d+(\.\d+)?$/, "Must be a valid longitude")
      .openapi({ example: "121.5654" }),
  })
  .strict();

// ── OpenAPI path registrations ──────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/a11y/all-places",
  tags: ["Accessibility"],
  summary: "Get all accessibility places (MRT elevators / ramps)",
  responses: {
    200: { description: "List of all A11y places" },
  },
});

registry.registerPath({
  method: "get",
  path: "/a11y/all-bathrooms",
  tags: ["Accessibility"],
  summary: "Get all accessible bathrooms",
  responses: {
    200: { description: "List of accessible bathrooms" },
  },
});

registry.registerPath({
  method: "get",
  path: "/a11y/nearby-a11y",
  tags: ["Accessibility"],
  summary: "Find accessibility facilities within 150 m",
  request: {
    query: NearbyA11yQuerySchema,
  },
  responses: {
    200: { description: "Nearby MRT A11y, bathrooms, and OSM data" },
    400: { description: "Missing or invalid lat/lng" },
  },
});
