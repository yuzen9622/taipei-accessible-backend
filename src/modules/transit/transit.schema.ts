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
      .openapi({ description: "回應語言" }),
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

const CityQuery = z
  .string()
  .min(1)
  .optional()
  .openapi({ example: "台北", description: "公車所在縣市（中文或英文），未提供則無法定位" });

const DirectionQuery = z.coerce
  .number()
  .int()
  .min(0)
  .max(1)
  .optional()
  .openapi({ example: 0, description: "行駛方向（0=去程，1=返程），可省略" });

export const BusRouteQuerySchema = z
  .object({ routeName: z.string().min(1).openapi({ example: "307" }), city: CityQuery })
  .strict();

export const BusArrivalQuerySchema = z
  .object({
    routeName: z.string().min(1).openapi({ example: "307" }),
    stopName: z.string().min(1).openapi({ example: "台北車站" }),
    city: CityQuery,
    direction: DirectionQuery,
  })
  .strict();

export const BusTimetableQuerySchema = z
  .object({ routeName: z.string().min(1).openapi({ example: "307" }), city: CityQuery })
  .strict();

export const BusPositionsQuerySchema = z
  .object({
    routeName: z.string().min(1).openapi({ example: "307" }),
    city: CityQuery,
    direction: DirectionQuery,
  })
  .strict();

const BilingualNameSchema = z
  .object({
    Zh_tw: z.string().openapi({ example: "台北車站" }),
    En: z.string().openapi({ example: "Taipei Main Station" }),
  })
  .openapi("BilingualName");

const DirectionSchema = z
  .union([z.literal(0), z.literal(1)])
  .openapi({ example: 0, description: "行駛方向（0 = 去程，1 = 返程）" });

export const EstimatedTimeOfArrivalSchema = z
  .object({
    StopUID: z.string().openapi({ example: "TPE16523" }),
    StopName: BilingualNameSchema,
    Direction: DirectionSchema,
    EstimateTime: z
      .number()
      .nullable()
      .openapi({ example: 180, description: "預估到站秒數，無資料時為 null" }),
    StopStatus: z.number().openapi({ example: 0 }),
    MessageType: z.number().optional().openapi({ example: 1 }),
    PlateNumb: z.string().optional().openapi({ example: "KKA-1234" }),
    RouteName: BilingualNameSchema.optional(),
    SubRouteName: BilingualNameSchema.optional(),
  })
  .passthrough()
  .openapi("EstimatedTimeOfArrival");

export const RealTimeByFrequencySchema = z
  .object({
    PlateNumb: z.string().openapi({ example: "KKA-1234" }),
    OperatorNo: z.string().openapi({ example: "10081" }),
    Direction: DirectionSchema,
    BusPosition: z
      .object({
        PositionLon: z.number().openapi({ example: 121.5171 }),
        PositionLat: z.number().openapi({ example: 25.0478 }),
      })
      .openapi("BusPosition"),
    Speed: z.number().optional().openapi({ example: 32.5 }),
    GPSTime: z.string().optional().openapi({ example: "2026-06-03T08:15:30+08:00" }),
    UpdateTime: z.string().optional().openapi({ example: "2026-06-03T08:15:35+08:00" }),
    RouteName: BilingualNameSchema.optional(),
  })
  .passthrough()
  .openapi("RealTimeByFrequency");

const ApiResponseSchema = <T extends z.ZodTypeAny>(data: T) =>
  z.object({
    ok: z.boolean().openapi({ example: true }),
    status: z.enum(["success", "error"]).openapi({ example: "success" }),
    code: z.number().openapi({ example: 200 }),
    message: z.string().openapi({ example: "OK" }),
    data: data.optional(),
    accessToken: z.string().optional(),
  });

export const BusArrivalResponseSchema = ApiResponseSchema(
  z.array(EstimatedTimeOfArrivalSchema)
).openapi("BusArrivalResponse");

export const BusRealtimeResponseSchema = ApiResponseSchema(
  z.array(RealTimeByFrequencySchema)
).openapi("BusRealtimeResponse");

registry.registerPath({
  method: "post",
  path: "/transit/bus",
  tags: ["Transit"],
  summary: "公車到站預估",
  description: "查詢 TDX 指定路線在某站的到站預估，路線類型依 route_name 自動判別。",
  request: {
    body: {
      content: { "application/json": { schema: BusBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "TDX 即時公車到站資料",
      content: { "application/json": { schema: BusArrivalResponseSchema } },
    },
    400: { description: "缺少參數或無法辨識路線方向" },
    500: { description: "TDX API 錯誤" },
  },
});

registry.registerPath({
  method: "get",
  path: "/transit/bus/realtime",
  tags: ["Transit"],
  summary: "公車即時定位",
  description: "依車牌回傳指定公車的即時 GPS 位置，並附與到站站牌的距離。",
  request: {
    query: BusRealtimeQuerySchema,
  },
  responses: {
    200: {
      description: "公車即時位置資料",
      content: { "application/json": { schema: BusRealtimeResponseSchema } },
    },
    400: { description: "缺少或無效的參數" },
    500: { description: "TDX API 錯誤" },
  },
});

const BusServiceResponseSchema = ApiResponseSchema(
  z.object({ ok: z.boolean() }).passthrough(),
).openapi("BusServiceResponse");

registry.registerPath({
  method: "get",
  path: "/transit/bus/route",
  tags: ["Transit"],
  summary: "公車路線站序",
  description: "回傳指定路線去/返程的起訖站與完整停靠站列表（優先讀已匯入資料，未匯入則即時查 TDX）。",
  request: { query: BusRouteQuerySchema },
  responses: {
    200: { description: "路線站序", content: { "application/json": { schema: BusServiceResponseSchema } } },
    400: { description: "缺少縣市或參數" },
    404: { description: "找不到路線" },
    500: { description: "TDX/DB 錯誤" },
  },
});

registry.registerPath({
  method: "get",
  path: "/transit/bus/arrival",
  tags: ["Transit"],
  summary: "公車到站時間",
  description: "回傳指定路線在某站牌的即時預估到站分鐘數；若該班車車牌已知，附帶是否低底盤。",
  request: { query: BusArrivalQuerySchema },
  responses: {
    200: { description: "到站預估", content: { "application/json": { schema: BusServiceResponseSchema } } },
    400: { description: "缺少縣市或參數" },
    404: { description: "找不到到站資料" },
    500: { description: "TDX 錯誤" },
  },
});

registry.registerPath({
  method: "get",
  path: "/transit/bus/timetable",
  tags: ["Transit"],
  summary: "公車時刻表",
  description: "回傳指定路線的首末班車時間與今日班次發車時刻。",
  request: { query: BusTimetableQuerySchema },
  responses: {
    200: { description: "時刻表", content: { "application/json": { schema: BusServiceResponseSchema } } },
    400: { description: "缺少縣市或參數" },
    404: { description: "找不到時刻表" },
    500: { description: "TDX 錯誤" },
  },
});

registry.registerPath({
  method: "get",
  path: "/transit/bus/positions",
  tags: ["Transit"],
  summary: "公車即時位置（含低底盤）",
  description: "回傳指定路線目前所有在線車輛的即時位置與行駛狀態，並標註每台車是否為低底盤／有無升降斜坡板。無需提供車牌。",
  request: { query: BusPositionsQuerySchema },
  responses: {
    200: { description: "在線車輛清單", content: { "application/json": { schema: BusServiceResponseSchema } } },
    400: { description: "缺少縣市或參數" },
    404: { description: "目前無營運車輛" },
    500: { description: "TDX 錯誤" },
  },
});
