import { Router } from "express";
import { getAirQualityInfo } from "./air.controller";

export function createAirRouter(): Router {
  const router = Router();

  router.get("/air-quality", getAirQualityInfo);

  return router;
}
