import { Router } from "express";
import { getA11yData, nearbyA11y, getBathroomData } from "./a11y.controller";
import { validateRequest } from "../../middleware/validate-request.middleware";
import { NearbyA11yQuerySchema } from "./a11y.schema";

export function createA11yRouter(): Router {
  const router = Router();
  router.get("/all-places", getA11yData);
  router.get("/all-bathrooms", getBathroomData);
  router.get("/nearby-a11y", validateRequest({ query: NearbyA11yQuerySchema }), nearbyA11y);
  return router;
}
