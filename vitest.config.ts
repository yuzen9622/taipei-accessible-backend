import { defineConfig } from "vitest/config";

// Minimal unit-test setup. Scoped to src/**/*.test.ts so the pure-function
// scoring tests run in isolation; the live-server integration script under
// tests/ (axios → a running API) is intentionally excluded.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // ranking.test.ts imports the service, which transitively constructs an
    // OpenAI client at module load (src/config/ai.ts). The client is never
    // called in tests — a dummy key just lets the constructor succeed without
    // depending on a real .env.
    env: {
      GEMINI_API_KEY: "test-dummy",
      OPENAI_API_KEY: "test-dummy",
    },
  },
});
