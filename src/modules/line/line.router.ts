import { Router } from "express";
import { handleWebhook } from "./line.controller";
import {
  webhookRawBody,
  lineSignatureMiddleware,
  webhookLimiter,
  webhookErrorHandler,
} from "./line.middleware";

export function createLineRouter(): Router {
  const router = Router();

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
