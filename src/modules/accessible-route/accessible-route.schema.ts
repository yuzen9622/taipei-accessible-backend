import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { registry } from "../../openapi/registry";
import { RouteIntentSchema } from "../ai/ai.schema";

extendZodWithOpenApi(z);

const CoordSchema = z.object({
  lat: z.number().openapi({ description: "緯度" }),
  lng: z.number().openapi({ description: "經度" }),
});

const PointSchema = z.union([
  z.string().openapi({ description: "待地理編碼的地點名稱" }),
  z
    .object({
      latitude: z.number(),
      longitude: z.number(),
    })
    .openapi({ description: "明確的經緯度座標" }),
]);

export const AccessibleRouteBodySchema = z
  .object({
    origin: PointSchema.optional().openapi({
      description: "起點 — 地點名稱或 {latitude, longitude}",
    }),
    destination: PointSchema.optional().openapi({
      description: "終點 — 地點名稱或 {latitude, longitude}",
    }),
    query: z
      .preprocess(
        // Clients send query: "" when using origin/destination — treat as absent
        (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
        z.string().min(1).optional(),
      )
      .openapi({
        description:
          "自然語言查詢（如「我坐輪椅要從台中車站到高鐵新竹站」）。提供且省略起訖點時，會經 /ai/intent 解析出起點、終點與模式；current_location 對應 userLocation。",
        example: "我坐輪椅要從台中車站到高鐵新竹站",
      }),
    userLocation: z
      .object({ latitude: z.number(), longitude: z.number() })
      .optional()
      .openapi({
        description:
          "使用者座標，用於解析 query 中的 current_location 起點。",
      }),
    mode: z
      .enum(["wheelchair", "elderly", "visual_impaired", "normal"])
      .optional()
      .openapi({
        description:
          "無障礙模式。調整評分權重（elderly 提升 Tier 1+2；visual_impaired 將導盲磚／語音號誌列為關鍵）、轉乘懲罰（wheelchair ×2、elderly ×1.5）與輪椅 Tier-1 路線排除；未填時沿用 query 解析結果，再退回 normal。",
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
          "最大轉乘次數（0–2），預設 1；少於 3 條較簡單路線時才啟動兩次轉乘搜尋。",
        example: 1,
      }),
    departureTime: z
      .string()
      .optional()
      .openapi({
        description:
          "ISO 8601 出發時間，預設為現在；GTFS 路徑會採用，過去或無效時間視為現在。",
        example: "2026-06-10T08:30:00+08:00",
      }),
    format: z
      .enum(["standard", "compact"])
      .optional()
      .openapi({
        description:
          "回應格式。standard（預設）每段內嵌精簡設施物件；compact 另將設施去重為路線層級 facilities 字典，各段改帶 a11yRefs（osmId 參照）且設施陣列為空。",
        example: "standard",
      }),
  })
  .strict()
  .refine((b) => (b.origin && b.destination) || b.query, {
    message: "請提供 origin+destination，或自然語言 query",
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
          "僅保留與判斷相關的白名單標籤（評分鍵與 name/opening_hours/level/amenity），無適用時省略；完整 OSM 標籤見 GET /api/a11y/place?osmId=…",
      }),
    location: z
      .object({
        type: z.literal("Point").openapi({ example: "Point" }),
        coordinates: z
          .tuple([z.number(), z.number()])
          .openapi({ example: [121.567, 25.041] }),
      })
      .openapi({ description: "GeoJSON 點位 [lng, lat]" }),
  })
  .openapi("SlimOsmA11y");

/** Phase 14 compact format: osmId references into route-level `facilities`. */
const A11yRefsSchema = z
  .array(z.string())
  .optional()
  .openapi({
    example: ["12342946149"],
    description:
      "僅 compact 格式：對應路線層級 facilities 字典的 osmId 鍵（此時各段設施陣列為空）。",
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
          "此步行端點使用的北捷出口（電梯／坡道），僅轉乘路線會設定",
      }),
  })
  .openapi("WalkLeg");

const WaitInfoSchema = z
  .object({
    time: z
      .union([z.number(), z.string()])
      .nullable()
      .openapi({
        example: "14:34",
        description:
          'realtime → number（距離到站的分鐘數）；schedule → "HH:mm" 班表發車時間' +
          "（捷運等純班距服務為 number 期望等待）；null = 今日無班次",
      }),
    source: z.enum(["realtime", "schedule", "unavailable"]).openapi({
      example: "schedule",
      description:
        "realtime = TDX 即時 ETA, schedule = 班表, unavailable = 末班已過/未營運",
    }),
  })
  .openapi("WaitInfo");

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
        "含系統前綴的 GTFS 站牌 id（僅 GTFS 路徑）；THB… 為公路客運",
    }),
    arrivalStopId: z.string().optional().openapi({
      example: "TXG3917",
      description: "含系統前綴的 GTFS 站牌 id（僅 GTFS 路徑）",
    }),
    departureTime: z.string().optional().openapi({
      example: "21:05",
      description: "HH:mm 預定發車時間（未知時省略）",
    }),
    arrivalTime: z.string().optional().openapi({
      example: "21:32",
      description: "HH:mm 預定到站時間（未知時省略）",
    }),
    waitInfo: WaitInfoSchema,
    estimatedWaitMinutes: z.number().openapi({
      example: 6,
      description: "數值化的等待估計（分鐘），保留供向後相容與排序計算",
    }),
    direction: z
      .union([z.literal(0), z.literal(1)])
      .openapi({ example: 0, description: "0 = 去程，1 = 返程" }),
    polyline: z.array(z.tuple([z.number(), z.number()])).openapi({
      example: [
        [121.567, 25.041],
        [121.564, 25.034],
      ],
    }),
    departureStopA11y: z.array(OsmA11ySchema),
    arrivalStopA11y: z.array(OsmA11ySchema),
    tdxCity: z.string().optional().openapi({
      example: "NewTaipei",
      description:
        "TDX City 路徑段，前端用來「另外打」RealTimeByFrequency 即時車輛位置 " +
        "（tdxCity + routeName + direction）做持續追蹤；公路客運（THB）無城市路徑、省略此欄。",
    }),
  })
  .openapi("BusLeg");

