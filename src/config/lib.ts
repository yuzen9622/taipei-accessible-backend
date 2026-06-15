import { ResponseCode } from "../types/code";
import { Response } from "express";
import type { ApiResponse } from "../types/response";

export const sendResponse = <T = unknown>(
  res: Response<ApiResponse<T>>,
  ok: boolean,
  status: "success" | "error",
  code: ResponseCode,
  message: string,
  data?: T,
  accessToken?: string,
  refreshToken?: string
) => {
  if (refreshToken) {
    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: process.env.SECURE_COOKIE === "true",
      maxAge: 24 * 60 * 60 * 1000 * 7,
      sameSite: process.env.SECURE_COOKIE === "true" ? "none" : "lax",
    });
  }

  res.status(code).json({
    ok,
    status,
    code,
    message,
    data,
    accessToken,
  });
};
