# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # Start dev server with hot reload (ts-node via nodemon + dotenvx)
npm run build     # Compile TypeScript → dist/
npm start         # Run compiled dist/server.js
npm run clean     # Delete dist/
```

There is no test framework configured.

## Environment Variables

Copy `.env.example` to `.env`. Required variables:

| Variable | Purpose |
|---|---|
| `PORT` | Server port (default 5000) |
| `CORS_ORIGINS` | Comma-separated allowed origins |
| `GOOGLE_MAPS_API_KEY` | Google Maps reverse geocoding + Places Text Search |
| `GEMINI_API_KEY` | Google Gemini AI (auto-read by `@google/genai` SDK) |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | JWT signing |
| `DATABASE_URL` | MongoDB connection URI |
| `TDX_CLIENT_ID` / `TDX_CLIENT_SECRET` | Taiwan transport data API credentials |
| `USE_OTP_ROUTER` | Phase 16 OTP2 planner rollout: `false` \| `shadow` (log diff only) \| `true` (merge) |
| `OTP_BASE_URL` | OTP2 sidecar GraphQL server (default `http://localhost:8080`, internal only) |
| `GEMINI_API_URL` | OpenAI-compatible base URL for the AI API (default: Gemini's `/v1beta/openai` endpoint) |
| `GEMINI_MODEL` | Model name used by all AI features (default: `gemini-2.5-flash`) |

## Architecture

### Request flow

```
client → app.ts (Express) → routes/ → controller/ → (model/ | config/ | service/)
```

`/api/user/*` routes pass through `middleware/middleware.ts` (JWT auth). All other routes are public. The auth middleware bypasses validation for `/login`, `/token`, `/refresh`, `/logout`.

### Route groups

| Prefix | Route file | Domain |
|---|---|---|
| `/api/user` | `user.route.ts` | Auth (JWT-protected) |
| `/api/transit` | `transit.route.ts` | Bus/train real-time data |
| `/api/a11y` | `a11y.route.ts` | Accessibility places + AI chatbot |

### Response shape

All controllers use `sendResponse()` from `src/config/lib.ts`. The shape is:

```ts
{ ok, status, code, message, data?, accessToken? }
```

The refresh token is set as an `httpOnly` cookie (not in the JSON body).

### Agent Chat flow (`POST /api/v1/ai/chat`)

The `aiChat` controller in `ai.chat.controller.ts` implements an **OpenAI-compatible streaming Agent**:

1. **Request** — `{ model?, messages, stream?, temperature?, userLocation? }` (OpenAI Chat Completions format).
2. **Tool loop (non-streaming)** — backend calls LLM with 7 local tools defined in `src/config/ai/tool.ts`. If the model returns `finish_reason: "tool_calls"`, the backend executes the matching function in `agent-tools.ts` and feeds results back. Loop repeats up to 5 times.
3. **Streaming response** — after all tools are resolved, the final answer is streamed as SSE (`event: tool_call`, `event: tool_result`, then OpenAI delta chunks, ending with `data: [DONE]`).

The 7 tools: `findGooglePlaces`, `findA11yPlaces` (upgraded with OsmA11y), `planAccessibleRoute` (calls `findAccessibleRoutes`), `getBusArrivalEstimate`, `getBusPosition`, `getAirQuality`, `getA11yFacilityDetails`.

### AI chatbot flow (`POST /api/a11y/chatbot`)

The `a11yAISuggestion` controller in `a11y.controller.ts` implements a two-step Gemini tool-calling loop:

1. **First call** — Gemini may return a function call (`findGooglePlaces`, `findA11yPlaces`, or `planRoute`) instead of text.
2. **Tool execution** — the matching function in `ai.controller.ts` runs (queries Google Places or MongoDB).
3. **Second call** — the tool result is fed back to Gemini (`role: "tool"`) and a final text response is produced.

AI configs (temperature, response schema, tool declarations) live in `src/config/ai/`. The model is `gemini-2.5-flash` (`src/config/ai.ts`).

### TDX transit API

`src/service/TdxTokenManger.ts` is a singleton that handles OAuth2 `client_credentials` token acquisition and caching for the Taiwan transport data platform. All TDX HTTP calls go through `tdxFetch()` in `src/config/fetch.ts`, which auto-attaches the Bearer token and retries once on 401.

Bus route type (city vs. inter-city) is auto-detected from the route name by `detectBusApiType()` in `src/config/lib.ts`.

### MongoDB models

- `A11y` — MRT elevator/ramp accessibility exits with a `2dsphere` index for geospatial `$near` queries.
- `BathroomModel` — accessible bathrooms, also with geospatial queries.
- `UserModel` — user accounts with bcrypt passwords.
