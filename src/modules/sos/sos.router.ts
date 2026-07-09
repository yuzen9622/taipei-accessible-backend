import { Router } from "express";
import middleware from "../../middleware/middleware";
import { validateRequest } from "../../middleware/validate-request.middleware";
import {
  createSession,
  updateLocation,
  resolveSession,
  getPublicSession,
} from "./sos.controller";
import {
  CreateSosSchema,
  UpdateSosLocationSchema,
  SessionIdParamSchema,
  ShareTokenParamSchema,
} from "./sos.schema";

export function createSosRouter(): Router {
  const router = Router();

  router.post(
    "/sessions",
    middleware,
    validateRequest({ body: CreateSosSchema }),
    createSession,
  );

  router.patch(
    "/sessions/:id/location",
    middleware,
    validateRequest({ params: SessionIdParamSchema, body: UpdateSosLocationSchema }),
    updateLocation,
  );

  router.patch(
    "/sessions/:id/resolve",
    middleware,
    validateRequest({ params: SessionIdParamSchema }),
    resolveSession,
  );

  router.get(
    "/sessions/:token/public",
    validateRequest({ params: ShareTokenParamSchema }),
    getPublicSession,
  );

  return router;
}
