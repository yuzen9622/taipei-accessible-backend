import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { registry } from "../../openapi/registry";

extendZodWithOpenApi(z);

const CoordSchema = z.object({
  lat: z.number().openapi({ description: "Latitude" }),
  lng: z.number().openapi({ description: "Longitude" }),
});

const PointSchema = z.union([
  z.string().openapi({ description: "Place name to geocode" }),
  z
    .object({
      latitude: z.number(),
      longitude: z.number(),
    })
    .openapi({ description: "Explicit coordinates" }),
]);

export const AccessibleRouteBodySchema = z
  .object({
    origin: PointSchema.optional().openapi({
      description: "Origin — place name or {latitude, longitude}",
    }),
    destination: PointSchema.optional().openapi({
      description: "Destination — place name or {latitude, longitude}",
    }),
    query: z
      .string()
      .min(1)
      .optional()
      .openapi({
        description:
          "Phase 9: natural-language query (e.g. \"我坐輪椅要從台中車站到高鐵新竹站\"). When provided and origin/destination are omitted, it is parsed via /ai/intent to derive origin, destination and mode. `current_location` resolves to userLocation.",
        example: "我坐輪椅要從台中車站到高鐵新竹站",
      }),
    userLocation: z
      .object({ latitude: z.number(), longitude: z.number() })
      .optional()
      .openapi({
        description:
          "User coordinates, used to resolve a `current_location` origin parsed from `query`.",
      }),
    mode: z
      .enum(["wheelchair", "elderly", "visual_impaired", "normal"])
      .optional()
      .openapi({
        description:
          "Phase 11: accessibility mode. Adjusts scoring weights (elderly lifts Tier 1+2; visual_impaired promotes tactile paving / audio signals to critical), transfer penalty (wheelchair ×2, elderly ×1.5) and wheelchair Tier-1 route exclusion. Falls back to the mode parsed from `query`, then \"normal\".",
        example: "wheelchair",
      }),
    maxTransfers: z
      .number()
      .int()
      .min(0)
      .max(2)
      .optional()
      .openapi({
        description:
          "Phase 12: maximum transfers (0–2). Default 1. Two-transfer search runs only when fewer than 3 simpler routes are found.",
        example: 1,
      }),
    departureTime: z
      .string()
      .optional()
      .openapi({
        description:
          "ISO 8601 departure time. Defaults to now. Honoured by the GTFS router path.",
        example: "2026-06-10T08:30:00+08:00",
      }),
    format: z
      .enum(["standard", "compact"])
      .optional()
      .openapi({
        description:
          "Phase 14 response shape. \"standard\" (default): slimmed facility objects inline per leg. \"compact\": facilities additionally deduped into a route-level `facilities` dictionary; legs carry `a11yRefs` (osmId references) and empty facility arrays.",
        example: "standard",
      }),
  })
  .strict()
  .refine((b) => (b.origin && b.destination) || b.query, {
    message: "Provide either origin+destination, or a natural-language query",
  });

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
      .optional()
      .openapi({
        example: { wheelchair: "yes", highway: "elevator" },
        description:
          "Phase 14: whitelisted decision-relevant tags only (scoring keys + name/opening_hours/level/amenity). Omitted when none apply. Full OSM tags via GET /api/a11y/place?osmId=…",
      }),
    location: z
      .object({
        type: z.literal("Point").openapi({ example: "Point" }),
        coordinates: z
          .tuple([z.number(), z.number()])
          .openapi({ example: [121.567, 25.041] }),
      })
      .openapi({ description: "GeoJSON Point [lng, lat]" }),
  })
  .openapi("SlimOsmA11y");

/** Phase 14 compact format: osmId references into route-level `facilities`. */
const A11yRefsSchema = z
  .array(z.string())
  .optional()
  .openapi({
    example: ["12342946149"],
    description:
      "Phase 14 compact format only: osmId keys into the route-level `facilities` dictionary (facility arrays are then empty).",
  });

