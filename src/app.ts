import express, { Express, Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import type { ApiResponse } from "./types/response";
import { ResponseCode } from "./types/code";
import middleware from "./middleware/middleware";
import userRoute from "./routes/user.route";
import cookieParser from "cookie-parser";
const app: Express = express();

// 安全性中介軟體
app.use(helmet());

// CORS 設定
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "*",
    credentials: true,
  })
);

// 日誌記錄
app.use(morgan("combined"));
app.use(cookieParser());
// Body parser 中介軟體
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.get("/health", (req: Request, res: Response) => {
  res.status(200).json({
    status: "OK",
    message: "Server is running",
    timestamp: new Date().toISOString(),
  });
});

app.use("/api/user", middleware, userRoute);

app.use("*", (req: Request, res: Response<ApiResponse<null>>) => {
  res.status(404).json({
    ok: false,
    status: "error",
    code: ResponseCode.NOT_FOUND,
    message: `Method ${req.method} ${req.originalUrl} not found`,
  });
});

export default app;
