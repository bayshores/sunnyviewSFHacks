# AGENTS.md

Guidelines for agentic coding tools working in this repository.
Use this file by default unless a higher-priority local rule file exists.

## Scope and Rule Priority

- Scope: everything under repository root (`.`).
- Priority order:
  1) direct user instruction
  2) local rule files (`.cursor/rules/`, `.cursorrules`, `.github/copilot-instructions.md`)
  3) this `AGENTS.md`
  4) existing file-level conventions
- Never run destructive git commands unless explicitly requested.

## Local Rule Files (checked)

As of 2026-10-20, these are **not present**:

- `.cursor/rules/`
- `.cursorrules`
- `.github/copilot-instructions.md`

If they appear later, they override this file where conflicting.

## Repository Snapshot

- Stack: Next.js 16 (App Router, webpack builds), TypeScript (strict), React 19.
- Lint: ESLint with `eslint-config-next` (`eslint.config.mjs`).
- Unit and route tests: Vitest (`vitest.config.ts`, includes `lib/**`, `app/**` and `components/**` `*.test.ts` files). Shared test helper: `test/history-fake-db.ts`.
- E2E: Playwright via `npm run test:e2e`. The Playwright config and `e2e/` suite are in progress and not yet in the repo.
- Optional Python service: `services/segmenter/` (FastAPI, see its README).
- Import alias: `@/*` maps to project root.

### Code layout

- `app/`: pages (`app/page.tsx`, `app/settings/page.tsx`, `app/s/[shareSlug]/page.tsx`) and route handlers under `app/api/`.
- `components/sunnyview/`: main app flow (hooks such as `use-packing-and-estimate.ts`, `use-roof-outline.ts`, `use-project-sync.ts`, plus panels and dialogs).
- `components/roof-editor/`: roof outline canvas editor (geometry, interactions, view transform).
- `components/globe/`: Cesium globe setup and camera/orbit hooks.
- `components/PanelPacking.ts`: panel packing used in the browser.
- `lib/geo/`: geo math, Mercator, geocoding providers, street helpers.
- `lib/segment/`: segmentation helpers (address resolution, OSM buildings, SSRF-safe image fetch, guidance).
- `lib/projects-*.ts` and `lib/history-*.ts`: MongoDB stores, HTTP helpers, types, client API wrappers.
- `lib/rate-limit.ts`, `lib/redis.ts`, `lib/mongo.ts`, `lib/pvwatts.ts`, `lib/co2.ts`, `lib/solar-defaults.ts`, `lib/arcgis-imagery.ts`, `lib/schemas.ts`.
- `services/segmenter/`: Python segmenter. `main.py` (FastAPI app) delegates to `onnx_stage.py`, `heuristic_stage.py`, `sam_stage.py`, `plane_split.py`, `postprocess.py`, `geometry.py`, `env_config.py`, `segment_context.py`, `sam_model.py` and `onnx_roofseg.py`.
- `structurizr/`: C4 workspace (`workspace.dsl`) and the PNG export script.

### Implemented local Next.js API routes

All routes are in `app/api/`. Every route is rate limited (see "API Validation" below).

- `GET /api/geocode`
- `GET /api/reverse-geocode`
- `GET /api/static-map`
- `POST /api/estimate`
- `POST /api/segment`
- `POST /api/explain` (template-based, no LLM)
- `POST /api/tts`
- `GET /api/forecast`
- `POST /api/panel-recommend` (Gemini)
- `POST /api/gemini-validate`
- `POST /api/elevenlabs-validate`
- `GET /api/history`, `POST /api/history`
- `GET|PATCH|DELETE /api/history/[id]`
- `POST /api/projects`
- `GET|PATCH /api/projects/[id]`
- `GET /api/share/[slug]` (public, read-only JSON)
- `GET /s/[shareSlug]` (public share page, reads `/api/share/[slug]`)

### Persistence and sharing (MongoDB)

