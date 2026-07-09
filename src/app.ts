import express, { Express, Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import { apiReference } from "@scalar/express-api-reference";
import type { ApiResponse } from "./types/response";
import { ResponseCode } from "./types/code";
import { sendResponse } from "./config/lib";
import middleware from "./middleware/middleware";
import { createA11yRouter } from "./modules/a11y";
import { createAccessibleRouteRouter } from "./modules/accessible-route";
import { createNavInstructionsRouter } from "./modules/nav-instructions";
import { createTransitRouter } from "./modules/transit";
import { createUserRouter } from "./modules/user";
import { createAirRouter } from "./modules/air";
import { createAiRouter } from "./modules/ai";
import { createHazardReportRouter } from "./modules/hazard-report";
import { createEnvironmentRouter } from "./modules/environment";
import { createWelfareRouter } from "./modules/welfare";
import { createVisualA11yRouter } from "./modules/visual-a11y";
import { createReviewRouter } from "./modules/review";
import { createCampusRouter } from "./modules/campus";
import { createEmergencyContactRouter } from "./modules/emergency-contact";
import { createSosRouter } from "./modules/sos";
import { createLineRouter } from "./modules/line";
import { generateOpenAPIDocument } from "./openapi/document";

const app: Express = express();

app.use(
  helmet({
    contentSecurityPolicy: false,
  }),
);

const corsOrigins = process.env.CORS_ORIGINS?.split(",")
  .map((o) => o.trim())
  .filter(Boolean) ?? ["http://localhost:3000"];
app.use(cors({ origin: corsOrigins, credentials: true }));

app.use(morgan("common"));
app.use(cookieParser());

// LINE webhook is the one exception that must mount BEFORE express.json():
// its HMAC-SHA256 signature is verified over the raw, unparsed body, so the
// router uses express.raw() internally instead of the global JSON parser.
app.use("/api/v1/line", createLineRouter());

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.get("/health", (_req: Request, res: Response) => {
  res.status(ResponseCode.OK).json({
    status: "OK",
    message: "Server is running",
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/v1/openapi.json", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "application/json");
  res.send(generateOpenAPIDocument());
});

app.use(
  "/docs",
  apiReference({
    url: "/api/v1/openapi.json",
    theme: "default",
  }),
);

app.use("/api/v1/user", middleware, createUserRouter());
app.use("/api/v1/user", middleware, createEmergencyContactRouter());
app.use("/api/v1/sos", createSosRouter());
app.use("/api/v1/transit", createTransitRouter());
app.use("/api/v1/a11y", createA11yRouter());
app.use("/api/v1/a11y", createAccessibleRouteRouter());
app.use("/api/v1/a11y", createNavInstructionsRouter());
app.use("/api/v1/a11y", createHazardReportRouter());
app.use("/api/v1/a11y", createEnvironmentRouter());
app.use("/api/v1/a11y", createWelfareRouter());
app.use("/api/v1/a11y", createVisualA11yRouter());
app.use("/api/v1/a11y", createReviewRouter());
app.use("/api/v1/a11y", createCampusRouter());
app.use("/api/v1/air", createAirRouter());
app.use("/api/v1/ai", createAiRouter());

app.use("*", (req: Request, res: Response<ApiResponse<null>>) => {
  sendResponse(
    res,
    false,
    "error",
    ResponseCode.NOT_FOUND,
    `Method ${req.method} ${req.originalUrl} not found`,
  );
});

export default app;
