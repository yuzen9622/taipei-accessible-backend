import type { Request, Response } from "express";
import { AgentResponse, IA11y } from "../types";
import A11y from "../model/a11y.model";
import { sendResponse } from "../config/lib";
import { ApiResponse } from "../types/response";
import BathroomModel from "../model/bathroom.model";
import {
  rankConfig,
  rankContents,
  googleGenAi,
  model,
  routeConfig,
  routeContents,
  agentConfig,
  agentContents,
  assistantConfig,
  assistantContents,
} from "../config/ai";

import { ResponseMessage } from "../types/code";
import { send } from "process";
import { LocationType } from "@googlemaps/google-maps-services-js";

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
    const { lat, lng, message } = req.body;

    // Fetch nearby a11y data and process with AI
    const AiAgent = await googleGenAi.models.generateContent({
      model,
      contents: [
        ...agentContents,
        {
          role: "user",
          parts: [
            {
              text: JSON.stringify({ location: { lat, lng }, message }),
            },
          ],
        },
      ],
      config: agentConfig,
    });
    if (!AiAgent?.candidates?.[0].content?.parts?.[0].text) {
      return sendResponse(
        res,
        false,
        "error",
        400,
        "很抱歉，無法提供建議，我將持續學習中。",
        null
      );
    }
    console.log(AiAgent?.candidates?.[0].content?.parts?.[0].text);
    const agentType: AgentResponse = JSON.parse(
      AiAgent?.candidates?.[0].content?.parts?.[0].text
    );
    console.log(agentType);

    if (agentType.action === "findNearbyA11y") {
      const { location, range } = agentType;

      const nearbyMetroA11y = await A11y.find({
        location: {
          $near: {
            $geometry: {
              type: "Point",
              coordinates: [Number(location?.lng), Number(location?.lat)],
            },
            $maxDistance: range || 300,
          },
        },
      });
      const nearbyBathroom = await BathroomModel.find({
        type: "無障礙廁所",
        location: {
          $near: {
            $geometry: {
              type: "Point",
              coordinates: [Number(location?.lng), Number(location?.lat)],
            },
            $maxDistance: 150,
          },
        },
      });
      const AiChat = await googleGenAi.models.generateContent({
        model,

        contents: [
          ...assistantContents,
          {
            role: "user",
            parts: [
              {
                text: JSON.stringify({
                  location: [Number(location?.lng), Number(location?.lat)],
                  nearbyA11y: { nearbyBathroom, nearbyMetroA11y },
                  message,
                }),
              },
            ],
          },
        ],
        config: assistantConfig,
      });
      return sendResponse(res, true, "success", 200, "OK", {
        nearbyBathroom,
        nearbyMetroA11y,
        message: AiChat?.candidates?.[0].content?.parts?.[0].text ?? "",
      });
    } else if (agentType.action == "googleSearch") {
      const AiChat = await googleGenAi.models.generateContent({
        model,

        contents: [
          ...assistantContents,
          {
            role: "user",
            parts: [
              {
                text: JSON.stringify({
                  location: { lat, lng },
                  message: agentType.query || message,
                }),
              },
            ],
          },
        ],
        config: assistantConfig,
      });
      return sendResponse(res, true, "success", 200, "OK", {
        message: AiChat?.candidates?.[0].content?.parts?.[0].text ?? "",
      });
    } else if (agentType.action == "transportInfo") {
      const AiChat = await googleGenAi.models.generateContent({
        model,

        contents: [
          ...assistantContents,
          {
            role: "user",
            parts: [
              {
                text: JSON.stringify({ location: { lat, lng }, message }),
              },
            ],
          },
        ],
        config: assistantConfig,
      });
      return sendResponse(res, true, "success", 200, "OK", {
        message: AiChat?.candidates?.[0].content?.parts?.[0].text ?? "",
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
