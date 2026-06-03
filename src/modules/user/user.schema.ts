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

// ── OpenAPI path registrations ──────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/user/login",
  tags: ["User"],
  summary: "OAuth login — creates user and config if not found",
  request: {
    body: {
      content: { "application/json": { schema: LoginBodySchema } },
      required: true,
    },
  },
  responses: {
    200: { description: "Access token in body, refresh token as httpOnly cookie" },
    400: { description: "Missing required fields" },
    500: { description: "Internal error" },
  },
});

registry.registerPath({
  method: "post",
  path: "/user/token",
  tags: ["User"],
  summary: "Re-issue a new access token from an existing access token",
  request: {
    body: {
      content: { "application/json": { schema: TokenBodySchema } },
      required: true,
    },
  },
  responses: {
    200: { description: "New access + refresh tokens" },
    401: { description: "Invalid or expired token" },
  },
});

registry.registerPath({
  method: "post",
  path: "/user/refresh",
  tags: ["User"],
  summary: "Refresh access token using the refreshToken cookie",
  responses: {
    200: { description: "New access + refresh tokens" },
    401: { description: "Invalid or missing refresh token cookie" },
  },
});

registry.registerPath({
  method: "get",
  path: "/user/info",
  tags: ["User"],
  summary: "Get current user profile and config",
  security: [{ BearerAuth: [] }],
  responses: {
    200: { description: "User and config objects" },
    401: { description: "Unauthorized" },
    403: { description: "Forbidden" },
  },
});

registry.registerPath({
  method: "post",
  path: "/user/config",
  tags: ["User"],
  summary: "Get user config by user_id",
  security: [{ BearerAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: ConfigBodySchema } },
      required: true,
    },
  },
  responses: {
    200: { description: "User config object" },
    400: { description: "Missing user_id" },
  },
});

registry.registerPath({
  method: "post",
  path: "/user/config/update",
  tags: ["User"],
  summary: "Update user preferences",
  security: [{ BearerAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: UpdateConfigBodySchema } },
      required: true,
    },
  },
  responses: {
    200: { description: "Updated config" },
    400: { description: "Missing user_id or config not found" },
  },
});

registry.registerPath({
  method: "post",
  path: "/user/logout",
  tags: ["User"],
  summary: "Clear the refreshToken cookie",
  responses: {
    200: { description: "Logout successful" },
  },
});
