import express, { Express, Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import { apiReference } from "@scalar/express-api-reference";
import type { ApiResponse } from "./types/response";
import { ResponseCode } from "./types/code";
import middleware from "./middleware/middleware";
import { createA11yRouter } from "./modules/a11y";
import { createChatbotRouter } from "./modules/chatbot";
import { createAccessibleRouteRouter } from "./modules/accessible-route";
import { createTransitRouter } from "./modules/transit";
import { createUserRouter } from "./modules/user";
import { createAirRouter } from "./modules/air";
import { generateOpenAPIDocument } from "./openapi/document";

const app: Express = express();

// Security middleware
app.use(
  helmet({
    // Allow Scalar UI to load its CDN assets
    contentSecurityPolicy: false,
  }),
);

// CORS
const corsOrigins = process.env.CORS_ORIGINS?.split(",")
  .map((o) => o.trim())
  .filter(Boolean) ?? ["http://localhost:3000"];
app.use(cors({ origin: corsOrigins, credentials: true }));

app.use(morgan("common"));
app.use(cookieParser());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Health check
app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({
    status: "OK",
    message: "Server is running",
    timestamp: new Date().toISOString(),
  });
});

// OpenAPI spec
app.get("/api/v1/openapi.json", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "application/json");
  res.send(generateOpenAPIDocument());
});

// Scalar API docs UI
app.use(
  "/docs",
  apiReference({
    url: "/api/v1/openapi.json",
    theme: "default",
  }),
);

// Routes
app.use("/api/v1/user", middleware, createUserRouter());
app.use("/api/v1/transit", createTransitRouter());
app.use("/api/v1/a11y", createA11yRouter());
app.use("/api/v1/a11y", createChatbotRouter());
app.use("/api/v1/a11y", createAccessibleRouteRouter());
app.use("/api/v1/air", createAirRouter());

// 404 handler
app.use("*", (req: Request, res: Response<ApiResponse<null>>) => {
  res.status(404).json({
    ok: false,
    status: "error",
    code: ResponseCode.NOT_FOUND,
    message: `Method ${req.method} ${req.originalUrl} not found`,
  });
});

export default app;
