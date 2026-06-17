import { Router } from "express";
import { navInstructions } from "./nav-instructions.controller";
import { validateRequest } from "../../middleware/validate-request.middleware";
import { NavInstructionsRequestSchema } from "./nav-instructions.schema";

export function createNavInstructionsRouter(): Router {
  const router = Router();
  router.post(
    "/route/instructions",
    validateRequest({ body: NavInstructionsRequestSchema }),
    navInstructions,
  );
  return router;
}
