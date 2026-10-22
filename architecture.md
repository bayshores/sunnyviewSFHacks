# sunnyview: architecture.md

Last updated: 2026-10-20

## Implementation status disclaimer

- This is the original hackathon architecture plan (February 2026). It is kept as a historical design reference. For the current routes, env vars and setup, see `README.md` and `AGENTS.md`.
- Implemented in this repository now:
  - Frontend experience, with the main flow split across `components/sunnyview/`, `components/roof-editor/` and `components/globe/`.
  - `GET /api/geocode`, `GET /api/reverse-geocode`, `GET /api/static-map`, `GET /api/forecast`.
  - `POST /api/estimate` (PVWatts with a built-in fallback, optional Redis cache).
  - `POST /api/segment` (Python segmenter when configured, otherwise an in-app fallback).
  - `POST /api/explain`, which is template-based and does not call Gemini yet (section 7.2 is still the plan).
  - `POST /api/tts` (ElevenLabs), `POST /api/panel-recommend` (Gemini), and the key-check routes.
  - History (`/api/history`, `/api/history/[id]`), Projects (`/api/projects`, `/api/projects/[id]`), and public share (`/api/share/[slug]` and the `/s/[shareSlug]` page).
- MongoDB stores history and projects in this repo. The collection schemas in section 9 are the plan. The implemented fields are in `lib/history-types.ts` and `lib/projects-types.ts`. There is no separate `events` collection.
- Never shipped (treat these as dropped ideas, not pending work): Solana badge, Snowflake/Cortex insights, PDF export, QR code for share links, classroom mode, and obstacle brushing.
- Where the plan says "external backend" (sections 6.2 and 9), read it as this repo's own API routes and MongoDB. `NEXT_PUBLIC_API_ORIGIN` is only an optional override that points the browser at another backend.

## 0. What we are building

sunnyview is a 30-second solar feasibility demo:

1) Paste a Google Maps link (preferred)  
2) Trace the usable roof with your mouse (or click “Auto-outline”)  
3) The roof instantly fills with a panel layout while numbers update live:
   - # panels
   - system size (kW DC)
   - annual energy (kWh/year)
   - annual CO₂ avoided (kg/year)
4) Generate a shareable “Solar Snapshot” link (QR code) plus optional voice narration

The product goal is not “perfect solar engineering”. It is “fast, believable, and interactive enough to turn curiosity into action”.

---

## 1. Hackathon fit (SFHacks 2026)

Theme alignment: climate action / greener tomorrow.

Judging alignment:
- Idea: clear climate impact and education value
- Implementation: real-time geometry + validated solar model + AI assist
- Design: immediate visual payoff, crisp interactions, shareable output
- Presentation: the demo is the pitch

Track alignment map (planned):
- Best Hack for Climate Action: core kWh + CO₂ avoided estimate and “what this means” output
- Best Design Hack: the “trace -> instant layout” interaction + animated metrics + report UX
- Best Hack for Sustainability in Education: Classroom mode with equivalencies and comparison
- MLH Best Use of Gemini API: plain-English summary and Q&A from computed results
- MLH Best Use of ElevenLabs: voice narration of the results (mic-drop moment)
- MLH Best Use of Vultr: GPU inference for auto-outline and obstacle detection
- MLH Best Use of MongoDB Atlas: persist projects, share links, caching, session analytics
- MLH Best Use of Snowflake AI: optional “batch mode” analytics + Cortex-generated insights
- MLH Best Use of Solana: optional “Impact Badge” minted as a compressed NFT
- MLH Best Use of .TECH Domain Name: host public demo + share links

---

## 2. Product experience (user journeys)

### 2.1 Homeowner (single roof, 30 seconds)
1) Paste Google Maps link  
2) “Auto-outline” OR manual trace  
3) Optionally brush out obstacles (skylights, HVAC) or accept AI suggestions  
4) See live: panels, kW, kWh/year, CO₂/year  
5) Tap “Explain it” (3 bullets) then “Talk it” (voice narration)  
6) “Share” -> QR code -> judges scan

### 2.2 Installer / auditor (quick pre-qual)
- Save multiple roofs
- Export a PDF snapshot
- Adjust assumptions quickly: module wattage, setbacks, tilt, losses

### 2.3 Classroom mode (education track)
- Teacher loads a campus preset (preloaded roofs)
- Students compare buildings: “Which roof saves the most CO₂?”
- App shows equivalencies (car miles avoided, homes powered) and share links

