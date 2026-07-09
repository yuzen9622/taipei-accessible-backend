import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { registry } from "../../openapi/registry";

extendZodWithOpenApi(z);

export const CreateSosSchema = z
  .object({
    type: z.enum(["body", "trapped", "share_location"]),
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
    address: z.string().max(200).optional(),
  })
  .strict()
  .openapi("CreateSos");

export const UpdateSosLocationSchema = z
  .object({
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
    address: z.string().max(200).optional(),
  })
  .strict()
  .openapi("UpdateSosLocation");

export const SessionIdParamSchema = z
  .object({ id: z.string() })
  .strict();

export const ShareTokenParamSchema = z
  .object({ token: z.string().length(32) })
  .strict();

registry.registerPath({
  method: "post",
  path: "/sos/sessions",
  tags: ["SOS"],
  summary: "建立 SOS 求救",
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: CreateSosSchema } } },
  },
  responses: {
    201: { description: "已建立並發出通知" },
    200: { description: "已有進行中的求救，回傳既有紀錄" },
  },
});

registry.registerPath({
  method: "patch",
  path: "/sos/sessions/{id}/location",
  tags: ["SOS"],
  summary: "更新求救中位置",
  security: [{ bearerAuth: [] }],
  request: {
    params: SessionIdParamSchema,
    body: { content: { "application/json": { schema: UpdateSosLocationSchema } } },
  },
  responses: {
    200: { description: "已更新" },
    400: { description: "求救已結束" },
    403: { description: "非本人" },
    404: { description: "找不到求救紀錄" },
  },
});

registry.registerPath({
  method: "patch",
  path: "/sos/sessions/{id}/resolve",
  tags: ["SOS"],
  summary: "解除求救",
  security: [{ bearerAuth: [] }],
  request: { params: SessionIdParamSchema },
  responses: {
    200: { description: "已解除" },
    400: { description: "求救已結束" },
    403: { description: "非本人" },
    404: { description: "找不到求救紀錄" },
  },
});

registry.registerPath({
  method: "get",
  path: "/sos/sessions/{id}/public",
  tags: ["SOS"],
  summary: "公開追蹤頁查詢（無需登入）",
  request: { params: SessionIdParamSchema },
  responses: {
    200: { description: "即時位置" },
    404: { description: "找不到此追蹤連結" },
    410: { description: "此追蹤連結已失效" },
  },
});
