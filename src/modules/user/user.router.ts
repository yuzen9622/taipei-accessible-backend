import { Router } from "express";
import {
  login,
  token,
  refresh,
  info,
  config,
  updateConfig,
  logout,
} from "./user.controller";
import { validateRequest } from "../../middleware/validate-request.middleware";
import {
  LoginBodySchema,
  TokenBodySchema,
  ConfigBodySchema,
  UpdateConfigBodySchema,
} from "./user.schema";

export function createUserRouter(): Router {
  const router = Router();

  router.post("/login", validateRequest({ body: LoginBodySchema }), login);
  router.post("/token", validateRequest({ body: TokenBodySchema }), token);
  router.post("/refresh", refresh);
  router.get("/info", info);
  router.post("/config", validateRequest({ body: ConfigBodySchema }), config);
  router.post(
    "/config/update",
    validateRequest({ body: UpdateConfigBodySchema }),
    updateConfig,
  );
  router.post("/logout", logout);

  return router;
}
