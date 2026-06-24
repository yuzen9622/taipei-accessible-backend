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
          "OSM 設施 id，可用逗號分隔做批次查詢（如「123,456」）",
      }),
  })
  .strict();

export const ParkingNearbyQuerySchema = z
  .object({
    lat: z
      .string()
      .regex(/^-?\d+(\.\d+)?$/, "Must be a valid latitude")
      .openapi({ example: "25.1500" }),
    lng: z
      .string()
      .regex(/^-?\d+(\.\d+)?$/, "Must be a valid longitude")
      .openapi({ example: "121.4000" }),
    radius: z
      .string()
      .regex(/^\d+$/, "Must be a positive integer (metres)")
      .optional()
      .openapi({ example: "300", description: "搜尋半徑（公尺），預設 300" }),
  })
  .strict();

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
    county: z.string().openapi({ example: "臺北市" }),
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

export const DisabledParkingSchema = z
  .object({
    _id: z.string().openapi({ example: "66a1f2c3e4b5a6d7c8e9f0c3" }),
    city: z.string().openapi({ example: "新北市" }),
    district: z.string().openapi({ example: "八里區" }),
    areacode: z.string().optional().openapi({ example: "65000230" }),
    quantity: z.number().openapi({ example: 1 }),
    placeName: z.string().openapi({ example: "商港八路" }),
    chargeType: z.string().optional().openapi({ example: "假日計時收費" }),
    spaceLabel: z.string().optional().openapi({ example: "身汽1" }),
    isMarked: z.boolean().openapi({ example: true }),
    latitude: z.number().openapi({ example: 25.1043 }),
    longitude: z.number().openapi({ example: 121.4011 }),
    location: GeoPointSchema,
    importedAt: z.string().openapi({ example: "2026-06-24T00:00:00.000Z" }),
  })
  .openapi("DisabledParking");

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
    nearbyParking: z.array(DisabledParkingSchema),
  })
  .openapi("NearbyA11yData");

export const NearbyA11yResponseSchema = ApiResponseSchema(
  NearbyA11yDataSchema,
  "NearbyA11yResponse"
);

registry.registerPath({
  method: "get",
  path: "/a11y/all-places",
  tags: ["Accessibility"],
  summary: "所有無障礙地點",
  description: "回傳資料庫中所有捷運電梯與坡道資料，不分頁。",
  responses: {
    200: {
      description: "無障礙地點清單",
      content: { "application/json": { schema: AllPlacesResponseSchema } },
    },
    500: { description: "伺服器錯誤" },
  },
});

registry.registerPath({
  method: "get",
  path: "/a11y/all-bathrooms",
  tags: ["Accessibility"],
  summary: "所有無障礙廁所",
  description: "回傳資料庫中所有無障礙廁所資料，不分頁。",
  responses: {
    200: {
      description: "無障礙廁所清單",
      content: { "application/json": { schema: AllBathroomsResponseSchema } },
    },
    500: { description: "伺服器錯誤" },
  },
});

registry.registerPath({
  method: "get",
  path: "/a11y/nearby-a11y",
  tags: ["Accessibility"],
  summary: "鄰近無障礙設施",
  description:
    "回傳指定座標 150 公尺內的捷運無障礙出口、廁所、OSM 節點與身障停車格。",
  request: {
    query: NearbyA11yQuerySchema,
  },
  responses: {
    200: {
      description: "鄰近無障礙、廁所、OSM 與停車格資料",
      content: { "application/json": { schema: NearbyA11yResponseSchema } },
    },
    400: { description: "缺少或無效的經緯度" },
    500: { description: "伺服器錯誤" },
  },
});

export const ParkingNearbyResponseSchema = ApiResponseSchema(
  z.array(DisabledParkingSchema),
  "ParkingNearbyResponse"
);

registry.registerPath({
  method: "get",
  path: "/a11y/parking/nearby",
  tags: ["Accessibility"],
  summary: "鄰近身障停車格",
  description:
    "回傳指定座標附近的身障汽車停車格（預設半徑 300 公尺，可用 radius 覆寫）。",
  request: {
    query: ParkingNearbyQuerySchema,
  },
  responses: {
    200: {
      description: "鄰近身障停車格清單",
      content: { "application/json": { schema: ParkingNearbyResponseSchema } },
    },
    400: { description: "缺少或無效的經緯度" },
    500: { description: "伺服器錯誤" },
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
  summary: "OSM 設施完整詳情",
  description:
    "依 osmId 回傳完整 OsmA11y 文件（含所有標籤），支援逗號分隔批次查詢。",
  request: {
    query: A11yPlaceQuerySchema,
  },
  responses: {
    200: {
      description: "完整設施文件",
      content: { "application/json": { schema: A11yPlaceResponseSchema } },
    },
    400: { description: "缺少 osmId" },
    404: { description: "查無對應設施" },
    500: { description: "伺服器錯誤" },
  },
});