const WalkLegSchema = z
  .object({
    type: z.literal("WALK").openapi({ example: "WALK" }),
    a11yRefs: A11yRefsSchema,
    from: z.string().openapi({ example: "起點" }),
    to: z.string().openapi({ example: "市政府站" }),
    distanceM: z.number().openapi({ example: 320 }),
    minutesEst: z.number().openapi({ example: 4 }),
    polyline: z.array(z.tuple([z.number(), z.number()])).openapi({
      example: [
        [121.567, 25.041],
        [121.568, 25.042],
      ],
    }),
    a11yFacilities: z.array(OsmA11ySchema),
    exitInfo: z
      .object({
        exitName: z.string(),
        exitNumber: z.string(),
        type: z.enum(["elevator", "ramp"]),
        coords: z.tuple([z.number(), z.number()]),
      })
      .nullable()
      .optional()
      .openapi({
        description:
          "TRTC metro exit (elevator/ramp) used at this walk endpoint; only set on transfer routes",
      }),
  })
  .openapi("WalkLeg");

const WaitInfoSchema = z
  .object({
    minutes: z
      .number()
      .nullable()
      .openapi({ example: 6, description: "null = no service today" }),
    source: z.enum(["realtime", "schedule", "unavailable"]).openapi({
      example: "realtime",
      description:
        "realtime = TDX ETA, schedule = timetable lookup, unavailable = no data",
    }),
  })
  .openapi("WaitInfo");

const NearestBusSchema = z
  .object({
    plateNumb: z.string().openapi({ example: "ABC-1234" }),
    position: z
      .tuple([z.number(), z.number()])
      .openapi({ example: [121.567, 25.041], description: "[lng, lat]" }),
    speed: z.number().optional().openapi({ example: 25, description: "km/h" }),
    stopsAway: z
      .number()
      .optional()
      .openapi({ example: 2, description: "stops before departure stop" }),
  })
  .openapi("NearestBus");

const BusLegSchema = z
  .object({
    type: z.literal("BUS").openapi({ example: "BUS" }),
    a11yRefs: A11yRefsSchema,
    routeName: z.string().openapi({ example: "信義幹線" }),
    departureStop: z.string().openapi({ example: "市政府站" }),
    arrivalStop: z.string().openapi({ example: "台北101" }),
    departureStopId: z.string().optional().openapi({
      example: "TXG2646",
      description:
        "System-prefixed GTFS stop id (GTFS router only); THB… = intercity",
    }),
    arrivalStopId: z.string().optional().openapi({
      example: "TXG3917",
      description: "System-prefixed GTFS stop id (GTFS router only)",
    }),
    cityCode: z.string().optional().openapi({
      example: "NWT",
      description:
        "TDX operator system code (TDX MaaS path only); THB = intercity",
    }),
    departureTime: z.string().optional().openapi({
      example: "21:05",
      description: "HH:mm scheduled next departure (absent when unknown)",
    }),
    arrivalTime: z.string().optional().openapi({
      example: "21:32",
      description: "HH:mm scheduled arrival (absent when unknown)",
    }),
    waitInfo: WaitInfoSchema,
    estimatedWaitMinutes: z.number().openapi({
      example: 6,
      description: "waitInfo.minutes ?? 0, kept for backwards compatibility",
    }),
    direction: z
      .union([z.literal(0), z.literal(1)])
      .openapi({ example: 0, description: "0 = outbound, 1 = inbound" }),
    polyline: z.array(z.tuple([z.number(), z.number()])).openapi({
      example: [
        [121.567, 25.041],
        [121.564, 25.034],
      ],
    }),
    departureStopA11y: z.array(OsmA11ySchema),
    arrivalStopA11y: z.array(OsmA11ySchema),
    nearestBus: NearestBusSchema.optional(),
  })
  .openapi("BusLeg");

