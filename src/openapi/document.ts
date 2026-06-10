import { OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { registry } from "./registry";

// Import schema files for side-effects — each file calls registry.registerPath()
import "../modules/a11y/a11y.schema";
import "../modules/accessible-route/accessible-route.schema";
import "../modules/chatbot/chatbot.schema";
import "../modules/transit/transit.schema";
import "../modules/user/user.schema";
import "../modules/air/air.schema";
import "../modules/ai/ai.schema";

export function generateOpenAPIDocument() {
  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: "3.0.0",
    info: {
      title: "Taipei Accessible API",
      version: "1.0.0",
      description:
        "Backend API for the Taipei Accessible project — accessibility places, AI chatbot, transit data, and user management.",
    },
    servers: [{ url: "/api/v1", description: "Current environment" }],
  });
}
