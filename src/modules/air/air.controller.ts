import { googleGenAi } from "../../config/ai";
import { sendResponse } from "../../config/lib";
import { AIResponse } from "../../types/air";
import { ApiResponse } from "../../types/response";
import { Request, Response } from "express";
import { model } from "../../config/ai";
import { rankConfig } from "../../config/ai/config";
import { rankContents } from "../../config/ai/contents";
import { getAirData } from "./air.service";
import { ResponseCode } from "../../types/code";
import { MSG, ERROR_MESSAGE } from "../../constants/messages";

export async function getAirQualityInfo(
  req: Request,
  res: Response<ApiResponse<AIResponse>>,
) {
  try {
    const { lat, lng } = req.query;
    const airData = await getAirData(Number(lat), Number(lng));

    if (!airData) {
      return sendResponse(res, false, "error", ResponseCode.NOT_FOUND, "此區域沒有空氣品質監測器");
    }

    const aiResponse = await googleGenAi.models.generateContent({
      model,
      contents: [
        ...rankContents,
        {
          role: "user",
          parts: [
            {
              text: `感測器座標：${JSON.stringify(airData.readings[0])}\n路線位置：{lat: ${lat}, lng: ${lng}}`,
            },
          ],
        },
      ],
      config: rankConfig,
    });

    sendResponse(
      res,
      true,
      "success",
      ResponseCode.OK,
      MSG.OK,
      JSON.parse(
        aiResponse?.candidates?.[0].content?.parts?.[0].text ??
          '{"description":"此區域沒有空氣品質監測器喔!","quality":""}',
      ),
    );
  } catch (error) {
    console.error(error);
    sendResponse(res, false, "error", ResponseCode.INTERNAL_ERROR, ERROR_MESSAGE.INTERNAL);
  }
}
