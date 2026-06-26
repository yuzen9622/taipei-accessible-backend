import { Router } from "express";
import {
  getBusData,
  getRealtimeBusPosition,
  getBusRouteHandler,
  getBusArrivalHandler,
  getBusTimetableHandler,
  getBusPositionsHandler,
  searchBusRoutesHandler,
  getBusRouteStopsHandler,
  getNearbyStopsHandler,
} from "./transit.controller";
import { validateRequest } from "../../middleware/validate-request.middleware";
import {
  BusBodySchema,
  BusRealtimeQuerySchema,
  BusRouteQuerySchema,
  BusArrivalQuerySchema,
  BusTimetableQuerySchema,
  BusPositionsQuerySchema,
  BusSearchQuerySchema,
  BusRouteStopsQuerySchema,
  BusNearbyQuerySchema,
} from "./transit.schema";

export function createTransitRouter(): Router {
  const router = Router();

  router.post("/bus", validateRequest({ body: BusBodySchema }), getBusData);
  router.get(
    "/bus/realtime",
    validateRequest({ query: BusRealtimeQuerySchema }),
    getRealtimeBusPosition,
  );

  router.get(
    "/bus/route",
    validateRequest({ query: BusRouteQuerySchema }),
    getBusRouteHandler,
  );
  router.get(
    "/bus/arrival",
    validateRequest({ query: BusArrivalQuerySchema }),
    getBusArrivalHandler,
  );
  router.get(
    "/bus/timetable",
    validateRequest({ query: BusTimetableQuerySchema }),
    getBusTimetableHandler,
  );
  router.get(
    "/bus/positions",
    validateRequest({ query: BusPositionsQuerySchema }),
    getBusPositionsHandler,
  );

  router.get(
    "/bus/search-routes",
    validateRequest({ query: BusSearchQuerySchema }),
    searchBusRoutesHandler,
  );
  router.get(
    "/bus/route-stops",
    validateRequest({ query: BusRouteStopsQuerySchema }),
    getBusRouteStopsHandler,
  );
  router.get(
    "/bus/nearby-stops",
    validateRequest({ query: BusNearbyQuerySchema }),
    getNearbyStopsHandler,
  );

  return router;
}
