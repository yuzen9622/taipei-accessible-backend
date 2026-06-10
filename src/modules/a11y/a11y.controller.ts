import type { Request, Response } from "express";
import { IA11y } from "../../types";
import A11y from "../../model/a11y.model";
import { sendResponse } from "../../config/lib";
import { ApiResponse } from "../../types/response";
import BathroomModel from "../../model/bathroom.model";
import OsmA11y from "../../model/osm-a11y.model";

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

/**
 * Phase 14: full-detail lookup for OSM a11y facilities. Route responses carry
 * slimmed facility objects (whitelisted tags only); this endpoint returns the
 * complete documents on demand. `osmId` accepts a comma-separated list.
 */
async function getA11yPlace(req: Request, res: Response<ApiResponse<any>>) {
  try {
    const raw = String(req.query.osmId ?? "");
    const ids = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!ids.length) {
      return sendResponse(res, false, "error", 400, "缺少必要參數：osmId");
    }
    const places = await OsmA11y.find({ osmId: { $in: ids } }).lean();
    if (!places.length) {
      return sendResponse(res, false, "error", 404, "查無此設施");
    }
    return sendResponse(res, true, "success", 200, "OK", places);
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

    const coords = [Number(lng as string), Number(lat as string)];
    const geoQuery = {
      $near: {
        $geometry: { type: "Point", coordinates: coords },
        $maxDistance: 150,
      },
    };

    const [nearbyMetroA11y, nearbyBathroom, nearbyOsm] = await Promise.all([
      A11y.find({ location: geoQuery }),
      BathroomModel.find({ type: "無障礙廁所", location: geoQuery }),
      OsmA11y.find({ location: geoQuery }),
    ]);

    return sendResponse(res, true, "success", 200, "OK", {
      nearbyBathroom,
      nearbyMetroA11y,
      nearbyOsm,
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
  getA11yPlace,
};
