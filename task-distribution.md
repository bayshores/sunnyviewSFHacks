## Team Task Distribution (Backend only)

> Disclaimer (implementation status, updated 2026-10-20)
> - This is the original hackathon backend task split. It is kept as a historical plan, not a current checklist.
> - The "Backend 1/2/3" ownership sections and code snippets below are the plan as written. For current routes and setup, see `README.md`, `AGENTS.md` and `.env.local.example`.

### Current backend status in this repo

- Implemented here: `/api/geocode`, `/api/reverse-geocode`, `/api/static-map`, `/api/forecast`, `/api/estimate`, `/api/segment`, `/api/explain` (template-based, not Gemini yet), `/api/tts`, `/api/panel-recommend` (Gemini), history routes, projects routes (`/api/projects`, `/api/projects/[id]`), and the public share route (`/api/share/[slug]`, with the `/s/[shareSlug]` page).
- Projects and history are stored in MongoDB (`MONGODB_URI`, `MONGODB_DB`) inside this repo. There is no separate backend service.
- Never shipped: Solana badge, Snowflake, PDF export, QR code, classroom mode, obstacle brushing.
- The "One-Time Shared Setup" env block below is historical. Use `.env.local.example` for the current variable list.

### Backend 1
**Owns:** Projects + DB + share links + glue
- Create Mongo connection + project schema helpers
- Implement project CRUD endpoints
- Implement public share endpoint
- Basic validation + logs

### Backend 2
**Owns:** Solar estimation endpoint
- Implement `/api/estimate`
- PVWatts proxy + caching
- CO₂ calculation + fallback estimate

### Backend 3
**Owns:** AI assist + explain + voice endpoints
- Implement `/api/segment` (stub first, forward to FastAPI if available)
- Implement `/api/explain` (stub first, Gemini later)
- Implement `/api/tts` (stub first, ElevenLabs later)

---

## One-Time Shared Setup (do once)

### 1) Install dependencies
```bash
npm i zod mongodb nanoid
# optional caching
npm i @upstash/redis
```

### 2) Add `.env.local`

```bash
MONGODB_URI="mongodb+srv://..."
MONGODB_DB="sunnyview"

# PVWatts (NREL)
PVWATTS_API_KEY="YOUR_KEY"

# optional caching (Upstash)
UPSTASH_REDIS_REST_URL=""
UPSTASH_REDIS_REST_TOKEN=""

# Gemini + ElevenLabs (optional)
GEMINI_API_KEY=""
ELEVENLABS_API_KEY=""
ELEVENLABS_VOICE_ID=""

# Optional segmentation service
SEGMENT_SERVICE_URL="http://localhost:8000"
```

### 3) Create this folder structure

```txt
app/
  api/
    projects/
      route.ts
    projects/[id]/
      route.ts
    estimate/
      route.ts
    segment/
      route.ts
    explain/
      route.ts
    tts/
      route.ts
  s/[shareSlug]/
    route.ts

lib/
  db.ts
  redis.ts
  schemas.ts
  pvwatts.ts
  co2.ts
  ids.ts
```

---

# Backend 1 (Lead): Projects + Share + DB Glue

## What you build

You build the backend that lets the app:

* **Create a project** (returns `projectId` + `shareSlug`)
* **Save updates** (roof polygon, panel settings, computed results)
* **Load a project**
* **Open a share link** (read-only public JSON for the FE share page)

---

## Step-by-step actions

1. Create helper files: `lib/db.ts`, `lib/ids.ts`, `lib/schemas.ts`
2. Create routes:

   * `app/api/projects/route.ts` (create)
   * `app/api/projects/[id]/route.ts` (get + patch)
   * `app/s/[shareSlug]/route.ts` (public share)

---

## Code

### `lib/db.ts` — MongoDB connection helper

**Simple explanation:** connects to MongoDB and gives you the database object.

```ts
import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI!;
const dbName = process.env.MONGODB_DB || "sunnyview";

if (!uri) throw new Error("Missing MONGODB_URI");

let client: MongoClient | null = null;

export async function getDb() {
  if (!client) client = new MongoClient(uri);
  // Connect once and reuse the connection
  // (safe for route handlers)
  // @ts-ignore older driver differences
  if (!client.topology?.isConnected?.()) await client.connect();
  return client.db(dbName);
}
```

