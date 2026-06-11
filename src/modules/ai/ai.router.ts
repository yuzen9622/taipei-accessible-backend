import { Router } from "express";
import { aiIntent, aiExplain } from "./ai.controller";
import { aiChat } from "./ai.chat.controller";
import { validateRequest } from "../../middleware/validate-request.middleware";
import { IntentBodySchema, ExplainBodySchema, AgentChatRequestSchema } from "./ai.schema";

export function createAiRouter(): Router {
  const router = Router();
  router.post("/intent", validateRequest({ body: IntentBodySchema }), aiIntent);
  router.post(
    "/explain",
    validateRequest({ body: ExplainBodySchema }),
    aiExplain
  );
  router.post("/chat", validateRequest({ body: AgentChatRequestSchema }), aiChat);
  return router;
}
