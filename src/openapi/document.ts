import { OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { registry } from "./registry";

// Import schema files for side-effects — each file calls registry.registerPath()
import "../modules/a11y/a11y.schema";
import "../modules/accessible-route/accessible-route.schema";
import "../modules/transit/transit.schema";
import "../modules/user/user.schema";
import "../modules/air/air.schema";
import "../modules/ai/ai.schema";

export function generateOpenAPIDocument() {
  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: "3.0.0",
    info: {
      title: "台北無障礙 API",
      version: "1.0.0",
      description:
        "台北無障礙專案後端 API：無障礙地點、AI 聊天機器人、交通資料與使用者管理。",
    },
    servers: [{ url: "/api/v1", description: "目前環境" }],
  });
}