- History (`lib/history-*`) and projects (`lib/projects-*`) live in MongoDB collections `history_entries` and `projects` in the database named by `MONGODB_DB` (default `sunnyview`).
- Owners are identified by an anonymous httpOnly visitor cookie (`HISTORY_COOKIE_NAME`, default `sv_vid`). There are no accounts.
- Projects routes and history routes return HTTP 503 when `MONGODB_URI` is not set.
- The share response is a snapshot (name, site, panel, layout, geometry, estimate, updatedAt) and does not include the owner's visitor ID.
- Browser calls to `/api/*` use `NEXT_PUBLIC_API_ORIGIN` when set (`lib/api.ts`). History calls are always same-origin. Browser-held secrets are attached only when the backend is same-origin (`components/sunnyview/local-keys.ts`).
- When changing any of these routes, verify behavior with the Vitest route tests and note in PR notes which ones need `MONGODB_URI` to exercise end to end.

## Build, Lint, and Test Commands (root)

- Install deps: `npm install` (or `pnpm install`)
- Start dev: `npm run dev`
- Build prod: `npm run build`
- Start prod server: `npm run start`
- Lint all: `npm run lint`
- Type check: `npx tsc --noEmit`
- Run all unit tests: `npm test`
- Test watch mode: `npm run test:watch`
- Coverage: `npm run test:coverage`
- E2E (Playwright, in progress): `npm run test:e2e`
- Diagram PNG export: `npm run diagrams:export` (see `structurizr/README.md`)

### Single-test commands (important)

- Single Vitest file: `npx vitest run lib/roof-plane.test.ts`
- Single test name: `npx vitest run lib/roof-plane.test.ts -t "splits a footprint into two planes and reduces packing count"`
- Quick file lint: `npx eslint components/PanelPacking.ts`

For `services/segmenter/*` changes (Python), use:
- `python -m unittest discover -s services/segmenter/tests`
- `python -m unittest services.segmenter.tests.test_postprocess.TestPostprocess.test_ring_to_mask`

## Code Style Guidelines

### TypeScript and Types

- Keep `strict` TypeScript compatibility.
- Prefer explicit types for exported params/returns.
- Avoid `any`; use `unknown` plus narrowing.
- Prefer `type` aliases for payloads and API outputs.
- Use literal unions for finite states (example: `"landing" | "opening" | "app"`).
- Keep algorithm inputs immutable unless mutation is required.

### Imports and Modules

- Import order:
  1) React/Next
  2) third-party packages
  3) internal modules from `@/`
  4) type-only imports
- Prefer `@/` for cross-folder imports.
- Use relative imports for same-folder modules when clearer.
- Keep client-only and server-only code clearly separated.

### Formatting and File Hygiene

- Follow the style already used in the file you edit.
- Keep quote style and semicolon style consistent per file.
- Do not reformat unrelated lines.
- Keep functions/helpers focused and readable.
- Prefer clear names over abbreviations.

### Naming Conventions

- React components: PascalCase (`SunnyviewExperience`).
- Hooks: `useXxx` (`useIsMobile`, `useProjectSync`).
- Functions/variables: camelCase.
- Constants: UPPER_SNAKE_CASE.
- Types/interfaces: PascalCase (`EstimateOut`, `PackPanelsParams`).
- Zod schema names: `<Feature>Schema`.

### React and Next.js

- Add `"use client"` when using hooks, refs, event handlers, or browser APIs.
- Keep secrets/API keys in server code only.
- For routes using Node APIs (for example `Buffer`), keep `runtime = "nodejs"`.
- Keep heavy geometry/math logic in `lib/` or pure helper modules.

### API Validation, Errors, and Resilience

- Validate public route input with Zod.
- Use `safeParse`; return `400` with `issues` for invalid input.
- Wrap external calls in `try/catch` with user-safe fallback responses.
- Throw `Error` objects (not strings).
- Use `AbortController` timeouts for upstream calls.
- Rate limiting: every route calls `takeRateLimitToken` from `lib/rate-limit.ts`, either directly (`requestClientKey` + `takeRateLimitToken`) or through `rateLimitResponse` in `lib/projects-http.ts` (projects and share routes).
  - Client key order (`requestClientKey`): `x-vercel-forwarded-for`, then `x-real-ip`, then the LAST `x-forwarded-for` entry, then `"unknown"`.
  - The limiter is in-memory per instance (state on `globalThis`, capped at 4000 buckets). On multi-instance or serverless deployments, limits are best-effort.
