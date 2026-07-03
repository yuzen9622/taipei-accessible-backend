import { Router } from "express";
import { validateRequest } from "../../middleware/validate-request.middleware";
import {
  nearbyCampus,
  listCampus,
  getCampusByBranchId,
} from "./campus.controller";
import {
  CampusNearbyQuerySchema,
  CampusListQuerySchema,
  CampusParamsSchema,
} from "./campus.schema";

export function createCampusRouter(): Router {
  const router = Router();
  router.get(
    "/campus/nearby",
    validateRequest({ query: CampusNearbyQuerySchema }),
    nearbyCampus
  );
  router.get(
    "/campus",
    validateRequest({ query: CampusListQuerySchema }),
    listCampus
  );
  router.get(
    "/campus/:branchId",
    validateRequest({ params: CampusParamsSchema }),
    getCampusByBranchId
  );
  return router;
}
