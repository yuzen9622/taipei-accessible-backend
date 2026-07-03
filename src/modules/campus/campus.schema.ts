import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { registry } from "../../openapi/registry";

extendZodWithOpenApi(z);

export const CampusNearbyQuerySchema = z
  .object({
    lat: z.coerce.number().min(-90).max(90).openapi({ example: 25.05 }),
    lng: z.coerce.number().min(-180).max(180).openapi({ example: 121.51 }),
    radius: z.coerce
      .number()
      .int()
      .min(100)
      .max(20000)
      .default(1000)
      .openapi({ example: 1000, description: "搜尋半徑（公尺），預設 1000" }),
    facType: z
      .string()
      .optional()
      .openapi({ example: "無障礙電梯", description: "設施類型（中文），例如 無障礙電梯 / 無障礙廁所" }),
  })
  .strict();

export const CampusListQuerySchema = z
  .object({
    city: z.string().optional().openapi({ example: "臺北市" }),
    facType: z
      .string()
      .optional()
      .openapi({ example: "無障礙電梯", description: "設施類型（中文）" }),
    keyword: z
      .string()
      .optional()
      .openapi({ example: "臺北", description: "對校名 / 校區名的模糊比對" }),
    page: z.coerce.number().int().min(1).default(1).openapi({ example: 1 }),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .openapi({ example: 20, description: "每頁筆數，預設 20，上限 100" }),
  })
  .strict();

export const CampusParamsSchema = z.object({
  branchId: z.coerce
    .number()
    .int()
    .openapi({ example: -2147483633, description: "校區 branchId（整數，可為負數）" }),
}).strict();

const GeoPointSchema = z.object({
  type: z.literal("Point"),
  coordinates: z.tuple([z.number(), z.number()]),
});

const CampusFacilitySchema = z.object({
  facUid: z.string().openapi({ example: "F123456" }),
  facTypeId: z.number().optional().openapi({ example: 1 }),
  facType: z.string().optional().openapi({ example: "無障礙電梯" }),
  name: z.string().optional().openapi({ example: "行政大樓電梯" }),
  building: z.string().optional().openapi({ example: "行政大樓" }),
  buildingUid: z.string().optional().openapi({ example: "B01" }),
  floors: z.array(z.string()).openapi({ example: ["1", "2", "3"] }),
  floorIds: z.array(z.string()).openapi({ example: ["L1", "L2", "L3"] }),
});

export const CampusSummarySchema = z
  .object({
    branchId: z.number().openapi({ example: -2147483633 }),
    schoolName: z.string().openapi({ example: "國立臺灣大學" }),
    branchName: z.string().openapi({ example: "校總區" }),
    city: z.string().optional().openapi({ example: "臺北市" }),
    address: z.string().optional().openapi({ example: "臺北市大安區羅斯福路四段1號" }),
    phone: z.string().optional().openapi({ example: "02-33663366" }),
    location: GeoPointSchema.optional(),
    buildingCount: z.number().openapi({ example: 120 }),
    facilityCount: z.number().openapi({ example: 680 }),
    facTypeSummary: z
      .record(z.string(), z.number())
      .openapi({
        example: { "無障礙電梯": 24, "無障礙廁所": 130, "無障礙坡道": 45 },
        description: "該校區各設施類型的筆數統計",
      }),
  })
  .openapi("CampusSummary");

export const CampusDetailSchema = z
  .object({
    _id: z.string().openapi({ example: "66a1f2c3e4b5a6d7c8e9f0d4" }),
    schoolId: z.number().openapi({ example: 1001 }),
    schoolName: z.string().openapi({ example: "國立臺灣大學" }),
    branchId: z.number().openapi({ example: -2147483633 }),
    branchName: z.string().openapi({ example: "校總區" }),
    city: z.string().optional().openapi({ example: "臺北市" }),
    address: z.string().optional().openapi({ example: "臺北市大安區羅斯福路四段1號" }),
    phone: z.string().optional().openapi({ example: "02-33663366" }),
    buildingCount: z.number().openapi({ example: 120 }),
    facilityCount: z.number().openapi({ example: 680 }),
    facilities: z.array(CampusFacilitySchema),
    location: GeoPointSchema.optional(),
    importedAt: z.string().openapi({ example: "2026-06-24T00:00:00.000Z" }),
  })
  .openapi("CampusDetail");

const CampusListDataSchema = z
  .object({
    items: z.array(CampusSummarySchema),
    totalCount: z.number().openapi({ example: 42 }),
    page: z.number().openapi({ example: 1 }),
    totalPages: z.number().openapi({ example: 3 }),
  })
  .openapi("CampusListData");

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

export const CampusNearbyResponseSchema = ApiResponseSchema(
  z.array(CampusSummarySchema),
  "CampusNearbyResponse"
);

export const CampusListResponseSchema = ApiResponseSchema(
  CampusListDataSchema,
  "CampusListResponse"
);

export const CampusDetailResponseSchema = ApiResponseSchema(
  CampusDetailSchema,
  "CampusDetailResponse"
);

registry.registerPath({
  method: "get",
  path: "/a11y/campus/nearby",
  tags: ["Campus"],
  summary: "鄰近校園無障礙設施校區",
  description:
    "回傳指定座標附近的校區摘要（含各設施類型筆數統計 facTypeSummary），不含完整 facilities 陣列。可用 facType 篩選具備特定設施的校區。",
  request: { query: CampusNearbyQuerySchema },
  responses: {
    200: {
      description: "鄰近校區摘要清單",
      content: { "application/json": { schema: CampusNearbyResponseSchema } },
    },
    400: { description: "缺少或無效的經緯度" },
    500: { description: "伺服器錯誤" },
  },
});

registry.registerPath({
  method: "get",
  path: "/a11y/campus",
  tags: ["Campus"],
  summary: "校園無障礙設施校區目錄（可篩選、分頁）",
  description:
    "回傳校區摘要清單，可用 city / facType 篩選、keyword 對校名與校區名模糊比對，並分頁（page / limit）。",
  request: { query: CampusListQuerySchema },
  responses: {
    200: {
      description: "校區摘要清單（含分頁資訊）",
      content: { "application/json": { schema: CampusListResponseSchema } },
    },
    500: { description: "伺服器錯誤" },
  },
});

registry.registerPath({
  method: "get",
  path: "/a11y/campus/{branchId}",
  tags: ["Campus"],
  summary: "校區無障礙設施詳情",
  description: "依 branchId 回傳單一校區的完整資訊，含 facilities 設施陣列。",
  request: { params: CampusParamsSchema },
  responses: {
    200: {
      description: "校區詳情",
      content: { "application/json": { schema: CampusDetailResponseSchema } },
    },
    404: { description: "查無此校區" },
    500: { description: "伺服器錯誤" },
  },
});