---

## 3. High-level system diagram

```
+---------------------------+         +-----------------------------+
|        Web Client         |         |     External Data/APIs      |
|  Next.js UI + Canvas      |         |  - PVWatts (solar yield)    |
|  - Trace polygon          | <-----> |  - (Optional) grid CO2 data |
|  - Live panel packing     |         +-----------------------------+
|  - Optional WebGPU ML     |
+-------------+-------------+
              |
              | HTTPS (JSON, signed URLs)
              v
+---------------------------+         +-----------------------------+
|     API Gateway / BFF     |         |     AI Inference Service    |
|  Next.js Route Handlers   | <-----> |  FastAPI + GPU model        |
|  - Hide API keys          |         |  - roof/obstacle masks      |
|  - Project CRUD           |         |  - polygon extraction       |
|  - PVWatts proxy + cache  |         +-----------------------------+
|  - Report + PDF           |
|  - TTS + LLM orchestration|
+-------------+-------------+
              |
              v
+---------------------------+         +-----------------------------+
|   Data + Storage Layer    |         |  Optional Analytics Layer   |
|  - MongoDB Atlas (CRUD)   | <-----> |  - Snowflake (batch mode)   |
|  - Object storage (imgs)  |         |  - Cortex text insights     |
|  - Redis cache            |         +-----------------------------+
+---------------------------+
```

---

## 4. Frontend (Next.js)

### 4.1 Key UI primitives
- Canvas overlay for drawing:
  - polygon tool (click-to-place vertices, drag to edit)
  - brush tool (mark “no-go” zones)
  - rotate tool (panel orientation slider)
  - snap + simplify (auto-clean jittery lines)
- Instant feedback:
  - animated panel fill
  - count-up numbers (kWh, CO₂) as layout stabilizes
  - confidence badge that improves as inputs are provided

### 4.2 Coordinate systems (important)
We track geometry in two coordinate spaces:

1) Image coordinates (pixels)
- what the user draws
- used for quick interaction and rendering

2) World coordinates (meters, local planar)
- used for area and energy estimation
- based on Web Mercator scale at the selected latitude

We keep transforms:
- `px -> worldMeters`: scale + rotation + origin offset
- `worldMeters -> lat/lng`: only needed for debugging and map overlays (optional)

### 4.3 Getting scale (meters per pixel)

Best path (wow + accuracy):
- User pastes a Google Maps link.
- We extract:
  - center latitude/longitude
  - zoom level (or infer from URL params)
- We fetch a satellite tile (any provider we are allowed to use).
- Compute meters per pixel at the latitude:
  - `mPerPx = cos(latRad) * 2πR / (256 * 2^zoom)`
  - where `R = 6378137` meters

Current repository flow:
- Screenshot upload has been removed from the UI.
- Scale is derived from map latitude + zoom in the address/map-link flow.

### 4.4 Live compute in the browser
To keep the demo snappy, these run locally:
1) Polygon cleanup (simplify, snap, self-intersection fix)
2) Panel packing (debounced at 50-100ms)
3) Derived numbers:
   - # panels
   - kW DC
   - quick kWh/year fallback (so numbers always move)

PVWatts calls are server-mediated and happen:
- after polygon is stable for ~300ms
- after the user changes tilt/losses and clicks Recalculate (or debounce)

### 4.5 Optional: on-device ML for offline wow factor
If time permits:
- run a small segmentation model in-browser using WebGPU
- allow “click roof -> mask” without a server

This is optional because model size and performance vary by laptop.

---

## 5. Panel layout engine

### 5.1 Inputs
- `usablePolygon` (roof minus no-go minus setbacks)
- `panelRect` (width, height)
- `gap` (panel-to-panel)
- `orientationDeg` (panel rotation)
- `rowSpacing` (optional, for tilt spacing)
- `maxPanels` (safety cap to prevent infinite loops)

### 5.2 Layout approach (fast, robust, demo-friendly)
We use a deterministic grid-scan algorithm:

1) Rotate `usablePolygon` by `-orientationDeg`
2) Compute its bounding box
3) Create a grid of candidate panel rectangles spaced by `(panelW + gap, panelH + gap)`
4) Keep candidate rectangles whose corners are inside polygon AND do not intersect no-go
5) Rotate placed rectangles back by `orientationDeg`

Why this wins for demo:
- predictable
- easy to animate row-by-row fill
- fast enough in JS for live updates