### `lib/ids.ts` — share slug generator

**Simple explanation:** makes a short random string for share links.

```ts
import { nanoid } from "nanoid";

export function newShareSlug() {
  return nanoid(10);
}
```

### `lib/schemas.ts` — request validation schemas (Zod)

**Simple explanation:** checks incoming JSON so we don’t store broken data.

```ts
import { z } from "zod";

export const SiteSpecSchema = z.object({
  lat: z.number().optional(),
  lng: z.number().optional(),
  tiltDeg: z.number().default(20),
  azimuthDeg: z.number().default(180),
  lossesPct: z.number().default(14),
});

export const PanelSpecSchema = z.object({
  lengthM: z.number().default(1.7),
  widthM: z.number().default(1.1),
  wattW: z.number().default(400),
  gapM: z.number().default(0.02),
  setbackM: z.number().default(0.3),
});

export const ProjectCreateSchema = z.object({
  title: z.string().default("Untitled"),
  baseImage: z.object({
    kind: z.enum(["upload", "tile"]),
    url: z.string().optional(),
    objectKey: z.string().optional(),
    sha256: z.string().optional(),
  }),
  siteSpec: SiteSpecSchema.optional(),
  panelSpec: PanelSpecSchema.optional(),
});

export const ProjectPatchSchema = z.object({
  title: z.string().optional(),
  baseImage: z.any().optional(),
  siteSpec: SiteSpecSchema.partial().optional(),
  panelSpec: PanelSpecSchema.partial().optional(),
  geometry: z.any().optional(), // FE can store GeoJSON-like shapes here
  results: z.any().optional(),  // annualKwh, co2, assumptions, etc.
});
```

### `app/api/projects/route.ts` — create project

**Simple explanation:** creates a DB record and returns IDs needed by the frontend.

```ts
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { newShareSlug } from "@/lib/ids";
import { ProjectCreateSchema } from "@/lib/schemas";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const parsed = ProjectCreateSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const db = await getDb();
  const now = new Date();
  const shareSlug = newShareSlug();

  const doc = {
    createdAt: now,
    updatedAt: now,
    title: parsed.data.title,
    shareSlug,
    baseImage: parsed.data.baseImage,
    siteSpec: parsed.data.siteSpec ?? {},
    panelSpec: parsed.data.panelSpec ?? {},
    geometry: {},
    results: {},
  };

  const res = await db.collection("projects").insertOne(doc);

  return NextResponse.json({
    projectId: res.insertedId.toString(),
    shareSlug,
  });
}
```

### `app/api/projects/[id]/route.ts` — get + patch project

**Simple explanation:** loads a project or updates it (save button / autosave).

```ts
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/db";
import { ProjectPatchSchema } from "@/lib/schemas";

function toObjectId(id: string) {
  try { return new ObjectId(id); } catch { return null; }
}

export async function GET(_: Request, { params }: { params: { id: string } }) {
  const _id = toObjectId(params.id);
  if (!_id) return NextResponse.json({ error: "Bad id" }, { status: 400 });

  const db = await getDb();
  const doc = await db.collection("projects").findOne({ _id });

  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ ...doc, _id: doc._id.toString() });
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const _id = toObjectId(params.id);
  if (!_id) return NextResponse.json({ error: "Bad id" }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const parsed = ProjectPatchSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const db = await getDb();
  const patch = parsed.data;

  const update: any = { updatedAt: new Date() };
  if (patch.title !== undefined) update.title = patch.title;
  if (patch.baseImage !== undefined) update.baseImage = patch.baseImage;
  if (patch.siteSpec !== undefined) update.siteSpec = patch.siteSpec;
  if (patch.panelSpec !== undefined) update.panelSpec = patch.panelSpec;
  if (patch.geometry !== undefined) update.geometry = patch.geometry;
  if (patch.results !== undefined) update.results = patch.results;

  const res = await db.collection("projects").updateOne({ _id }, { $set: update });

  if (!res.matchedCount) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ ok: true });
}
```

### `app/s/[shareSlug]/route.ts` — public share JSON

**Simple explanation:** lets anyone open a share link and read results.