- Preserve bounded in-memory cache patterns (`globalThis` maps).
- Keep logs concise; never log secrets/tokens.
- Keep deterministic behavior for panel packing and geometry calculations.

## Environment Variables

Document any new variable in `.env.local.example` and related docs. The full list with comments lives in `.env.local.example`.

Live features (server side):
- `PVWATTS_API_KEY`: NREL PVWatts for `/api/estimate`. Missing key means fallback estimates.
- `GEMINI_API_KEY`: `/api/panel-recommend` and `/api/gemini-validate`. Clients may send `x-gemini-api-key`.
- `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`: `/api/tts` and `/api/elevenlabs-validate`. Clients may send `x-elevenlabs-api-key`.
- `MONGODB_URI`, `MONGODB_DB`: History, Projects and Share (`MONGODB_DB` defaults to `sunnyview`).

Optional:
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`: Redis cache for estimates (both required).
- `SEGMENT_SERVICE_URL`: Python segmenter base URL. Outside production, the route probes `127.0.0.1:8000` and `localhost:8000`.
- `SEGMENT_IMAGE_FETCH_ALLOWLIST`: comma-separated hostnames `/api/segment` may fetch images from. Private hosts are always blocked.
- `SEGMENT_SHARED_SECRET`: sent as `x-segment-secret` to the Python segmenter when set (server-only).
- `APP_ORIGIN`: public app origin used to resolve same-origin `imageUrl` paths in `/api/segment` (default `https://$VERCEL_URL`, else `http://127.0.0.1:$PORT`). The request Host is never trusted.
- `TRUSTED_PROXY_HEADER`: header holding the client IP for rate limiting (`x-vercel-forwarded-for` default on Vercel; otherwise unset means one shared bucket).
- `TTS_DAILY_BUDGET` (default 500), `GEMINI_DAILY_BUDGET` (default 1000): global daily request budgets when the server env key is used (`lib/spend-budget.ts`).
- `ELEVENLABS_MODEL_ID`: pinned TTS model (default `eleven_multilingual_v2`); clients cannot override it.
- `CO2_KG_PER_KWH`: CO2 factor override (clamped to 0.05 to 2).
- `HISTORY_RETENTION_MAX` (default 100, hard cap 300), `HISTORY_COOKIE_NAME` (default `sv_vid`), `HISTORY_COOKIE_MAX_AGE_DAYS` (default 365).
- `PROJECTS_TTL_DAYS` (default 90, TTL index on `updatedAt`), `PROJECTS_MAX_PER_VISITOR` (default 50, oldest deleted beyond the cap).
- `NEXT_PUBLIC_API_ORIGIN`: optional override for the backend origin the browser calls.
- `NEXT_PUBLIC_CESIUM_ION_TOKEN`: Cesium ion token for the globe.
- `NEXT_PUBLIC_MAPBOX_TOKEN`: fallback provider for `/api/static-map`, tried after ArcGIS.

Local tooling only (not read by the app): `CHROME_BIN`, `DIAGRAM_WIDTH`, `DIAGRAM_HEIGHT`, `DIAGRAM_DPR` (used by `structurizr/export-diagrams.mjs`).

Python segmenter variables (`SAM_CHECKPOINT`, `SAM_MODEL_TYPE`, `ROOFSEG_*`) are read by `services/segmenter/` and documented in `services/segmenter/README.md`.

## PR and Change Discipline

- Keep diffs minimal and task-focused.
- Avoid broad refactors unless requested.
- Do not modify unrelated files for formatting only.
- In PR notes include: what changed, why, and exact verification commands.
- If work depends on a key or service (MongoDB, PVWatts, Gemini, ElevenLabs, the Python segmenter), say so in PR notes and how to exercise it without that key.
