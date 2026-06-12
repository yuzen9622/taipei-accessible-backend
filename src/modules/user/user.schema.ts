import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { registry } from "../../openapi/registry";

extendZodWithOpenApi(z);

// Register Bearer security scheme once
registry.registerComponent("securitySchemes", "BearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
});

export const LoginBodySchema = z
  .object({
    name: z.string().min(1).openapi({ example: "Jane Doe" }),
    email: z.string().email().openapi({ example: "jane@example.com" }),
    avatar: z.string().url().optional().openapi({ example: "https://example.com/avatar.png" }),
    client_id: z.string().min(1).openapi({ description: "OAuth 提供者的 sub/uid" }),
  })
  .strict();

export const TokenBodySchema = z
  .object({
    token: z.string().min(1).openapi({ description: "欲重新簽發的現有存取權杖" }),
  })
  .strict();

export const ConfigBodySchema = z
  .object({
    user_id: z.string().min(1).openapi({ description: "MongoDB 使用者 _id" }),
  })
  .strict();

export const UpdateConfigBodySchema = z
  .object({
    user_id: z.string().min(1),
    language: z.string().optional().openapi({ example: "zh-TW" }),
    darkMode: z.enum(["light", "dark", "system"]).optional(),
    themeColor: z.string().optional().openapi({ example: "#3B82F6" }),
    fontSize: z.string().optional().openapi({ example: "md" }),
    notifications: z.boolean().optional(),
  })
  .strict();

// ── Domain entity schemas ───────────────────────────────────────────────────

const UserSchema = z
  .object({
    _id: z.string().openapi({ example: "665f1a2b3c4d5e6f7a8b9c0d" }),
    name: z.string().openapi({ example: "Jane Doe" }),
    avatar: z.string().url().optional().openapi({ example: "https://example.com/avatar.png" }),
    email: z.string().email().openapi({ example: "jane@example.com" }),
    client_id: z.string().openapi({ example: "google-oauth2|10293847" }),
    createdAt: z.string().openapi({ example: "2026-01-15T08:30:00.000Z" }),
    updatedAt: z.string().openapi({ example: "2026-06-03T11:45:00.000Z" }),
  })
  .openapi("User");

const ConfigSchema = z
  .object({
    language: z.string().openapi({ example: "zh-TW" }),
    darkMode: z.enum(["light", "dark", "system"]).openapi({ example: "system" }),
    themeColor: z.string().openapi({ example: "#3B82F6" }),
    fontSize: z.string().openapi({ example: "md" }),
    notifications: z.boolean().openapi({ example: true }),
    user_id: z.string().openapi({ example: "665f1a2b3c4d5e6f7a8b9c0d" }),
  })
  .openapi("Config");

// ── Generic API response envelope ───────────────────────────────────────────

const apiResponse = <T extends z.ZodTypeAny>(data?: T) =>
  z.object({
    ok: z.boolean().openapi({ example: true }),
    status: z.enum(["success", "error"]).openapi({ example: "success" }),
    code: z.number().openapi({ example: 200 }),
    message: z.string().openapi({ example: "OK" }),
    ...(data ? { data: data.optional() } : {}),
    accessToken: z.string().optional().openapi({ description: "短期有效的 JWT 存取權杖" }),
  });

// ── Response schemas ────────────────────────────────────────────────────────

export const LoginResponseSchema = apiResponse(
  z.object({
    user: UserSchema,
    config: ConfigSchema,
  }),
).openapi("LoginResponse");

export const TokenResponseSchema = apiResponse(
  z.object({
    user: UserSchema,
  }),
).openapi("TokenResponse");

export const RefreshResponseSchema = apiResponse(
  z.object({
    user: UserSchema,
  }),
).openapi("RefreshResponse");

export const UserInfoResponseSchema = apiResponse(
  z.object({
    user: UserSchema.nullable(),
    config: ConfigSchema.nullable(),
  }),
).openapi("UserInfoResponse");

export const ConfigResponseSchema = apiResponse(ConfigSchema.nullable()).openapi("ConfigResponse");

export const UpdateConfigResponseSchema = apiResponse(ConfigSchema).openapi("UpdateConfigResponse");

export const LogoutResponseSchema = apiResponse().openapi("LogoutResponse");

export const ErrorResponseSchema = apiResponse().openapi("ErrorResponse");

// ── OpenAPI path registrations ──────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/user/login",
  tags: ["User"],
  summary: "OAuth 登入",
  description: "以 OAuth 提供者建立或更新使用者，回傳存取權杖並設定 refreshToken cookie。",
  request: {
    body: {
      content: { "application/json": { schema: LoginBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "存取權杖於 body，refresh 權杖於 cookie",
      content: { "application/json": { schema: LoginResponseSchema } },
    },
    400: {
      description: "缺少必填欄位",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "伺服器錯誤",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/user/token",
  tags: ["User"],
  summary: "重新簽發權杖",
  description: "驗證未過期的存取權杖，重新簽發新的存取與 refresh 權杖。",
  request: {
    body: {
      content: { "application/json": { schema: TokenBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "新的存取與 refresh 權杖",
      content: { "application/json": { schema: TokenResponseSchema } },
    },
    401: {
      description: "權杖無效或已過期",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/user/refresh",
  tags: ["User"],
  summary: "Cookie 換發權杖",
  description: "讀取 refreshToken cookie，簽發新的存取與 refresh 權杖，免請求內容。",
  responses: {
    200: {
      description: "新的存取與 refresh 權杖",
      content: { "application/json": { schema: RefreshResponseSchema } },
    },
    401: {
      description: "refresh cookie 無效或不存在",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/user/info",
  tags: ["User"],
  summary: "目前使用者資料",
  description: "回傳已驗證使用者的個資與偏好設定，需有效 Bearer 權杖。",
  security: [{ BearerAuth: [] }],
  responses: {
    200: {
      description: "使用者與設定物件",
      content: { "application/json": { schema: UserInfoResponseSchema } },
    },
    401: {
      description: "未授權",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    403: {
      description: "禁止存取",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "伺服器錯誤",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/user/config",
  tags: ["User"],
  summary: "取得使用者設定",
  description: "依 user_id 取得偏好設定，需有效 Bearer 權杖。",
  security: [{ BearerAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: ConfigBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "使用者設定物件",
      content: { "application/json": { schema: ConfigResponseSchema } },
    },
    400: {
      description: "缺少 user_id",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "伺服器錯誤",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/user/config/update",
  tags: ["User"],
  summary: "更新使用者偏好",
  description: "部分更新使用者設定，除 user_id 外皆選填，只改傳入欄位。",
  security: [{ BearerAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: UpdateConfigBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "更新後的設定",
      content: { "application/json": { schema: UpdateConfigResponseSchema } },
    },
    400: {
      description: "缺少 user_id 或查無設定",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "伺服器錯誤",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/user/logout",
  tags: ["User"],
  summary: "使用者登出",
  description: "清除 refreshToken cookie，用戶端須自行捨棄存取權杖。",
  responses: {
    200: {
      description: "登出成功",
      content: { "application/json": { schema: LogoutResponseSchema } },
    },
    500: {
      description: "伺服器錯誤",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});