### 5.3 Complexity and performance
- A typical roof region yields 200-2000 candidates
- Use debouncing + worker thread (optional) for smooth UI

---

## 6. Backend (API gateway / BFF)

### 6.1 Why a BFF
- Hide API keys (PVWatts key, Gemini key, ElevenLabs key)
- Cache expensive calls (PVWatts, segmentation results)
- Produce share links and PDF snapshots
- Centralize rate limiting

### 6.2 Endpoints (proposed external dependencies)

make sure you read this section as planned backend API contracts, not routes implemented in this repo today.

#### Projects
- `POST /api/projects`
  - body: { name, baseImageRef, siteSpec, panelSpec }
  - returns: { projectId, shareSlug }

- `GET /api/projects/:id`
- `PATCH /api/projects/:id`
  - update polygons, specs, etc

- `GET /s/:shareSlug`
  - public read-only view

#### Estimation
- `POST /api/estimate`
  - body:
    - `roofPolygonWorld`
    - `noGoWorld`
    - `siteSpec`
    - `panelSpec`
    - `layoutSummary` (count, dcKw, orientation)
  - returns:
    - `annualKwh`
    - `monthlyKwh[12]`
    - `annualCo2Kg`
    - `assumptions`

#### AI Assist
- `POST /api/segment`
  - body: { imageRef, clicks[], mode }
  - returns:
    - `roofMaskRLE`
    - `obstaclesMaskRLE`
    - `roofPolygon`
    - `obstaclePolygons`
    - `confidence`

#### Narration / Explanation
- `POST /api/explain`
  - body: { estimate, assumptions, userGoal }
  - returns: { bullets[], shortParagraph, caveats[] }

- `POST /api/tts`
  - body: { text, voiceId }
  - returns: { audioUrl }

#### Optional Solana badge
- `POST /api/badge`
  - body: { shareSlug, estimate }
  - returns: { txSignature, badgeUrl }

### 6.3 Caching strategy
PVWatts cache key:
`(lat,lng, tilt, azimuth, dcKw, losses, moduleType, arrayType)`

- PVWatts responses cached for 24h
- Segmentation results cached per image hash for 7d (images are immutable)
- Store caches in Redis (or a managed Redis equivalent)

---

## 7. AI services

### 7.1 Auto-outline segmentation service
Goal: from a satellite image, output a usable roof polygon and obstacle masks.

Implementation:
- Python FastAPI service
- GPU inference (Vultr GPU recommended)
- Model: promptable segmentation (SAM-style) plus post-processing

Inputs:
- image (RGB)
- optional user clicks (positive/negative points)

Outputs:
- roof mask
- obstacle masks (skylight/HVAC blobs)
- polygon(s) extracted from masks
- confidence metrics

Mask-to-polygon post-processing:
1) Binary mask cleanup (morphology)
2) Contour extraction
3) Polygon simplification (RDP)
4) Validity checks (self-intersection fix, min area threshold)
5) Optional: split multi-plane roofs into multiple polygons

Fallback:
- If inference fails, user traces manually.

### 7.1.1 Address-to-roof analysis flow (new)
Based on the data (a satellite image of a roof fetched right after the user searches for a house address in the app), sunnyview will:

1) Use a Computer Vision model to detect and draw a roof shape (rectangle or more complex polygon when needed)
2) Use Gemini to recommend the most appropriate solar panel brand/model for that roof type
3) Use layout and energy calculations to estimate how many panels can be placed on that roof

### 7.2 “Explain it” assistant
Purpose: turn numbers into meaning:
- “This layout fits 18 panels (7.2 kW DC) and makes about 10.8 MWh/year…”
- short caveats: “assumes X tilt, Y losses…”

Two interchangeable providers:
- Gemini API (default for MLH track)
- Snowflake Cortex AI functions (optional if we lean into Snowflake track)

Guardrails:
- Only talk about computed numbers and explicit assumptions
- Never claim permitting, structural safety, or guaranteed savings
- Always include a 1-line “engineering caveat” in the output

### 7.3 Voice narration
- ElevenLabs TTS generates a 7-10 second audio clip
- Use it as the “mic drop” at the end of the demo

---

## 8. Solar and CO₂ estimation pipeline

### 8.1 Inputs needed
Minimum viable:
- roof polygon area (m²)
- panel spec (size and wattage)
- approximate location (lat/lng) OR use a conservative default irradiance