```ts
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function GET(_: Request, { params }: { params: { shareSlug: string } }) {
  const db = await getDb();

  const doc = await db.collection("projects").findOne(
    { shareSlug: params.shareSlug },
    { projection: { baseImage: 1, title: 1, siteSpec: 1, panelSpec: 1, geometry: 1, results: 1, updatedAt: 1 } }
  );

  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ ...doc, _id: doc._id.toString() });
}
```

---

# Backend 2 (lighter): Estimate + PVWatts + CO₂ + Cache

## What you build

You build the endpoint the frontend calls after panel layout:

* Input: location + dcKw + tilt/azimuth/losses
* Output: `annualKwh`, `monthlyKwh[12]`, `annualCo2Kg`, `assumptions`
* If PVWatts is unavailable, you return a fallback estimate.

---

## Step-by-step actions

1. Create optional cache helper `lib/redis.ts`
2. Create PVWatts helper `lib/pvwatts.ts`
3. Create CO₂ helper `lib/co2.ts`
4. Create estimate endpoint `app/api/estimate/route.ts`

---

## Code

### `lib/redis.ts` — optional Upstash Redis client

**Simple explanation:** if Redis is configured, we can store PVWatts results so calls are instant.

```ts
import { Redis } from "@upstash/redis";

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;

export const redis = url && token ? new Redis({ url, token }) : null;
```

### `lib/co2.ts` — CO₂ factor helper

**Simple explanation:** converts kWh into CO₂ avoided using a simple factor.

```ts
export function co2KgPerKwh(_lat?: number, _lng?: number) {
  return 0.4; // demo default
}
```

### `lib/pvwatts.ts` — PVWatts proxy call

**Simple explanation:** calls PVWatts and returns annual + monthly energy numbers.

```ts
export type PVWattsResult = {
  annualKwh: number;
  monthlyKwh: number[];
  inputs: Record<string, any>;
};

export async function callPVWatts(params: {
  lat: number;
  lon: number;
  dcKw: number;
  tilt: number;
  azimuth: number;
  losses: number;
  moduleType?: number;
  arrayType?: number;
}): Promise<PVWattsResult> {
  const key = process.env.PVWATTS_API_KEY!;
  if (!key) throw new Error("Missing PVWATTS_API_KEY");

  const url = new URL("https://developer.nrel.gov/api/pvwatts/v6.json");
  url.searchParams.set("api_key", key);
  url.searchParams.set("lat", String(params.lat));
  url.searchParams.set("lon", String(params.lon));
  url.searchParams.set("system_capacity", String(params.dcKw));
  url.searchParams.set("tilt", String(params.tilt));
  url.searchParams.set("azimuth", String(params.azimuth));
  url.searchParams.set("losses", String(params.losses));
  url.searchParams.set("module_type", String(params.moduleType ?? 1));
  url.searchParams.set("array_type", String(params.arrayType ?? 1));

  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) throw new Error(`PVWatts error ${res.status}`);

  const json = await res.json();

  const acMonthly: number[] = json?.outputs?.ac_monthly ?? [];
  const annualAc: number = json?.outputs?.ac_annual ?? acMonthly.reduce((a, b) => a + b, 0);

  return {
    annualKwh: annualAc,
    monthlyKwh: acMonthly,
    inputs: json?.inputs ?? {},
  };
}
```

### `app/api/estimate/route.ts` — estimate endpoint

**Simple explanation:** tries PVWatts; if it fails (or no location), returns a fast fallback.

