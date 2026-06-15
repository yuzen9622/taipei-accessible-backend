import { Router } from "express";
import { getAirQualityInfo } from "./air.controller";
import { validateRequest } from "../../middleware/validate-request.middleware";
import { AirQualityQuerySchema } from "./air.schema";

export function createAirRouter(): Router {
  const router = Router();

  router.get(
    "/air-quality",
    validateRequest({ query: AirQualityQuerySchema }),
    getAirQualityInfo,
  );

  return router;
}
