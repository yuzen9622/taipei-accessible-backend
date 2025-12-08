import type { Request, Response } from "express";
import { IA11y } from "../types";
import A11y from "../model/a11y.model";
import { sendResponse } from "../config/lib";
import { ApiResponse } from "../types/response";
import BathroomModel from "../model/bathroom.model";
import { googleGenAi, model } from "../config/ai";
import { agentConfig, routeConfig, rankConfig } from "../config/ai/config";
import {
  agentContents,
  assistantContents,
  rankContents,
  routeContents,
} from "../config/ai/contents";
import { ResponseMessage } from "../types/code";
import { findA11yPlaces, findGooglePlaces } from "./ai.controller";

async function getA11yData(req: Request, res: Response<ApiResponse<IA11y[]>>) {
  const a11y = await A11y.find();
  return sendResponse(res, true, "success", 200, "OK", a11y);
}

async function getBathroomData(req: Request, res: Response<ApiResponse<any>>) {
  try {
    const bathroom = await BathroomModel.find({ type: "無障礙廁所" });
    return sendResponse(res, true, "success", 200, "OK", bathroom);
  } catch (error) {
    return sendResponse(
      res,
      false,
      "error",
      500,
      (error as string) || "Internal Server Error"
    );
  }
}

async function a11yRouteRank(req: Request, res: Response<ApiResponse<any>>) {
  try {
    const routes = req.body;
    console.log(routes);
    const aiResponse = await googleGenAi.models.generateContent({
      model,

      contents: [
        ...rankContents,

        {
          role: "user",
          parts: [
            {
              text: JSON.stringify({ routes_data: routes }),
            },
          ],
        },
      ],
      config: rankConfig,
    });

    return sendResponse(
      res,
      true,
      "success",
      200,
      "OK",
      JSON.parse(
        aiResponse?.candidates?.[0].content?.parts?.[0].text ??
          '{"route_description":"無法評估此路段","route_total_score":0}'
      )
    );
  } catch (error) {
    console.error(error);
    return sendResponse(
      res,
      false,
      "error",
      500,
      ResponseMessage.INTERNAL_ERROR,
      JSON.parse('{"route_description":"無法評估此路段","route_total_score":0}')
    );
  }
}

async function a11yRouteSelect(req: Request, res: Response<ApiResponse<any>>) {
  try {
    const request = req.body;
    const aiResponse = await googleGenAi.models.generateContent({
      model,
      contents: [
        ...routeContents,
        {
          role: "user",
          parts: [
            {
              text: JSON.stringify({ routes: request.routes }),
            },
          ],
        },
      ],
      config: routeConfig,
    });
    return sendResponse(
      res,
      true,
      "success",
      200,
      "OK",
      JSON.parse(
        aiResponse?.candidates?.[0].content?.parts?.[0].text ??
          '{"route_description":"無法評估此路段","route_total_score":0}'
      )
    );
  } catch (error) {
    console.error(error);
    return sendResponse(
      res,
      false,
      "error",
      500,
      ResponseMessage.INTERNAL_ERROR,
      JSON.parse('{"route_description":"無法評估此路段","route_total_score":0}')
    );
  }
}

