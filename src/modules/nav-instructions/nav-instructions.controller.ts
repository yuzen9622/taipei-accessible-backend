import type { Request, Response } from "express";
import { sendResponse } from "../../config/lib";
import { ApiResponse } from "../../types/response";
import { ResponseCode } from "../../types/code";
import { ERROR_MESSAGE } from "../../constants/messages";
import { generateNavInstructions } from "./nav-instructions.service";

export async function navInstructions(
  req: Request,
  res: Response<ApiResponse<any>>,
) {
  try {
    const { route, userHeading } = req.body;
    const result = generateNavInstructions(route, userHeading);

    if (!result.ok) {
      return sendResponse(res, false, "error", result.status, result.message, {
        reason: result.reason,
      });
    }

    return sendResponse(
      res,
      true,
      "success",
      ResponseCode.OK,
      `逐步指引產生完成，共 ${result.data.totalSteps} 步`,
      result.data,
    );
  } catch (error: any) {
    console.error("[nav-instructions]", error);
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      error?.message ?? ERROR_MESSAGE.INTERNAL,
    );
  }
}
