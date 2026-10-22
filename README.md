# Sunnyview

[![Live Site](https://img.shields.io/badge/Live-sunnyview--sf--hacks.vercel.app-0ea5e9?style=for-the-badge)](https://sunnyview-sf-hacks.vercel.app)
[![Next.js](https://img.shields.io/badge/Next.js-16-black?style=for-the-badge)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-3178C6?style=for-the-badge)](https://www.typescriptlang.org/)

Fast rooftop solar feasibility demo from SF Hacks 2026.

## Live Demo

- Site: https://sunnyview-sf-hacks.vercel.app

## Team

- [Md Safkatul Islam](https://www.linkedin.com/in/md-safkatul-islam/)
- [Sean Esla](https://www.linkedin.com/in/seanesla/)
- [Kai Shimoda](https://www.linkedin.com/in/kai-shimoda/)
- [Aleks Ershov](https://www.linkedin.com/in/aleksershov)

## Architecture Diagrams

General architecture:

![Sunnyview general architecture diagram](structurizr/diagrams/general-architecture.png)

Main feature flow:

![Sunnyview main feature flow diagram](structurizr/diagrams/main-feature.png)

The PNGs were exported before the latest `structurizr/workspace.dsl` update and may not show the current MongoDB scope (history and projects). See [structurizr/README.md](structurizr/README.md).

## What This Repo Contains

- Next.js 16 app (App Router, React 19, TypeScript strict)
- Deterministic panel-packing logic that runs in the browser (`components/PanelPacking.ts`)
- Local API routes (all under `app/api/`, all rate limited):

| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/geocode` | GET | Address search (ArcGIS, then Nominatim) |
| `/api/reverse-geocode` | GET | Coordinates to address label |
| `/api/static-map` | GET | Satellite image (ArcGIS, then Mapbox if configured) |
| `/api/estimate` | POST | Annual energy and CO2 via PVWatts (Redis-cached when configured; built-in fallback if PVWatts fails or is unconfigured) |
| `/api/segment` | POST | Auto-outline of roof (Python segmenter, or in-app fallback) |
| `/api/explain` | POST | Template-based explanation text (no LLM) |
| `/api/tts` | POST | ElevenLabs narration (disabled without a key) |
| `/api/forecast` | GET | Open-Meteo forecast and archive data |
| `/api/panel-recommend` | POST | Panel brand recommendation via Gemini |
| `/api/gemini-validate` | POST | Checks a Gemini API key |
| `/api/elevenlabs-validate` | POST | Checks an ElevenLabs API key |
| `/api/history` | GET, POST | Per-visitor Solar Snapshot history (MongoDB) |
| `/api/history/[id]` | GET, PATCH, DELETE | Single history entry (MongoDB) |
| `/api/projects` | POST | Create a project owned by the visitor (MongoDB) |
| `/api/projects/[id]` | GET, PATCH | Read or update a project owned by the visitor (MongoDB) |
| `/api/share/[slug]` | GET | Public, read-only shared project JSON (MongoDB) |
| `/s/[shareSlug]` | page | Public share page; reads `/api/share/[slug]` |

Data notes:

- History and projects are stored in MongoDB collections `history_entries` and `projects` (database from `MONGODB_DB`, default `sunnyview`).
- Owners are identified by an anonymous, httpOnly visitor cookie (`sv_vid` by default). There are no user accounts.
- Share links are public and read-only. The share response includes only the snapshot fields (name, site, panel, layout, geometry, estimate, updatedAt), not the owner's visitor ID.
- The browser calls `/api/*` on the same origin unless `NEXT_PUBLIC_API_ORIGIN` points it at another backend. History calls are always same-origin.

## Quick Start

Requirements: Node.js 20.9+ and npm.

```bash
npm install
cp .env.local.example .env.local
npm run dev
```

Open `http://localhost:3000`.

Environment notes (all variables are optional for local development; see `.env.local.example` for the full list):

- Without `PVWATTS_API_KEY`, estimates use built-in defaults instead of live PVWatts data.
- Without `MONGODB_URI`, History, Projects and Share routes respond with HTTP 503.
- Without `GEMINI_API_KEY` or `ELEVENLABS_API_KEY`, the matching AI features are disabled or fall back. Clients can also send their own keys in request headers.
- The Python segmenter is optional. See [services/segmenter/README.md](services/segmenter/README.md).

## Scripts

| Command | What it does |
|---------|--------------|
| `npm run dev` | Start the dev server (webpack) |
| `npm run build` | Production build (webpack) |
| `npm run start` | Serve the production build |
| `npm run lint` | ESLint over the repo |
| `npm test` | Vitest unit and route tests, one run |
| `npm run test:watch` | Vitest in watch mode |
| `npm run test:coverage` | Vitest with v8 coverage summary |
| `npm run test:e2e` | Playwright (`playwright test`). The Playwright config and `e2e/` suite are in progress and not yet in the repo. |
| `npm run diagrams:export` | Render Structurizr PNGs (needs a static export and Chrome; see `structurizr/README.md`) |

Python segmenter tests:

```bash
python -m unittest discover -s services/segmenter/tests
```

Single-test examples are in [AGENTS.md](AGENTS.md).

## Project Layout

```
app/                  Next.js App Router pages and route handlers (app/api/*)
  s/[shareSlug]/      Public share page
components/
  sunnyview/          Main app flow: hooks, panels, history and share UI
  roof-editor/        Roof outline canvas editor
  globe/              Cesium 3D globe
  ui/                 Shared UI primitives
lib/                  Shared logic: rate limiting, MongoDB stores, PVWatts, geocoding,
                      segmentation helpers (lib/segment), geo math (lib/geo), solar defaults
services/segmenter/   Optional Python CV roof segmenter (FastAPI)
structurizr/          Architecture workspace (C4 DSL) and diagram export
```

## Notes

- Estimates are directional, not permit-ready engineering output.