Better:
- exact lat/lng from a pasted link
- tilt estimate (user slider)
- azimuth estimate (auto from polygon orientation, editable)

### 8.2 Core calculations
1) Usable area  
   `usable = roofPolygon - noGoPolygons - setbackInset`

2) Panel packing  
   `count = pack(usable, panelSpec, orientationDeg)`  
   `dcKw = count * panelW / 1000`

3) Annual energy  
   Primary: PVWatts call with `dcKw`, `tilt`, `azimuth`, `losses`, `lat/lng`  
   Fallback: `annualKwh = dcKw * localKwhPerKwYear` (configurable) so the demo never stalls

4) CO₂ avoided  
   `co2Kg = annualKwh * gridCo2KgPerKwh`  
   Default factor:
   - region-based if location known
   - global average if not

### 8.3 Confidence scoring (for honesty + credibility)
We display a 3-tier badge:
- Low: no location + manual trace
- Medium: location known + manual trace
- High: location + AI obstacles + user-confirmed tilt/azimuth

---

## 9. Data model (MongoDB Atlas)

### 9.1 Collections

#### `projects`
- `_id`
- `createdAt`, `updatedAt`
- `title`
- `shareSlug`
- `baseImage`:
  - `kind`: "upload" | "tile"
  - `url` or `objectKey`
  - `sha256`
- `siteSpec`: { lat, lng, tiltDeg, azimuthDeg, lossesPct, utilityRate? }
- `panelSpec`: { lengthM, widthM, wattW, gapM, setbackM }
- `geometry`:
  - `roofPolygon`: GeoJSON Polygon (world coords)
  - `noGoPolygons`: GeoJSON MultiPolygon
  - `layoutPanels`: store lightweight grid params OR full rectangles for replay
- `results`:
  - `annualKwh`, `monthlyKwh`, `annualCo2Kg`
  - `pvwattsInputs`
  - `assumptions`
  - `confidence`

#### `events` (optional, for demo analytics)
- `projectId`
- `type`: "TRACE_START" | "TRACE_DONE" | "AUTO_OUTLINE" | "SHARE" | ...
- `ts`

### 9.2 Privacy defaults
- Uploaded images stored with unguessable URLs and short retention (example: 7 days)
- Share links expose read-only results, not raw uploads unless opted-in

---

## 10. Deployment

### 10.1 Environments
- `dev`: local Next.js + local FastAPI (CPU) + local Mongo
- `demo`: Next.js deployed, FastAPI on GPU, MongoDB Atlas, object storage, Redis cache
- `prod` (post-hack): auth, quotas, privacy controls

### 10.2 Hosting plan (track-friendly)
- Vultr:
  - GPU instance for segmentation service
  - optional object storage
- Web app:
  - deploy Next.js where serverless route handlers or containers are supported
- DNS:
  - .tech domain hosts `sunnyview.tech`

### 10.3 Reliability for live judging
- Seed the app with 2-3 “known good” demo roofs
- Cache PVWatts responses ahead of time
- If internet flakes:
  - switch to fallback annual estimate
  - keep panel layout fully local

---

## 11. Demo script (90 seconds)

1) Open `sunnyview.tech` and paste a Google Maps link (campus building works great)  
2) Click Auto-outline (polygon snaps in)  
3) Drag one vertex (layout and numbers update instantly)  
4) Click Exclude obstacles (AI highlights skylight, user accepts)  
5) Hit Explain it (3 bullets appear)  
6) Hit Talk it (audio plays)  
7) Click Share (QR code pops up, judge scans)

Optional 15-second flex:
- Mint an Impact Badge on Solana devnet and show the transaction result

---

## 12. Build plan (what to finish first)

Hour 0-6:
- UI skeleton, image loading, manual polygon drawing

Hour 6-14:
- polygon cleanup + panel packing + live numbers

Hour 14-20:
- PVWatts integration (via backend) + caching

Hour 20-28:
- share links + QR code + report page + PDF export

Hour 28-36:
- Gemini explain + ElevenLabs narration

Stretch:
- auto-outline segmentation service on Vultr GPU
- batch mode + Snowflake Cortex insights
- Solana badge

---

## 13. Key risks and mitigations

- Map scale accuracy: prefer map link import, offer calibration fallback
- Segmentation too slow: keep manual trace as main path, AI as optional wow button
- API limits: aggressive caching, demo presets, degrade gracefully
- Overpromising: show assumptions and confidence badge prominently
