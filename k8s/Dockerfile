# ─────────────────────────────────────────────
# Stage 1 — Install all workspace dependencies
# ─────────────────────────────────────────────
FROM node:20-slim AS deps

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /build

# Copy manifests first for better layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY lib/db/package.json                          lib/db/
COPY lib/api-zod/package.json                     lib/api-zod/
COPY lib/integrations-openai-ai-server/package.json lib/integrations-openai-ai-server/
COPY artifacts/api-server/package.json            artifacts/api-server/
COPY artifacts/cw-recorder/package.json           artifacts/cw-recorder/

RUN pnpm install --frozen-lockfile

# Copy full source
COPY . .

# ─────────────────────────────────────
# Stage 2 — Build the React frontend
# ─────────────────────────────────────
FROM deps AS frontend-build

WORKDIR /build
RUN pnpm --filter @workspace/cw-recorder build

# ─────────────────────────────────────
# Stage 3 — Build the API server
# ─────────────────────────────────────
FROM deps AS api-build

WORKDIR /build
RUN pnpm --filter @workspace/api-server build

# ────────────────────────────────────────────────────────────────────────
# Stage 4 — Final image (Playwright base for Chromium + browser OS deps)
# ────────────────────────────────────────────────────────────────────────
FROM mcr.microsoft.com/playwright/node:20-noble AS final

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Install only production node_modules needed at runtime
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY lib/db/package.json                          lib/db/
COPY lib/api-zod/package.json                     lib/api-zod/
COPY lib/integrations-openai-ai-server/package.json lib/integrations-openai-ai-server/
COPY artifacts/api-server/package.json            artifacts/api-server/

RUN pnpm install --frozen-lockfile --prod

# Copy compiled api-server bundle
COPY --from=api-build /build/artifacts/api-server/dist ./artifacts/api-server/dist

# Copy built frontend assets (served by nginx sidecar)
COPY --from=frontend-build /build/artifacts/cw-recorder/dist ./frontend-dist

# Persistent data directory (mounted as PVC in Kubernetes)
RUN mkdir -p /data /tmp/cw-sessions /tmp/cw-screenshots /tmp/cw-reports

# Playwright — install only Chromium (already present in the base image,
# but this ensures the correct version for the installed @playwright/test)
RUN npx playwright install chromium --with-deps 2>/dev/null || true

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

# Data directory override so snapshots land on the PVC
ENV DATA_DIR=/data

CMD ["node", "artifacts/api-server/dist/index.cjs"]