```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { redis } from "@/lib/redis";
import { callPVWatts } from "@/lib/pvwatts";
import { co2KgPerKwh } from "@/lib/co2";

const EstimateSchema = z.object({
  siteSpec: z.object({
    lat: z.number().optional(),
    lng: z.number().optional(),
    tiltDeg: z.number().default(20),
    azimuthDeg: z.number().default(180),
    lossesPct: z.number().default(14),
  }),
  layoutSummary: z.object({
    dcKw: z.number(),
  }),
});

function cacheKey(p: { lat: number; lng: number; tilt: number; az: number; dcKw: number; losses: number }) {
  return `pvwatts:${p.lat.toFixed(5)}:${p.lng.toFixed(5)}:${p.tilt}:${p.az}:${p.dcKw.toFixed(3)}:${p.losses}`;
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const parsed = EstimateSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", issues: parsed.error.issues }, { status: 400 });
  }

  const { siteSpec, layoutSummary } = parsed.data;
  const lat = siteSpec.lat;
  const lng = siteSpec.lng;

  // No location => fallback estimate
  if (lat === undefined || lng === undefined) {
    const localKwhPerKwYear = 1400; // demo fallback
    const annualKwh = layoutSummary.dcKw * localKwhPerKwYear;
    const annualCo2Kg = annualKwh * co2KgPerKwh();
    return NextResponse.json({
      annualKwh,
      monthlyKwh: Array(12).fill(annualKwh / 12),
      annualCo2Kg,
      assumptions: { source: "fallback", localKwhPerKwYear },
    });
  }

  const tilt = siteSpec.tiltDeg;
  const az = siteSpec.azimuthDeg;
  const losses = siteSpec.lossesPct;
  const dcKw = layoutSummary.dcKw;

  const key = cacheKey({ lat, lng, tilt, az, dcKw, losses });

  // Cache hit
  if (redis) {
    const cached = await redis.get<any>(key);
    if (cached) return NextResponse.json({ ...cached, assumptions: { ...(cached.assumptions ?? {}), source: "cache" } });
  }

  // PVWatts call
  try {
    const pv = await callPVWatts({
      lat,
      lon: lng,
      dcKw,
      tilt,
      azimuth: az,
      losses,
    });

    const annualCo2Kg = pv.annualKwh * co2KgPerKwh(lat, lng);

    const out = {
      annualKwh: pv.annualKwh,
      monthlyKwh: pv.monthlyKwh,
      annualCo2Kg,
      assumptions: { source: "pvwatts", pvwattsInputs: pv.inputs },
    };

    if (redis) await redis.set(key, out, { ex: 60 * 60 * 24 }); // 24h
    return NextResponse.json(out);
  } catch {
    // PVWatts failed => fallback
    const localKwhPerKwYear = 1400;
    const annualKwh = dcKw * localKwhPerKwYear;
    const annualCo2Kg = annualKwh * co2KgPerKwh(lat, lng);
    return NextResponse.json({
      annualKwh,
      monthlyKwh: Array(12).fill(annualKwh / 12),
      annualCo2Kg,
      assumptions: { source: "fallback_after_error", localKwhPerKwYear },
    });
  }
}
```

---

# Backend 3 (lighter): Segment + Explain + TTS

## What you build

These endpoints make the demo “wow” features:

* `/api/segment`: auto-outline roof (stub first)
* `/api/explain`: 3 bullets + caveat from results (stub first)
* `/api/tts`: voice narration (stub first)

You can ship stubs quickly, then upgrade to real services if time permits.

---

## Step-by-step actions

1. Create `app/api/segment/route.ts` (stub + optional forward)
2. Create `app/api/explain/route.ts` (stub + optional Gemini)
3. Create `app/api/tts/route.ts` (stub + optional ElevenLabs)

---

## Code

### `app/api/segment/route.ts`

**Simple explanation:** returns a polygon for the roof. If FastAPI is running, it forwards the request.

```ts
import { NextResponse } from "next/server";
import { z } from "zod";

const SegmentSchema = z.object({
  imageRef: z.string(),
  clicks: z.array(z.object({ x: z.number(), y: z.number(), type: z.enum(["pos", "neg"]) })).optional(),
  mode: z.string().optional(),
});

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const parsed = SegmentSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", issues: parsed.error.issues }, { status: 400 });
  }

  const svc = process.env.SEGMENT_SERVICE_URL;

  // Forward to FastAPI service if available
  if (svc) {
    try {
      const res = await fetch(`${svc}/segment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      if (res.ok) return NextResponse.json(await res.json());
    } catch {
      // fall back to stub
    }
  }

  // Stub response
  return NextResponse.json({
    roofMaskRLE: null,
    obstaclesMaskRLE: null,
    roofPolygon: {
      type: "Polygon",
      coordinates: [[[0,0],[10,0],[10,6],[0,6],[0,0]]],
    },
    obstaclePolygons: [],
    confidence: 0.3,
    note: "stub",
  });
}
```

### `app/api/explain/route.ts`

**Simple explanation:** turns numbers into a friendly 3-bullet explanation. Uses Gemini if configured.

```ts
import { NextResponse } from "next/server";
import { z } from "zod";

