import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { registry } from "../../openapi/registry";

extendZodWithOpenApi(z);

const coordString = (label: string) =>
  z.string().regex(/^-?\d+(\.\d+)?$/, `Must be a valid ${label}`);

const PlaceGeoPointSchema = z
  .object({
    type: z.literal("Point").openapi({ example: "Point" }),
    coordinates: z
      .tuple([z.number(), z.number()])
      .openapi({ example: [121.5654, 25.033], description: "[lng, lat]" }),
  })
  .openapi("PlaceGeoPoint");

const AccessibilitySchema = z
  .object({
    status: z
      .enum(["accessible", "limited", "unknown"])
      .openapi({ example: "unknown", description: "無障礙判定：accessible / limited / unknown" }),
    wheelchair: z
      .enum(["yes", "limited", "no"])
      .nullable()
      .openapi({ example: null, description: "輪椅可用性；無資料為 null" }),
    nearbyFacilityCount: z
      .number()
      .int()
      .nonnegative()
      .openapi({ example: 0, description: "本地 DB 半徑內的無障礙設施數" }),
    source: z
      .enum(["local-db", "google", "none"])
      .openapi({ example: "none", description: "無障礙判定的資料來源" }),
  })
  .strict()
  .openapi("PlaceAccessibility");

export const AutocompleteItemSchema = z
  .object({
    placeId: z.string().openapi({ example: "ChIJ..." }),
    primaryText: z.string().openapi({ example: "台北101" }),
    secondaryText: z
      .string()
      .nullable()
      .openapi({ example: "台北市信義區", description: "通常為地址/行政區" }),
  })
  .strict()
  .openapi("AutocompleteItem");

export const PlaceResultSchema = z
  .object({
    id: z.string().openapi({ example: "ChIJ...", description: "穩定 id：google place_id" }),
    source: z
      .enum(["google", "osm", "metro", "campus", "bathroom", "parking", "local"])
      .openapi({ example: "google" }),
    name: z.string().openapi({ example: "台北101" }),
    address: z.string().nullable().openapi({ example: "台北市信義區信義路五段7號" }),
    location: PlaceGeoPointSchema,
    category: z.string().nullable().openapi({ example: null }),
    distanceMeters: z
      .number()
      .nullable()
      .openapi({ example: 1200, description: "帶使用者座標時才計算" }),
    rating: z.number().nullable().openapi({ example: 4.5, description: "Google 才有" }),
    accessibility: AccessibilitySchema,
    attribution: z
      .string()
      .nullable()
      .openapi({ example: "Powered by Google", description: "資料來源授權標註" }),
  })
  .strict()
  .openapi("PlaceResult");

export const AutocompleteQuerySchema = z
  .object({
    q: z.string().min(1).openapi({ example: "台北1", description: "使用者輸入的部分文字" }),
    sessiontoken: z
      .string()
      .optional()
      .openapi({ example: "b2c3d4e5-...", description: "前端產生的 session UUID，綁定計費" }),
    lat: coordString("latitude").optional().openapi({ example: "25.0330" }),
    lng: coordString("longitude").optional().openapi({ example: "121.5654" }),
  })
  .strict();

export const DetailsParamsSchema = z
  .object({
    placeId: z.string().min(1).openapi({ example: "ChIJ..." }),
  })
  .strict();

export const DetailsQuerySchema = z
  .object({
    sessiontoken: z
      .string()
      .optional()
      .openapi({ example: "b2c3d4e5-...", description: "與 autocomplete 相同的 session UUID" }),
    lat: coordString("latitude").optional().openapi({ example: "25.0330" }),
    lng: coordString("longitude").optional().openapi({ example: "121.5654" }),
  })
  .strict();

const ApiResponseSchema = <T extends z.ZodTypeAny>(data: T, refName: string) =>
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

export const AutocompleteResponseSchema = ApiResponseSchema(
  z.array(AutocompleteItemSchema),
  "AutocompleteResponse",
);

export const PlaceDetailsResponseSchema = ApiResponseSchema(
  PlaceResultSchema,
  "PlaceDetailsResponse",
);

registry.registerPath({
  method: "get",
  path: "/a11y/search/autocomplete",
  tags: ["Accessibility"],
  summary: "地點搜尋自動完成",
  description:
    "逐字輸入時呼叫，回傳 Google Places 預測清單（純文字，不含座標或無障礙資訊）。帶 sessiontoken 與後續 details 綁成一次計費。座標偏好可選。",
  request: { query: AutocompleteQuerySchema },
  responses: {
    200: {
      description: "預測清單（Google 失敗時優雅降級為空陣列）",
      content: { "application/json": { schema: AutocompleteResponseSchema } },
    },
    400: { description: "缺少 q 或參數不合法" },
    500: { description: "伺服器錯誤" },
  },
});

registry.registerPath({
  method: "get",
  path: "/a11y/search/details/{placeId}",
  tags: ["Accessibility"],
  summary: "地點詳情與無障礙判定",
  description:
    "使用者點選某筆預測後呼叫，取座標與欄位並就近查本地無障礙資料，回傳單一 PlaceResult（含三態無障礙徽章）。帶與 autocomplete 相同的 sessiontoken 結束該計費 session。",
  request: { params: DetailsParamsSchema, query: DetailsQuerySchema },
  responses: {
    200: {
      description: "地點詳情",
      content: { "application/json": { schema: PlaceDetailsResponseSchema } },
    },
    400: { description: "缺少 placeId 或參數不合法" },
    404: { description: "查無此地點或無可用座標" },
    500: { description: "伺服器錯誤" },
  },
});
