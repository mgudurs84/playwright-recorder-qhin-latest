# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## AutoResearch App

A full-stack AI research assistant at `artifacts/autoresearch/`. Key features:

- **CopilotKit v1.54** frontend chat UI (`@copilotkit/react-core`, `@copilotkit/react-ui`)
- **Vertex AI Gemini 2.5 Flash Lite** via `@ai-sdk/google-vertex` (GCP project: `vertex-ai-demo-468112`)
- **Human-in-the-loop**: Agent pauses at planning and mid-research phases to ask for user input
- **YAML skill files** define each agent's behavior (`artifacts/api-server/src/skills/*.yaml`)
- **CopilotKit runtime** endpoint at `POST /api/copilotkit` via `copilotRuntimeNodeHttpEndpoint`
- **Session persistence**: Research sessions, steps, and reports stored in PostgreSQL

### YAML Skill Files
- `planner-agent.yaml` — planning phase behavior & clarifying questions
- `search-agent.yaml` — research phase behavior & mid-research check-in
- `synthesizer-agent.yaml` — synthesis and final report format
- `loader.ts` — reads YAML files and builds a unified system prompt for the agent

### GCP Vertex AI Agent Engine
The three agents are registered as **Reasoning Engines** in Vertex AI Agent Engine
(GCP project `vertex-ai-demo-468112`, location `us-central1`):

| Agent | GCP Agent ID | Env var |
|---|---|---|
| AutoResearch Planner | `2955468563764215808` | `GCP_AGENT_PLANNER` |
| AutoResearch Searcher | `3132797799091929088` | `GCP_AGENT_SEARCHER` |
| AutoResearch Synthesizer | `7777134914817753088` | `GCP_AGENT_SYNTHESIZER` |

View in GCP Console: https://console.cloud.google.com/vertex-ai/reasoning-engines?project=vertex-ai-demo-468112

Agent metadata is stored in `artifacts/api-server/gcp-agents.json`.
Creation script: `artifacts/api-server/src/create-gcp-agents-final.ts` (re-run to recreate if deleted).

### CopilotKit Routing Note (Express v5 compatibility)
Express v5 uses a new `path-to-regexp` that breaks `*` wildcards. CopilotKit's endpoint uses Hono
internally with a `basePath`. The workaround: mount with `app.use(COPILOTKIT_PATH, handler)` and
restore the full URL by prepending the base path before calling the handler:
```
req.url = COPILOTKIT_PATH + (originalUrl === "/" ? "" : originalUrl);
```

## CommonWell Recorder App

A chat-based Playwright automation tool at `artifacts/cw-recorder/`. Key features:

- **Three CopilotKit agents**: Auth → Navigator → Reporter pipeline
- **Playwright browser automation** for CommonWell Health Alliance portal
- **DOM table extraction** via Kendo DataSource API fast path + DOM pagination fallback (no vision AI)
- **Session persistence**: Browser sessions saved/loaded from PostgreSQL (`cw_sessions` table)
- **Run tracking**: Automation runs with steps, records, screenshots (`cw_runs` table)
- **Retry logic**: `withRetry` wrapper on all Playwright operations (login, OTP submit, navigation, date filter, data loading, Kendo extraction, DOM pagination), exponential backoff, stale-element page reload, browser crash recovery
- **OTP state machine**: Explicit `waitingForOtp` phase with phase guards on all tools — navigation/extraction tools reject calls until auth completes; OTP submit only allowed in `waitingForOtp` phase
- **Phase guards**: All agent tools enforce phase ordering (idle → authenticating → waitingForOtp → authenticated → navigating → extracted → reporting → complete)
- **Screenshot serving** at `/api/screenshots/*` from `/tmp/cw-screenshots` (CORS scoped to dev domain)

### CW Backend Routes
- `POST /api/cw-copilotkit` — CopilotKit runtime for CW agents (separate from AutoResearch runtime)
- `GET /api/cw-copilotkit/info` — Agent info endpoint
- `GET /api/cw/runs` — List recent runs
- `GET /api/cw/runs/:id` — Get run details
- YAML skill files: `cw-auth-agent.yaml`, `cw-navigator-agent.yaml`, `cw-reporter-agent.yaml`

### CW Frontend
- CopilotKit chat with agent stepper (Auth → Navigate → Report)
- Run history sidebar with auto-refresh
- Run detail page with step timeline and screenshots
- Frontend transition actions use `ui*` prefix names to avoid collision with backend tool names

### Environment Variables
- `CW_USERNAME` / `CW_PASSWORD` — CommonWell portal credentials
- `GCP_SERVICE_ACCOUNT_JSON` — Required for Vertex AI model

## CW Transaction Analyzer App

A standalone transaction analysis tool at `artifacts/cw-tx-analyzer/` (frontend) + `artifacts/tx-analyzer-api/` (API server). Key features:

- **Playwright auth**: Headless browser login + OTP → session cookies saved to `data/session.json`
- **Direct HTTP**: Calls `POST /TransactionLogs/LoadTransactionLogsDetailPartialView` using saved cookies (no browser needed after login)
- **HTML parsing**: `node-html-parser` extracts all transaction fields and OID values from portal HTML
- **OID resolver**: Resolves OIDs to org names via cache (`data/oid-cache.json`) + live portal lookup
- **Vertex AI L1/L2 analysis**: Gemini 2.5 Flash generates structured JSON (summary, rootCause, l1Actions, l2Actions, severity, resolution)
- **Batch CSV upload**: Up to 500 transactions at concurrency 5, with full AI analysis per row
- **CSV export**: Batch results exported with all AI columns appended
- **Screenshot toggle**: Playwright navigates to transaction detail for a full-page screenshot
- **CVS Health themed UI**: Red header, clean white cards, single/batch tab modes