const ExplainSchema = z.object({
  estimate: z.any(),
  assumptions: z.any().optional(),
  userGoal: z.string().optional(),
});

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const parsed = ExplainSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", issues: parsed.error.issues }, { status: 400 });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  // No Gemini => stub
  if (!apiKey) {
    const annualKwh = parsed.data?.estimate?.annualKwh ?? 0;
    const co2 = parsed.data?.estimate?.annualCo2Kg ?? 0;
    return NextResponse.json({
      bullets: [
        `Estimated production: ~${Math.round(annualKwh).toLocaleString()} kWh/year.`,
        `Estimated CO₂ avoided: ~${Math.round(co2).toLocaleString()} kg/year.`,
        `Fast feasibility estimate based on your roof outline.`,
      ],
      shortParagraph: "Quick solar snapshot generated from panel layout + PVWatts/fallback model.",
      caveats: ["Not an engineering-grade design. Shading/roof conditions can change results."],
      note: "stub",
    });
  }

  // Gemini (HTTP) — request JSON output
  const prompt = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text:
`Return valid JSON with keys: bullets (3 strings), shortParagraph (1), caveats (1-2).
Use ONLY these numbers/assumptions.
Estimate: ${JSON.stringify(parsed.data.estimate)}
Assumptions: ${JSON.stringify(parsed.data.assumptions ?? {})}`,
          },
        ],
      },
    ],
    generationConfig: { temperature: 0.4 },
  };

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(prompt) }
    );

    const json = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    try {
      return NextResponse.json(JSON.parse(text));
    } catch {
      return NextResponse.json({
        bullets: ["Solar snapshot ready.", "Based on your outline + assumptions.", "Use as a quick pre-check."],
        shortParagraph: text.slice(0, 400),
        caveats: ["Not an engineering guarantee."],
      });
    }
  } catch {
    return NextResponse.json({ error: "Gemini failed" }, { status: 502 });
  }
}
```

### `app/api/tts/route.ts`

**Simple explanation:** turns explanation text into audio. If ElevenLabs isn’t set, returns null.

```ts
import { NextResponse } from "next/server";
import { z } from "zod";

const TTSSchema = z.object({
  text: z.string().min(1),
  voiceId: z.string().optional(),
});

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const parsed = TTSSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", issues: parsed.error.issues }, { status: 400 });
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = parsed.data.voiceId || process.env.ELEVENLABS_VOICE_ID;

  // No ElevenLabs => stub
  if (!apiKey || !voiceId) {
    return NextResponse.json({ audioUrl: null, note: "stub_no_key" });
  }

  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": apiKey,
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: parsed.data.text,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.4, similarity_boost: 0.8 },
      }),
    });

    if (!res.ok) return NextResponse.json({ error: "ElevenLabs failed" }, { status: 502 });

    // Simple hackathon approach: return a data URL (no storage needed)
    const arrayBuffer = await res.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");
    const audioUrl = `data:audio/mpeg;base64,${base64}`;

    return NextResponse.json({ audioUrl });
  } catch {
    return NextResponse.json({ error: "TTS exception" }, { status: 502 });
  }
}
```

---

## Quick Local Testing (optional)

### Create a project

```bash
curl -X POST http://localhost:3000/api/projects \
  -H "Content-Type: application/json" \
  -d '{"title":"Demo","baseImage":{"kind":"upload","url":"https://example.com/img.png"}}'
```

### Save geometry/results

```bash
curl -X PATCH http://localhost:3000/api/projects/PROJECT_ID \
  -H "Content-Type: application/json" \
  -d '{"geometry":{"roofPolygon":{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,1],[0,0]]]}}, "results":{"annualKwh":1234}}'
```

### Run estimate

```bash
curl -X POST http://localhost:3000/api/estimate \
  -H "Content-Type: application/json" \
  -d '{"siteSpec":{"lat":37.7749,"lng":-122.4194,"tiltDeg":20,"azimuthDeg":180,"lossesPct":14},"layoutSummary":{"dcKw":7.2}}'
```

---

## Done Definition (Backend)

Backend is “done” when:

* FE can create/save/load projects
* Share slug returns read-only project JSON
* Estimate endpoint returns kWh + CO₂ quickly (PVWatts or fallback)
* Explain + TTS return something (stubs OK; real integrations are bonus)
* Segment returns stub polygon (real FastAPI optional)

---
