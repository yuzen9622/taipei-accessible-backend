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
    client_id: z.string().min(1).openapi({ description: "OAuth provider sub/uid" }),
  })
  .strict();

export const TokenBodySchema = z
  .object({
    token: z.string().min(1).openapi({ description: "Existing access token to re-issue" }),
  })
  .strict();

export const ConfigBodySchema = z
  .object({
    user_id: z.string().min(1).openapi({ description: "MongoDB user _id" }),
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
    accessToken: z.string().optional().openapi({ description: "Short-lived JWT access token" }),
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
  summary: "OAuth login",
  description: "Upserts a user from an OAuth provider (Google, etc.) and returns a short-lived access token in the response body. A `refreshToken` httpOnly cookie is also set.",
  request: {
    body: {
      content: { "application/json": { schema: LoginBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Access token in body, refresh token as httpOnly cookie",
      content: { "application/json": { schema: LoginResponseSchema } },
    },
    400: {
      description: "Missing required fields",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "Internal error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/user/token",
  tags: ["User"],
  summary: "Re-issue access token",
  description: "Accepts an existing (possibly expired) access token and re-issues a new access token + refresh token pair, provided the token payload is still valid.",
  request: {
    body: {
      content: { "application/json": { schema: TokenBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "New access + refresh tokens",
      content: { "application/json": { schema: TokenResponseSchema } },
    },
    401: {
      description: "Invalid or expired token",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/user/refresh",
  tags: ["User"],
  summary: "Refresh via cookie",
  description: "Reads the `refreshToken` httpOnly cookie and issues a new access token + refresh token pair. No request body required.",
  responses: {
    200: {
      description: "New access + refresh tokens",
      content: { "application/json": { schema: RefreshResponseSchema } },
    },
    401: {
      description: "Invalid or missing refresh token cookie",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/user/info",
  tags: ["User"],
  summary: "Current user profile",
  description: "Returns the authenticated user's profile and their stored config (language, theme, font size, notifications). Requires a valid Bearer token.",
  security: [{ BearerAuth: [] }],
  responses: {
    200: {
      description: "User and config objects",
      content: { "application/json": { schema: UserInfoResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    403: {
      description: "Forbidden",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "Internal error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/user/config",
  tags: ["User"],
  summary: "Get user config",
  description: "Fetches the preference config for the given `user_id`. Requires a valid Bearer token.",
  security: [{ BearerAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: ConfigBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "User config object",
      content: { "application/json": { schema: ConfigResponseSchema } },
    },
    400: {
      description: "Missing user_id",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "Internal error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/user/config/update",
  tags: ["User"],
  summary: "Update user preferences",
  description: "Partially updates the user's config. All fields except `user_id` are optional — only provided fields are changed.",
  security: [{ BearerAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: UpdateConfigBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Updated config",
      content: { "application/json": { schema: UpdateConfigResponseSchema } },
    },
    400: {
      description: "Missing user_id or config not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "Internal error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/user/logout",
  tags: ["User"],
  summary: "Logout",
  description: "Clears the `refreshToken` httpOnly cookie. The client must discard its access token independently.",
  responses: {
    200: {
      description: "Logout successful",
      content: { "application/json": { schema: LogoutResponseSchema } },
    },
    500: {
      description: "Internal error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});