### TX Analyzer Routes (`/api/*`)
- `POST /api/session/login` — Playwright login + OTP flow
- `POST /api/session/otp` — OTP submission
- `GET /api/session/status` — Check session validity
- `POST /api/analyze` — Single transaction ID → full analysis
- `POST /api/batch` — CSV file upload → batch analysis
- `POST /api/screenshot` — Full-page portal screenshot

### Environment Variables (tx-analyzer-api)
- Port: 8000 (distinct from api-server on 8080)
- `CW_USERNAME` / `CW_PASSWORD` — CommonWell portal credentials
- `CW_PORTAL_URL` — Portal base URL
- `GCP_PROJECT_ID` (ADC) or `GCP_SERVICE_ACCOUNT_JSON` — Vertex AI auth
- `VERTEX_MODEL_ID`, `VERTEX_LOCATION` — Gemini model config
- `SESSION_MAX_AGE_HOURS` — Session TTL (default 24h)

## Structure

```text
artifacts-monorepo/
├── artifacts/              # Deployable applications
│   ├── api-server/         # Express API server (+ CopilotKit runtime + Vertex AI)
│   │   └── src/skills/     # YAML skill files + loader for agent prompts
│   ├── autoresearch/       # React + Vite frontend with CopilotKit chat UI
│   ├── cw-recorder/        # React + Vite CW Recorder chat UI
│   ├── tx-analyzer-api/    # CW Transaction Analyzer API server (port 8000)
│   └── cw-tx-analyzer/     # CW Transaction Analyzer React frontend
├── lib/                    # Shared libraries
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   └── db/                 # Drizzle ORM schema + DB connection
├── scripts/                # Utility scripts (single workspace package)
│   └── src/                # Individual .ts scripts, run via `pnpm --filter @workspace/scripts run <script>`
├── pnpm-workspace.yaml     # pnpm workspace (artifacts/*, lib/*, lib/integrations/*, scripts)
├── tsconfig.base.json      # Shared TS options (composite, bundler resolution, es2022)
├── tsconfig.json           # Root TS project references
└── package.json            # Root package with hoisted devDeps
```

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json` which sets `composite: true`. The root `tsconfig.json` lists all packages as project references. This means:

- **Always typecheck from the root** — run `pnpm run typecheck` (which runs `tsc --build --emitDeclarationOnly`). This builds the full dependency graph so that cross-package imports resolve correctly. Running `tsc` inside a single package will fail if its dependencies haven't been built yet.
- **`emitDeclarationOnly`** — we only emit `.d.ts` files during typecheck; actual JS bundling is handled by esbuild/tsx/vite...etc, not `tsc`.
- **Project references** — when package A depends on package B, A's `tsconfig.json` must list B in its `references` array. `tsc --build` uses this to determine build order and skip up-to-date packages.

## Root Scripts

- `pnpm run build` — runs `typecheck` first, then recursively runs `build` in all packages that define it
- `pnpm run typecheck` — runs `tsc --build --emitDeclarationOnly` using project references

## Packages

### `artifacts/api-server` (`@workspace/api-server`)

Express 5 API server. Routes live in `src/routes/` and use `@workspace/api-zod` for request and response validation and `@workspace/db` for persistence.

- Entry: `src/index.ts` — reads `PORT`, starts Express
- App setup: `src/app.ts` — mounts CORS, JSON/urlencoded parsing, routes at `/api`
- Routes: `src/routes/index.ts` mounts sub-routers; `src/routes/health.ts` exposes `GET /health` (full path: `/api/health`)
- Depends on: `@workspace/db`, `@workspace/api-zod`
- `pnpm --filter @workspace/api-server run dev` — run the dev server
- `pnpm --filter @workspace/api-server run build` — production esbuild bundle (`dist/index.cjs`)
- Build bundles an allowlist of deps (express, cors, pg, drizzle-orm, zod, etc.) and externalizes the rest

### `lib/db` (`@workspace/db`)

Database layer using Drizzle ORM with PostgreSQL. Exports a Drizzle client instance and schema models.

- `src/index.ts` — creates a `Pool` + Drizzle instance, exports schema
- `src/schema/index.ts` — barrel re-export of all models
- `src/schema/<modelname>.ts` — table definitions with `drizzle-zod` insert schemas (no models definitions exist right now)
- `drizzle.config.ts` — Drizzle Kit config (requires `DATABASE_URL`, automatically provided by Replit)
- Exports: `.` (pool, db, schema), `./schema` (schema only)

Production migrations are handled by Replit when publishing. In development, we just use `pnpm --filter @workspace/db run push`, and we fallback to `pnpm --filter @workspace/db run push-force`.

### `lib/api-spec` (`@workspace/api-spec`)

Owns the OpenAPI 3.1 spec (`openapi.yaml`) and the Orval config (`orval.config.ts`). Running codegen produces output into two sibling packages:

1. `lib/api-client-react/src/generated/` — React Query hooks + fetch client
2. `lib/api-zod/src/generated/` — Zod schemas

Run codegen: `pnpm --filter @workspace/api-spec run codegen`

### `lib/api-zod` (`@workspace/api-zod`)

Generated Zod schemas from the OpenAPI spec (e.g. `HealthCheckResponse`). Used by `api-server` for response validation.

### `lib/api-client-react` (`@workspace/api-client-react`)

Generated React Query hooks and fetch client from the OpenAPI spec (e.g. `useHealthCheck`, `healthCheck`).

### `scripts` (`@workspace/scripts`)

Utility scripts package. Each script is a `.ts` file in `src/` with a corresponding npm script in `package.json`. Run scripts via `pnpm --filter @workspace/scripts run <script>`. Scripts can import any workspace package (e.g., `@workspace/db`) by adding it as a dependency in `scripts/package.json`.
