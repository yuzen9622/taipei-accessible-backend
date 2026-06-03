import { Router } from "express";
import {
  getBusData,
  getRealtimeBusPosition,
} from "./transit.controller";
import { validateRequest } from "../../middleware/validate-request.middleware";
import { BusBodySchema, BusRealtimeQuerySchema } from "./transit.schema";

export function createTransitRouter(): Router {
  const router = Router();

  router.post("/bus", validateRequest({ body: BusBodySchema }), getBusData);
  router.get(
    "/bus/realtime",
    validateRequest({ query: BusRealtimeQuerySchema }),
    getRealtimeBusPosition,
  );

  return router;
}