const MetroLegSchema = z
  .object({
    type: z.literal("METRO").openapi({ example: "METRO" }),
    a11yRefs: A11yRefsSchema,
    railSystem: z.string().openapi({ example: "TRTC" }),
    lineName: z.string().openapi({ example: "TRTC-R" }),
    lineUid: z.string().openapi({ example: "TRTC-R" }),
    departureStation: z.string().openapi({ example: "市政府站" }),
    arrivalStation: z.string().openapi({ example: "台北車站" }),
    departureStationUid: z.string().openapi({ example: "TRTC-R10" }),
    arrivalStationUid: z.string().openapi({ example: "TRTC-R02" }),
    direction: z.union([z.literal(0), z.literal(1)]).openapi({ example: 0 }),
    stopsCount: z.number().openapi({ example: 5 }),
    rideMinutes: z.number().openapi({ example: 10 }),
    departureTime: z.string().optional().openapi({
      example: "21:05",
      description: "HH:mm scheduled next departure (absent when unknown)",
    }),
    arrivalTime: z.string().optional().openapi({
      example: "21:15",
      description: "HH:mm scheduled arrival (absent when unknown)",
    }),
    waitInfo: WaitInfoSchema,
    estimatedWaitMinutes: z.number().openapi({ example: 3 }),
    polyline: z.array(z.tuple([z.number(), z.number()])).openapi({
      example: [
        [121.567, 25.041],
        [121.555, 25.047],
      ],
    }),
    departureStationA11y: z.array(OsmA11ySchema),
    arrivalStationA11y: z.array(OsmA11ySchema),
    facilityHighlights: z
      .array(z.string())
      .openapi({ example: ["乘車站有電梯", "下車站有無障礙廁所"] }),
  })
  .openapi("MetroLeg");

const ThsrLegSchema = z
  .object({
    type: z.literal("THSR").openapi({ example: "THSR" }),
    a11yRefs: A11yRefsSchema,
    trainNo: z.string().openapi({ example: "0617" }),
    departureStation: z.string().openapi({ example: "台北" }),
    arrivalStation: z.string().openapi({ example: "台中" }),
    departureStationUID: z.string().openapi({ example: "THSR-1000" }),
    arrivalStationUID: z.string().openapi({ example: "THSR-1040" }),
    departureTime: z.string().openapi({ example: "09:00", description: "HH:mm" }),
    arrivalTime: z.string().openapi({ example: "09:47", description: "HH:mm" }),
    rideMinutes: z.number().openapi({ example: 47 }),
    waitInfo: WaitInfoSchema,
    estimatedWaitMinutes: z.number().openapi({ example: 8 }),
    polyline: z.array(z.tuple([z.number(), z.number()])).openapi({
      example: [
        [121.516, 25.013],
        [120.684, 24.178],
      ],
      description: "[boardStation, alightStation] only — two-point line",
    }),
    departureStationA11y: z.array(OsmA11ySchema),
    arrivalStationA11y: z.array(OsmA11ySchema),
    facilityHighlights: z
      .array(z.string())
      .openapi({ example: ["高鐵站設有無障礙設施", "列車備有無障礙座位及輪椅空間"] }),
  })
  .openapi("ThsrLeg");

const TraLegSchema = z
  .object({
    type: z.literal("TRA").openapi({ example: "TRA" }),
    a11yRefs: A11yRefsSchema,
    trainNo: z.string().openapi({ example: "0131" }),
    trainTypeName: z.string().openapi({
      example: "自強",
      description: "Train type in Chinese, e.g. 自強, 莒光, 區間車",
    }),
    departureStation: z.string().openapi({ example: "台北" }),
    arrivalStation: z.string().openapi({ example: "基隆" }),
    departureStationUID: z.string().openapi({ example: "TRA-0900" }),
    arrivalStationUID: z.string().openapi({ example: "TRA-0900H" }),
    departureTime: z.string().openapi({ example: "08:30", description: "HH:mm" }),
    arrivalTime: z.string().openapi({ example: "09:02", description: "HH:mm" }),
    rideMinutes: z.number().openapi({ example: 32 }),
    waitInfo: WaitInfoSchema,
    estimatedWaitMinutes: z.number().openapi({ example: 12 }),
    polyline: z.array(z.tuple([z.number(), z.number()])).openapi({
      example: [
        [121.516, 25.013],
        [121.74, 25.13],
      ],
      description: "[boardStation, alightStation] only — two-point line",
    }),
    departureStationA11y: z.array(OsmA11ySchema),
    arrivalStationA11y: z.array(OsmA11ySchema),
    facilityHighlights: z
      .array(z.string())
      .openapi({ example: ["臺鐵自強 列車", "乘車站附近有電梯"] }),
  })
  .openapi("TraLeg");