const MetroLegSchema = z
  .object({
    type: z.literal("METRO").openapi({ example: "METRO" }),
    a11yRefs: A11yRefsSchema,
    railSystem: z.string().openapi({ example: "TRTC" }),
    lineId: z.string().openapi({
      example: "R",
      description: "路線代碼，前端用來上色/標示（紅線 R、藍線 BL、綠線 G、橘線 O、棕線 BR…）",
    }),
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
      description: "HH:mm 預定發車時間（未知時省略）",
    }),
    arrivalTime: z.string().optional().openapi({
      example: "21:15",
      description: "HH:mm 預定到站時間（未知時省略）",
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
      description: "僅 [上車站, 下車站] 兩點連線",
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
      description: "列車種類，如 自強、莒光、區間車",
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
      description: "僅 [上車站, 下車站] 兩點連線",
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
        "0–100：各站 OSM 無障礙設施的加權品質",
    }),
    timeScore: z.number().openapi({
      example: 85,
      description: "0–100：正規化的行程時間（100 = 最快候選）",
    }),
    criticalFeatureScore: z.number().openapi({
      example: 65,
      description:
        "0–100：Tier 1 關鍵設施（電梯、平接緣石、坡道）的具備程度",
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
      .openapi({ example: 0, description: "0=直達，1=轉乘一次，2=轉乘兩次" }),
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
      .openapi({ description: "依序的路段：步行 → 大眾運輸 → 步行；運輸段類型為 BUS、METRO、THSR 或 TRA。" }),
    accessibilityHighlights: z
      .array(z.string())
      .openapi({ example: ["全程低地板公車", "出入口設有電梯"] }),
    accessibilityScore: z
      .number()
      .optional()
      .openapi({
        example: 74,
        description:
          "0–100 以實證為基礎的路線無障礙分數。" +
          "65% 無障礙（設施品質＋關鍵設施）＋35% 行程時間。" +
          "≥80 優、60–79 良、40–59 普通、20–39 差、<20 危險。",
      }),
    accessibilityLabel: z
      .enum(["excellent", "good", "fair", "poor", "critical"])
      .optional()
      .openapi({
        example: "good",
        description: "accessibilityScore 的可讀標籤",
      }),
    scoreComponents: ScoreComponentsSchema.optional().openapi({
      description: "accessibilityScore 的子項目拆解",
    }),
    facilities: z
      .record(z.string(), OsmA11ySchema)
      .optional()
      .openapi({
        description:
          "僅 compact 格式：以 osmId 為鍵、去重後的設施字典；各段透過 a11yRefs 參照。",
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
    intent: RouteIntentSchema.optional().openapi({
      description:
        "僅當請求使用自然語言 query 時出現；包含由查詢解析出的 RouteIntent（起點、終點、模式、出發時間、偏好）。",
    }),
  })
  .openapi("AccessibleRouteData");

export const AccessibleRouteResponseSchema = z
  .object({
    ok: z.boolean().openapi({ example: true }),
    status: z.enum(["success", "error"]).openapi({ example: "success" }),
    code: z.number().openapi({ example: 200 }),
    message: z.string().openapi({ example: "已找到無障礙路線" }),
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
      .openapi({ example: "缺少參數或座標無法解析" }),
    data: z.unknown().optional(),
    accessToken: z.string().optional(),
  })
  .openapi("ErrorResponse");

// ── OpenAPI path registrations ──────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/a11y/accessible-route",
  tags: ["Accessibility"],
  summary: "無障礙路線規劃",
  description:
    "規劃起訖點間無障礙路線，並行搜尋公車、捷運、高鐵與台鐵，回傳最多 3 筆。",
  request: {
    body: {
      content: { "application/json": { schema: AccessibleRouteBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description:
        "依無障礙分數排序的最多 3 筆路線（公車／捷運／高鐵／台鐵）",
      content: {
        "application/json": { schema: AccessibleRouteResponseSchema },
      },
    },
    400: {
      description: "缺少參數或座標無法解析",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "查無相連的公車、捷運、高鐵或台鐵路線",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "伺服器錯誤",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});
