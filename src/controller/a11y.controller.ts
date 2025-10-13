import type { Request, Response } from "express";
import { IA11y } from "../types";
import A11y from "../model/a11y.model";
import { sendResponse } from "../config/lib";
import { ApiResponse } from "../types/response";
import BathroomModel from "../model/bathroom.model";

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

async function nearbyA11y(req: Request, res: Response<ApiResponse<any>>) {
  try {
    const { lat, lng } = req.query;
    // const client = new Client({});
    // const response = await client.directions({
    //   params: {
    //     origin: origin as string,
    //     destination: destination as string,
    //     mode: TravelMode.transit,
    //     key: process.env.GOOGLE_MAPS_API_KEY!,
    //   },
    // });
    // let prevStep = response.data.routes[0].legs[0].steps[0];
    // const walkingSteps = response.data.routes[0].legs[0].steps.map((step) => {
    //   if (
    //     step.travel_mode === ("WALKING" as string) &&
    //     prevStep.travel_mode === ("TRANSIT" as string)
    //   ) {
    //     prevStep = step;
    //     return step.start_location;
    //   } else {
    //     return step.end_location;
    //   }
    // });

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

    return sendResponse(res, true, "success", 200, "OK", [
      ...nearbyBathroom,
      ...nearbyMetroA11y,
    ]);
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

export { getA11yData, nearbyA11y, getBathroomData };
