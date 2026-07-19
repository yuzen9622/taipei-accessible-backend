import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { registry } from "../../openapi/registry";

extendZodWithOpenApi(z);

export const CreateEmergencyContactSchema = z
  .object({
    name: z.string().min(1).max(50).openapi({ example: "媽媽" }),
  })
  .strict()
  .openapi("CreateEmergencyContact");

export const ContactIdParamSchema = z
  .object({
    id: z.string().openapi({ example: "66a1f1..." }),
  })
  .strict();

export const DeleteContactResponseSchema = z
  .object({
    ok: z.boolean().openapi({ example: true }),
    status: z.enum(["success", "error"]).openapi({ example: "success" }),
    code: z.number().openapi({ example: 200 }),
    message: z.string().openapi({ example: "已刪除" }),
    data: z.null().openapi({ example: null }),
    accessToken: z.string().optional(),
  })
  .openapi("DeleteEmergencyContactResponse");

registry.registerPath({
  method: "get",
  path: "/user/emergency-contacts",
  tags: ["Emergency Contact"],
  summary: "列出我的緊急聯絡人",
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "聯絡人列表" },
    401: { description: "Token 過期" },
    403: { description: "未帶或無效 Token" },
  },
});

registry.registerPath({
  method: "post",
  path: "/user/emergency-contacts",
  tags: ["Emergency Contact"],
  summary: "新增緊急聯絡人（回傳 bindCode）",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": { schema: CreateEmergencyContactSchema },
      },
    },
  },
  responses: {
    201: { description: "已建立，含 bindUrl / bindCode" },
    400: { description: "已達 5 位上限或驗證失敗" },
  },
});

registry.registerPath({
  method: "delete",
  path: "/user/emergency-contacts/{id}",
  tags: ["Emergency Contact"],
  summary: "刪除緊急聯絡人",
  security: [{ bearerAuth: [] }],
  request: { params: ContactIdParamSchema },
  responses: {
    200: {
      description: "已刪除",
      content: {
        "application/json": { schema: DeleteContactResponseSchema },
      },
    },
    403: { description: "非本人" },
    404: { description: "找不到聯絡人" },
  },
});
