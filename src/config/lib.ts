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
      secure: false,
      maxAge: 24 * 60 * 60 * 1000 * 7,
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
