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

// ── Response component schemas ──────────────────────────────────────────────

const OsmA11ySchema = z
  .object({
    osmId: z.string().openapi({ example: "node/123456789" }),
    name: z.string().optional().openapi({ example: "市政府站 2 號出口電梯" }),
    category: z
      .enum(["wheelchair_accessible", "kerb_cut", "ramp", "elevator", "toilet"])
      .openapi({ example: "elevator" }),
    wheelchair: z
      .enum(["yes", "limited", "no"])
      .optional()
      .openapi({ example: "yes" }),
    tags: z
      .record(z.string(), z.string())
      .openapi({ example: { wheelchair: "yes", highway: "elevator" } }),
    location: z
      .object({
        type: z.literal("Point").openapi({ example: "Point" }),
        coordinates: z
          .tuple([z.number(), z.number()])
          .openapi({ example: [121.567, 25.041] }),
      })
      .openapi({ description: "GeoJSON Point [lng, lat]" }),
    importedAt: z
      .string()
      .openapi({ example: "2026-05-01T08:30:00.000Z", description: "ISO date" }),
  })
  .openapi("OsmA11y");

const WalkLegSchema = z
  .object({
    type: z.literal("WALK").openapi({ example: "WALK" }),
    from: z.string().openapi({ example: "起點" }),
    to: z.string().openapi({ example: "市政府站" }),
    distanceM: z.number().openapi({ example: 320 }),
    minutesEst: z.number().openapi({ example: 4 }),
    polyline: z
      .array(z.tuple([z.number(), z.number()]))
      .openapi({ example: [[121.567, 25.041], [121.568, 25.042]] }),
    a11yFacilities: z.array(OsmA11ySchema),
  })
  .openapi("WalkLeg");

const WaitInfoSchema = z
  .object({
    minutes: z.number().nullable().openapi({ example: 6, description: "null = no service today" }),
    source: z
      .enum(["realtime", "schedule", "unavailable"])
      .openapi({ example: "realtime", description: "realtime = TDX ETA, schedule = timetable lookup, unavailable = no data" }),
  })
  .openapi("WaitInfo");

const NearestBusSchema = z
  .object({
    plateNumb: z.string().openapi({ example: "ABC-1234" }),
    position: z
      .tuple([z.number(), z.number()])
      .openapi({ example: [121.567, 25.041], description: "[lng, lat]" }),
    speed: z.number().optional().openapi({ example: 25, description: "km/h" }),
    stopsAway: z.number().optional().openapi({ example: 2, description: "stops before departure stop" }),
  })
  .openapi("NearestBus");

const BusLegSchema = z
  .object({
    type: z.literal("BUS").openapi({ example: "BUS" }),
    routeName: z.string().openapi({ example: "信義幹線" }),
    departureStop: z.string().openapi({ example: "市政府站" }),
    arrivalStop: z.string().openapi({ example: "台北101" }),
    waitInfo: WaitInfoSchema,
    estimatedWaitMinutes: z.number().openapi({ example: 6, description: "waitInfo.minutes ?? 0, kept for backwards compatibility" }),
    direction: z
      .union([z.literal(0), z.literal(1)])
      .openapi({ example: 0, description: "0 = outbound, 1 = inbound" }),
    polyline: z
      .array(z.tuple([z.number(), z.number()]))
      .openapi({ example: [[121.567, 25.041], [121.564, 25.034]] }),
    departureStopA11y: z.array(OsmA11ySchema),
    arrivalStopA11y: z.array(OsmA11ySchema),
    nearestBus: NearestBusSchema.optional(),
  })
  .openapi("BusLeg");

const AccessibleRouteSchema = z
  .object({
    routeId: z.string().openapi({ example: "route-001" }),
    routeName: z.string().openapi({ example: "信義幹線" }),
    totalMinutes: z.number().openapi({ example: 18 }),
    legs: z
      .array(z.discriminatedUnion("type", [WalkLegSchema, BusLegSchema]))
      .openapi({ description: "Ordered legs: walk → bus → walk" }),
    accessibilityHighlights: z
      .array(z.string())
      .openapi({ example: ["全程低地板公車", "出入口設有電梯"] }),
  })
  .openapi("AccessibleRoute");

const AccessibleRouteDataSchema = z
  .object({
    origin: CoordSchema.openapi({ example: { lat: 25.041, lng: 121.567 } }),
    destination: CoordSchema.openapi({ example: { lat: 25.034, lng: 121.564 } }),
    city: z.string().openapi({ example: "Taipei" }),
    routes: z.array(AccessibleRouteSchema),
  })
  .openapi("AccessibleRouteData");

export const AccessibleRouteResponseSchema = z
  .object({
    ok: z.boolean().openapi({ example: true }),
    status: z.enum(["success", "error"]).openapi({ example: "success" }),
    code: z.number().openapi({ example: 200 }),
    message: z.string().openapi({ example: "Accessible routes found" }),
    data: AccessibleRouteDataSchema.optional(),
    accessToken: z.string().optional(),
  })
  .openapi("AccessibleRouteResponse");

export const ErrorResponseSchema = z
  .object({
    ok: z.boolean().openapi({ example: false }),
    status: z.enum(["success", "error"]).openapi({ example: "error" }),
    code: z.number().openapi({ example: 400 }),
    message: z.string().openapi({ example: "Missing params or unresolvable coordinates" }),
    data: z.unknown().optional(),
    accessToken: z.string().optional(),
  })
  .openapi("ErrorResponse");

// ── OpenAPI path registrations ──────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/a11y/accessible-route",
  tags: ["Accessibility"],
  summary: "Accessible bus route plan",
  description: "Finds wheelchair-accessible bus routes between an origin and destination. Each point can be a place name (geocoded via Google Maps) or explicit `{latitude, longitude}` coordinates.",
  request: {
    body: {
      content: { "application/json": { schema: AccessibleRouteBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Accessible route list with bus stops",
      content: { "application/json": { schema: AccessibleRouteResponseSchema } },
    },
    400: {
      description: "Missing params or unresolvable coordinates",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "No connected bus routes found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "Internal error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});
