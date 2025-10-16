import type { Request, Response } from "express";
import { IA11y } from "../types";
import A11y from "../model/a11y.model";
import { sendResponse } from "../config/lib";
import { ApiResponse } from "../types/response";
import BathroomModel from "../model/bathroom.model";
import { config, contents, googleGenAi, model } from "../config/ai";
import route from "../routes/user.route";
import { ResponseMessage } from "../types/code";

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
        ...contents,

        {
          role: "user",
          parts: [
            {
              text: JSON.stringify({ routes_data: routes }),
            },
          ],
        },
      ],
      config,
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

export { getA11yData, nearbyA11y, getBathroomData, a11yRouteRank };