async function a11yAISuggestion(req: Request, res: Response<ApiResponse<any>>) {
  try {
    const { lat, lng, message, history, lang } = req.body;
    const userContentPart = {
      role: "user",
      parts: [
        {
          text: JSON.stringify({ location: { lat, lng }, message, lang }),
        },
      ],
    };

    const AiAgent = await googleGenAi.models.generateContent({
      model,
      contents: [...agentContents, userContentPart],
      config: agentConfig,
    });

    if (!AiAgent?.candidates?.[0].content?.parts) {
      return sendResponse(
        res,
        false,
        "error",
        400,
        "很抱歉，無法提供建議，我將持續學習中。",
        null
      );
    }
    console.log(AiAgent?.candidates?.[0].content?.parts);
    const functionCalls = AiAgent.functionCalls;

    if (functionCalls && functionCalls.length > 0) {
      const functionCall = functionCalls[0];
      const functionName = functionCall.name;
      const args = functionCall.args;
      console.log("Function Call Detected:", functionName, args);
      // 處理 Google Maps 查詢工具
      if (functionName === "findGooglePlaces") {
        const { query, latitude, longitude } = args as any;

        // 🌟 執行外部的 Google Maps 查詢函式
        const toolResult = await findGooglePlaces(
          query as string,
          latitude as number,
          longitude as number
        );
        console.log("Tool Result:", toolResult);
        // 第二次呼叫：將工具結果回傳給模型，生成最終回覆
        const secondResponse = await googleGenAi.models.generateContent({
          model,
          contents: [
            ...assistantContents,
            userContentPart,
            {
              role: "model",
              parts: AiAgent.candidates[0].content.parts, // 模型的 Tool Call 要求
            },
            {
              role: "tool",
              parts: [
                {
                  functionResponse: {
                    name: "findGooglePlaces",
                    response: { result: toolResult },
                  },
                },
              ],
            },
          ],
          config: agentConfig,
        });

        // 將 Place ID 提取出來回傳給前端（如果需要的話）
        const parsedResult = JSON.parse(toolResult);
        console.log(secondResponse);
        return sendResponse(res, true, "success", 200, "OK", {
          message:
            secondResponse?.candidates?.[0].content?.parts?.[0].text ?? "",
          googlePlacesResults: parsedResult.places || [], // 回傳 Place ID 列表
        });
      } else if (functionName === "findA11yPlaces") {
        const { latitude, longitude, range, query } = args as any;
        const toolResult = await findA11yPlaces({
          query,
          latitude,
          longitude,
          range,
        });
        const secondResponse = await googleGenAi.models.generateContent({
          model,
          contents: [
            ...assistantContents,
            userContentPart,
            {
              role: "model",
              parts: AiAgent.candidates[0].content.parts, // 模型的 Tool Call 要求
            },
            {
              role: "tool",
              parts: [
                {
                  functionResponse: {
                    name: "findGooglePlaces",
                    response: { result: toolResult },
                  },
                },
              ],
            },
          ],
          config: agentConfig,
        });

        // 將 Place ID 提取出來回傳給前端（如果需要的話）
        const parsedResult = JSON.parse(toolResult);

        return sendResponse(res, true, "success", 200, "OK", {
          message:
            secondResponse?.candidates?.[0].content?.parts?.[0].text ?? "",
          a11yPlacesResults: parsedResult.places || [],
        });
      }
    } else {
      return sendResponse(res, true, "success", 200, "OK", {
        message: AiAgent?.candidates?.[0].content?.parts?.[0].text ?? "",
      });
    }
  } catch (error) {
    console.error(error);
    return sendResponse(
      res,
      false,
      "error",
      500,
      ResponseMessage.INTERNAL_ERROR,
      null
    );
  }
}

async function nearbyA11y(req: Request, res: Response<ApiResponse<any>>) {
  try {
    const { lat, lng } = req.query;

    const nearbyMetroA11y = await A11y.find({
      location: {
        $near: {
          $geometry: {
            type: "Point",
            coordinates: [Number(lng as string), Number(lat as string)],
          },
          $maxDistance: 150,
        },
      },
    });
    const nearbyBathroom = await BathroomModel.find({
      type: "無障礙廁所",
      location: {
        $near: {
          $geometry: {
            type: "Point",
            coordinates: [Number(lng as string), Number(lat as string)],
          },
          $maxDistance: 150,
        },
      },
    });

    return sendResponse(res, true, "success", 200, "OK", {
      nearbyBathroom,
      nearbyMetroA11y,
    });
  } catch (error) {
    return sendResponse(
      res,
      false,
      "error",
      500,
      (error as string) || "Internal Server Error"
    );
  }
}

export {
  getA11yData,
  nearbyA11y,
  getBathroomData,
  a11yRouteRank,
  a11yRouteSelect,
  a11yAISuggestion,
};
