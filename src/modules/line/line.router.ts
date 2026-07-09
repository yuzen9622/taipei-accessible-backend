import { Router } from "express";
import { getRoutePreview, handleWebhook } from "./line.controller";
import {
  webhookRawBody,
  lineSignatureMiddleware,
  webhookLimiter,
  webhookErrorHandler,
} from "./line.middleware";
import { validateRequest } from "../../middleware/validate-request.middleware";
import { RoutePreviewQuerySchema } from "./line.schema";

export function createLineRouter(): Router {
  const router = Router();

  router.get(
    "/route-preview",
    validateRequest({ query: RoutePreviewQuerySchema }),
    getRoutePreview,
  );

  router.post(
    "/webhook",
    webhookLimiter,
    webhookRawBody,
    lineSignatureMiddleware,
    handleWebhook,
    webhookErrorHandler,
  );

  return router;
}
