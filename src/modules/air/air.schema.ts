import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { registry } from "../../openapi/registry";

extendZodWithOpenApi(z);

// ── OpenAPI path registrations ──────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/air/air-quality",
  tags: ["Air Quality"],
  summary: "Get current air quality information",
  responses: {
    200: { description: "Air quality data" },
    500: { description: "Internal error" },
  },
});