const ScoreComponentsSchema = z
  .object({
    facilityScore: z.number().openapi({
      example: 72,
      description:
        "0–100: weighted quality of OSM accessibility facilities at all stops",
    }),
    timeScore: z.number().openapi({
      example: 85,
      description: "0–100: normalized travel time (100 = fastest candidate)",
    }),
    criticalFeatureScore: z.number().openapi({
      example: 65,
      description:
        "0–100: presence of Tier 1 critical features (elevator, flush kerb, ramp)",
    }),
  })
  .openapi("ScoreComponents");

const AccessibleRouteSchema = z
  .object({
    routeId: z.string().openapi({ example: "route-001" }),
    routeName: z.string().openapi({ example: "信義幹線" }),
    totalMinutes: z.number().openapi({ example: 18 }),
    transferCount: z
      .number()
      .openapi({ example: 0, description: "0=direct, 1=one transfer, 2=two transfers" }),
    legs: z
      .array(
        z.discriminatedUnion("type", [
          WalkLegSchema,
          BusLegSchema,
          MetroLegSchema,
          ThsrLegSchema,
          TraLegSchema,
        ]),
      )
      .openapi({ description: "Ordered legs: walk → transit → walk. Transit leg type is BUS, METRO, THSR, or TRA." }),
    accessibilityHighlights: z
      .array(z.string())
      .openapi({ example: ["全程低地板公車", "出入口設有電梯"] }),
    accessibilityScore: z
      .number()
      .optional()
      .openapi({
        example: 74,
        description:
          "0–100 evidence-based route accessibility score. " +
          "65% accessibility (facility quality + critical features) + 35% travel time. " +
          "≥80 Excellent, 60–79 Good, 40–59 Fair, 20–39 Poor, <20 Critical.",
      }),
    accessibilityLabel: z
      .enum(["excellent", "good", "fair", "poor", "critical"])
      .optional()
      .openapi({
        example: "good",
        description: "Human-readable label for accessibilityScore",
      }),
    scoreComponents: ScoreComponentsSchema.optional().openapi({
      description: "Breakdown of the accessibilityScore into sub-components",
    }),
    facilities: z
      .record(z.string(), OsmA11ySchema)
      .optional()
      .openapi({
        description:
          "Phase 14 compact format only: deduped facility dictionary keyed by osmId. Legs reference entries via `a11yRefs`.",
      }),
  })
  .openapi("AccessibleRoute");

const AccessibleRouteDataSchema = z
  .object({
    origin: CoordSchema.openapi({ example: { lat: 25.041, lng: 121.567 } }),
    destination: CoordSchema.openapi({
      example: { lat: 25.034, lng: 121.564 },
    }),
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
    message: z
      .string()
      .openapi({ example: "Missing params or unresolvable coordinates" }),
    data: z.unknown().optional(),
    accessToken: z.string().optional(),
  })
  .openapi("ErrorResponse");

// ── OpenAPI path registrations ──────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/a11y/accessible-route",
  tags: ["Accessibility"],
  summary: "Accessible transit route plan",
  description:
    "Finds wheelchair-accessible routes between an origin and destination. Searches bus (city/inter-city), MRT metro, THSR high-speed rail, and TRA Taiwan Railways concurrently. Each point can be a place name (geocoded via Google Maps) or explicit `{latitude, longitude}` coordinates. Returns up to 3 candidates ranked by a composite accessibility score (65% facility quality + 35% travel time). Transit leg type is one of `BUS`, `METRO`, `THSR`, or `TRA`.",
  request: {
    body: {
      content: { "application/json": { schema: AccessibleRouteBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description:
        "Up to 3 accessible routes (BUS / METRO / THSR / TRA) ranked by accessibility score",
      content: {
        "application/json": { schema: AccessibleRouteResponseSchema },
      },
    },
    400: {
      description: "Missing params or unresolvable coordinates",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "No connected bus, metro, THSR, or TRA routes found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "Internal error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});
