import { Router } from "express";
import { a11yRouteRank, a11yRouteSelect, a11yAISuggestion } from "./chatbot.controller";
import { validateRequest } from "../../middleware/validate-request.middleware";
import { RouteRankBodySchema, RouteSelectBodySchema, ChatbotBodySchema } from "./chatbot.schema";

export function createChatbotRouter(): Router {
  const router = Router();
  router.post("/route-rank", validateRequest({ body: RouteRankBodySchema }), a11yRouteRank);
  router.post("/route-select", validateRequest({ body: RouteSelectBodySchema }), a11yRouteSelect);
  router.post("/chatbot", validateRequest({ body: ChatbotBodySchema }), a11yAISuggestion);
  return router;
}
