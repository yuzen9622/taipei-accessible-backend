import { Router } from "express";
import middleware from "../../middleware/middleware";
import { validateRequest } from "../../middleware/validate-request.middleware";
import {
  createReport,
  getNearbyReports,
  getReport,
  getMyReports,
  confirmReport,
} from "./hazard-report.controller";
import {
  CreateHazardReportSchema,
  NearbyReportsQuerySchema,
  MyReportsQuerySchema,
  ReportIdParamSchema,
  ConfirmSchema,
} from "./hazard-report.schema";
import {
  uploadPhoto,
  postReportsLimiter,
  confirmLimiter,
  nearbyLimiter,
} from "./hazard-report.middleware";

export function createHazardReportRouter(): Router {
  const router = Router();

  router.post(
    "/reports",
    postReportsLimiter,
    middleware,
    uploadPhoto,
    validateRequest({ body: CreateHazardReportSchema }),
    createReport,
  );

  router.get(
    "/reports/mine",
    middleware,
    validateRequest({ query: MyReportsQuerySchema }),
    getMyReports,
  );

  router.get(
    "/reports",
    nearbyLimiter,
    validateRequest({ query: NearbyReportsQuerySchema }),
    getNearbyReports,
  );

  router.get(
    "/reports/:id",
    validateRequest({ params: ReportIdParamSchema }),
    getReport,
  );

  router.post(
    "/reports/:id/confirm",
    confirmLimiter,
    validateRequest({ params: ReportIdParamSchema, body: ConfirmSchema }),
    confirmReport,
  );

  return router;
}
