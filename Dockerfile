# syntax=docker/dockerfile:1
# Multi-stage build for the Node API.
# Runtime needs only dist/ + production deps — the app reads no files from disk
# at runtime (a11y data lives in MongoDB, transit in the OTP sidecar).

# ── builder: full deps + compile TS → dist ──────────────────────────────────
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
# --ignore-scripts skips the `postinstall: npm run build` hook here: src/ isn't
# copied yet, so an automatic build would fail. We build explicitly below.
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build

# ── runtime: production deps + compiled output only ─────────────────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=builder /app/dist ./dist
# Drop privileges — the node image ships a non-root `node` user.
USER node
# Documentation only; the real port comes from PORT in the injected env.
EXPOSE 8000
CMD ["node", "dist/server.js"]
