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

export const A11yPlaceQuerySchema = z
  .object({
    osmId: z
      .string()
      .min(1)
      .openapi({
        example: "12342946149",
        description:
          "OSM facility id(s); comma-separated for batch lookup (e.g. \"123,456\")",
      }),
  })
  .strict();

// ── Domain schemas ──────────────────────────────────────────────────────────

const GeoPointSchema = z
  .object({
    type: z.literal("Point").openapi({ example: "Point" }),
    coordinates: z
      .tuple([z.number(), z.number()])
      .openapi({ example: [121.5654, 25.033] }),
  })
  .openapi("GeoPoint");

export const A11ySchema = z
  .object({
    _id: z.string().openapi({ example: "66a1f2c3e4b5a6d7c8e9f0a1" }),
    項次: z.string().openapi({ example: "1" }),
    "出入口電梯/無障礙坡道名稱": z
      .string()
      .openapi({ example: "台北車站 M8 出口電梯" }),
    經度: z.number().openapi({ example: 121.5170 }),
    緯度: z.number().openapi({ example: 25.0478 }),
    location: GeoPointSchema,
  })
  .openapi("A11y");

export const BathroomSchema = z
  .object({
    _id: z.string().openapi({ example: "66a1f2c3e4b5a6d7c8e9f0b2" }),
    contury: z.string().openapi({ example: "臺北市" }),
    areacode: z.string().openapi({ example: "100" }),
    village: z.string().openapi({ example: "黎明里" }),
    number: z.string().openapi({ example: "A001" }),
    name: z.string().openapi({ example: "台北車站無障礙廁所" }),
    address: z.string().openapi({ example: "臺北市中正區忠孝西路一段49號" }),
    administration: z.string().openapi({ example: "臺北市政府" }),
    latitude: z.number().openapi({ example: 25.0478 }),
    longitude: z.number().openapi({ example: 121.5170 }),
    grade: z.string().openapi({ example: "特優級" }),
    type2: z.string().openapi({ example: "公共場所" }),
    type: z.string().openapi({ example: "無障礙廁所" }),
    exec: z.string().openapi({ example: "臺北市政府環境保護局" }),
    diaper: z.string().openapi({ example: "有" }),
  })
  .openapi("Bathroom");

export const OsmA11ySchema = z
  .object({
    osmId: z.string().openapi({ example: "node/1234567890" }),
    name: z.string().optional().openapi({ example: "無障礙坡道" }),
    category: z
      .enum(["wheelchair_accessible", "kerb_cut", "ramp", "elevator", "toilet"])
      .openapi({ example: "ramp" }),
    wheelchair: z
      .enum(["yes", "limited", "no"])
      .optional()
      .openapi({ example: "yes" }),
    tags: z
      .record(z.string(), z.string())
      .openapi({ example: { wheelchair: "yes", highway: "elevator" } }),
    location: GeoPointSchema,
    importedAt: z
      .string()
      .openapi({ example: "2026-06-01T00:00:00.000Z" }),
  })
  .openapi("OsmA11y");

// ── Response envelope helper ─────────────────────────────────────────────────

const ApiResponseSchema = <T extends z.ZodTypeAny>(
  data: T,
  refName: string
) =>
  z
    .object({
      ok: z.boolean().openapi({ example: true }),
      status: z.enum(["success", "error"]).openapi({ example: "success" }),
      code: z.number().openapi({ example: 200 }),
      message: z.string().openapi({ example: "OK" }),
      data: data.optional(),
      accessToken: z.string().optional(),
    })
    .openapi(refName);

// ── Response schemas ─────────────────────────────────────────────────────────

export const AllPlacesResponseSchema = ApiResponseSchema(
  z.array(A11ySchema),
  "AllPlacesResponse"
);

export const AllBathroomsResponseSchema = ApiResponseSchema(
  z.array(BathroomSchema),
  "AllBathroomsResponse"
);

export const NearbyA11yDataSchema = z
  .object({
    nearbyMetroA11y: z.array(A11ySchema),
    nearbyBathroom: z.array(BathroomSchema),
    nearbyOsm: z.array(OsmA11ySchema),
  })
  .openapi("NearbyA11yData");

export const NearbyA11yResponseSchema = ApiResponseSchema(
  NearbyA11yDataSchema,
  "NearbyA11yResponse"
);

// ── OpenAPI path registrations ──────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/a11y/all-places",
  tags: ["Accessibility"],
  summary: "List all A11y places",
  description: "Returns every MRT elevator and ramp entry stored in the database (no pagination). Useful for bulk client-side filtering or map rendering.",
  responses: {
    200: {
      description: "List of A11y places",
      content: { "application/json": { schema: AllPlacesResponseSchema } },
    },
    500: { description: "Server error" },
  },
});

registry.registerPath({
  method: "get",
  path: "/a11y/all-bathrooms",
  tags: ["Accessibility"],
  summary: "List all accessible bathrooms",
  description: "Returns every accessible bathroom entry stored in the database (no pagination).",
  responses: {
    200: {
      description: "List of accessible bathrooms",
      content: { "application/json": { schema: AllBathroomsResponseSchema } },
    },
    500: { description: "Server error" },
  },
});

registry.registerPath({
  method: "get",
  path: "/a11y/nearby-a11y",
  tags: ["Accessibility"],
  summary: "Nearby accessibility facilities",
  description: "Returns MRT A11y exits, accessible bathrooms, and OSM wheelchair nodes within 150 m of the supplied coordinates.",
  request: {
    query: NearbyA11yQuerySchema,
  },
  responses: {
    200: {
      description: "Nearby MRT A11y, bathrooms, and OSM data",
      content: { "application/json": { schema: NearbyA11yResponseSchema } },
    },
    400: { description: "Missing or invalid lat/lng" },
    500: { description: "Server error" },
  },
});

export const A11yPlaceResponseSchema = ApiResponseSchema(
  z.array(OsmA11ySchema),
  "A11yPlaceResponse"
);

registry.registerPath({
  method: "get",
  path: "/a11y/place",
  tags: ["Accessibility"],
  summary: "Full OSM facility detail (Phase 14)",
  description:
    "Returns the complete OsmA11y document(s) — all OSM tags included — for the given osmId(s). Route responses (/a11y/accessible-route) carry slimmed facility objects with whitelisted tags only; use this endpoint when the full record is needed. `osmId` accepts a comma-separated list for batch lookup.",
  request: {
    query: A11yPlaceQuerySchema,
  },
  responses: {
    200: {
      description: "Full facility document(s)",
      content: { "application/json": { schema: A11yPlaceResponseSchema } },
    },
    400: { description: "Missing osmId" },
    404: { description: "No facility found for the given id(s)" },
    500: { description: "Server error" },
  },
});
