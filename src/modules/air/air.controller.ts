import { sendResponse } from "../../config/lib";
import { ResponseCode } from "../../types/code";
import { MSG, ERROR_MESSAGE } from "../../constants/messages";
import { AIResponse } from "../../types/air";
import { ApiResponse } from "../../types/response";
import { Request, Response } from "express";
import { getAirQualityWithAI } from "./air.service";

export async function getAirQualityInfo(
  req: Request,
  res: Response<ApiResponse<AIResponse>>,
) {
  try {
    const { lat, lng } = req.query;
    const result = await getAirQualityWithAI(Number(lat), Number(lng));

    if (!result) {
      return sendResponse(
        res,
        false,
        "error",
        ResponseCode.NOT_FOUND,
        "此區域沒有空氣品質監測器",
      );
    }

    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, result);
  } catch (error) {
    console.error(error);
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      ERROR_MESSAGE.INTERNAL,
    );
  }
}
