import { Router } from "express";
import { validateRequest } from "../../middleware/validate-request.middleware";
import { getEnvironmentInfo } from "./environment.controller";
import { EnvironmentQuerySchema } from "./environment.schema";

export function createEnvironmentRouter(): Router {
  const router = Router();

  router.get(
    "/environment",
    validateRequest({ query: EnvironmentQuerySchema }),
    getEnvironmentInfo,
  );

  return router;
}
