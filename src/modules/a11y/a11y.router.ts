import { Router } from "express";
import {
  getAllFacilities,
  getBathrooms,
  getRamps,
  getElevators,
  nearbyA11y,
  nearbyParking,
  getA11yPlace,
} from "./a11y.controller";
import { validateRequest } from "../../middleware/validate-request.middleware";
import {
  NearbyA11yQuerySchema,
  A11yPlaceQuerySchema,
  ParkingNearbyQuerySchema,
} from "./a11y.schema";

export function createA11yRouter(): Router {
  const router = Router();
  router.get("/all-facilities", getAllFacilities);
  router.get("/all-bathrooms", getBathrooms);
  router.get("/all-ramps", getRamps);
  router.get("/all-elevators", getElevators);
  router.get("/nearby-a11y", validateRequest({ query: NearbyA11yQuerySchema }), nearbyA11y);
  router.get("/parking/nearby", validateRequest({ query: ParkingNearbyQuerySchema }), nearbyParking);
  router.get("/place", validateRequest({ query: A11yPlaceQuerySchema }), getA11yPlace);
  return router;
}
