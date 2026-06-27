import { Router } from "express";
import {
  getBusRouteHandler,
  getBusRouteDetailHandler,
  getBusArrivalHandler,
  getBusTimetableHandler,
  getBusPositionsHandler,
  searchBusRoutesHandler,
  getNearbyStopsHandler,
} from "./transit.controller";
import { validateRequest } from "../../middleware/validate-request.middleware";
import {
  BusRouteQuerySchema,
  BusArrivalQuerySchema,
  BusTimetableQuerySchema,
  BusPositionsQuerySchema,
  BusSearchQuerySchema,
  BusNearbyQuerySchema,
} from "./transit.schema";

export function createTransitRouter(): Router {
  const router = Router();

  router.get(
    "/bus/route",
    validateRequest({ query: BusRouteQuerySchema }),
    getBusRouteHandler,
  );
  router.get(
    "/bus/route-detail",
    validateRequest({ query: BusRouteQuerySchema }), // Use the same schema
    getBusRouteDetailHandler,
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
    "/bus/nearby-stops",
    validateRequest({ query: BusNearbyQuerySchema }),
    getNearbyStopsHandler,
  );

  return router;
}
