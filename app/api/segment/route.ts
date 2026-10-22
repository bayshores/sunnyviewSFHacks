import { NextResponse } from "next/server"
import { z } from "zod"

import { readCappedJson } from "@/lib/request-guards"
import { requestClientKey, takeRateLimitToken } from "@/lib/rate-limit"
import {
  extractGeojsonRingNorm,
  fallbackRectRoofPolygon,
  TINY_FALLBACK_POLYGON,
} from "@/lib/segment/geometry"
import {
  buildSegmentGuidance,
  hasMapMeta,
  locateBuildings,
  mergeOsmCandidates,
  OSM_MULTIPLE_NOTE,
  osmCandidateExtras,
  readMetaValues,
  serializeOsmCandidate,
  type MetaValues,
  type OsmCandidateJson,
  type SegmentClick,
} from "@/lib/segment/guidance"
import { SafeImageError } from "@/lib/segment/errors"
import { estimateDataUrlBytes, fetchWithTimeout, fetchWithValidatedRedirects, readBufferWithLimit } from "@/lib/segment/image"
import { normalizeCandidatePolygon } from "@/lib/segment/osm-buildings"
import { resolveAllowedImageUrl } from "@/lib/segment/ssrf"

export const runtime = "nodejs"

const SegmentSchema = z.object({
  imageDataUrl: z.string().optional(),
  imageUrl: z.string().optional(),
  mode: z.string().optional(),
  clicks: z
    .array(z.object({ x: z.number(), y: z.number(), type: z.enum(["pos", "neg"]) }))
    .optional(),
  roi: z
    .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
    .optional(),
  meta: z.record(z.unknown()).optional(),
})

const MAX_IMAGE_BYTES = 8 * 1024 * 1024
// 8MB image as base64 (~4/3) plus headroom for meta/clicks.
const MAX_BODY_BYTES = 17_000_000
const IMAGE_FETCH_TIMEOUT_MS = 12_000
const SEGMENT_SERVICE_TIMEOUT_MS = 25_000
const SEGMENT_UPSTREAM_TIMEOUT_MS = 20_000
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 18

const RUN_SEGMENTER_HINT = "For reliable auto-outline, run the Python segmenter and set SEGMENT_SERVICE_URL."

/**
 * The segmenter's `debug` block can carry model paths and exception text.
 * Keep only numeric/boolean fields; drop everything else before forwarding.
 */
function sanitizeServiceJson(json: unknown): unknown {
  if (!json || typeof json !== "object" || Array.isArray(json)) return json
  const { debug, ...rest } = json as Record<string, unknown>
  if (!debug || typeof debug !== "object" || Array.isArray(debug)) return rest
  const safe = Object.fromEntries(
    Object.entries(debug as Record<string, unknown>).filter(
      ([, v]) => typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))
    )
  )
  return Object.keys(safe).length ? { ...rest, debug: safe } : rest
}

function isLikelyUrl(s: string) {
  return /^https?:\/\//i.test(s) || s.startsWith("/")
}

async function detectLocalSegmenter(): Promise<string | null> {
  if (process.env.NODE_ENV === "production") return null

  type CacheEntry = { t: number; base: string | null }
  const CACHE_OK_TTL_MS = 60_000
  const CACHE_FAIL_TTL_MS = 4_000
  const g = globalThis as unknown as { __sunnyviewLocalSegmenterCache?: CacheEntry }
  const cached = g.__sunnyviewLocalSegmenterCache
  if (cached) {
    const age = Date.now() - cached.t
    const ttl = cached.base ? CACHE_OK_TTL_MS : CACHE_FAIL_TTL_MS
    if (age >= 0 && age < ttl) return cached.base
  }

  const bases = ["http://127.0.0.1:8000", "http://localhost:8000"]
  for (const base of bases) {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), 1200)
    try {
      const res = await fetch(`${base}/healthz`, { signal: ac.signal, headers: { accept: "application/json" } })
      if (res.ok) {
        g.__sunnyviewLocalSegmenterCache = { t: Date.now(), base }
        return base
      }
    } catch {
      // ignore
    } finally {
      clearTimeout(t)
    }
  }
  g.__sunnyviewLocalSegmenterCache = { t: Date.now(), base: null }
  return null
}

async function imageUrlToDataUrl(imageUrl: string, signal: AbortSignal) {
  // Trust is derived from server config only, never from the request Host.
  const validate = (url: string) => resolveAllowedImageUrl(url)
  const abs = validate(imageUrl)

  const res = await fetchWithValidatedRedirects(
    abs,
    validate,
    { cache: "no-store", signal, headers: { accept: "image/*" } },
    IMAGE_FETCH_TIMEOUT_MS
  )
  if (!res.ok) throw new SafeImageError(`Image fetch failed (${res.status})`)

  const ct = res.headers.get("content-type") ?? "image/png"
  if (!ct.toLowerCase().startsWith("image/")) {
    throw new SafeImageError("Fetched URL did not return an image")
  }

  const ab = await readBufferWithLimit(res, MAX_IMAGE_BYTES)
  const base64 = Buffer.from(ab).toString("base64")
  return `data:${ct};base64,${base64}`
}

function ok(body: unknown) {
  return NextResponse.json(body, { status: 200 })
}

/** Centred ~14m x 9m rectangle sized from the map metadata (confidence 0.15). */
function rectFallback(values: MetaValues & { zoom: number; widthPx: number; heightPx: number }, note: string, extra: object = {}) {
  const roofPolygon = fallbackRectRoofPolygon({
    widthPx: values.widthPx,
    heightPx: values.heightPx,
    zoom: values.zoom,
    scale: values.staticScale,
    lat: values.lat,
  })
  return ok({ roofPolygon, source: "fallback_rect", confidence: 0.15, note, ...extra })
}

/** Tiny centred square used when there is no usable map metadata (confidence 0.1). */
function tinyFallback(note: string, extra: object = {}) {
  return ok({ roofPolygon: TINY_FALLBACK_POLYGON, source: "fallback_rect", confidence: 0.1, note, ...extra })
}

/** Rect fallback when zoom/size metadata exists, otherwise the tiny square. */
function bestFallback(values: MetaValues, note: string, extra: object = {}) {
  if (values.zoom !== null && values.widthPx !== null && values.heightPx !== null) {
    return rectFallback({ ...values, zoom: values.zoom, widthPx: values.widthPx, heightPx: values.heightPx }, note, extra)
  }
  return tinyFallback(note, extra)
}

function lockedFootprintResponse(footprint: unknown, source: string, note: string, extra: object = {}) {
  return ok({ roofPolygon: footprint, source, confidence: 0.45, note, ...extra })
}

/** No segmentation service configured: try a footprint-based outline using OSM buildings. */
async function segmentWithoutService(opts: {
  values: MetaValues
  meta: Record<string, unknown> | undefined
  clicks: SegmentClick[] | undefined
  signal: AbortSignal
}) {
  const { values, meta, clicks, signal } = opts
  if (!hasMapMeta(values)) {
    return tinyFallback(
      "Auto-outline fallback: SEGMENT_SERVICE_URL not configured and no map metadata available. Using a small rectangle; trace manually or run the Python segmenter."
    )
  }

  const lockedFootprint = meta?.osmFootprint
  if (extractGeojsonRingNorm(lockedFootprint)) {
    return ok({ roofPolygon: lockedFootprint, source: "osm_footprint_user", confidence: 0.7 })
  }

  try {
    const { tf, scored, pick } = await locateBuildings({ meta: values, clicks, signal })

    if (pick.kind === "single") {
      const includeCandidates = scored.length > 1
      return ok({
        roofPolygon: normalizeCandidatePolygon(pick.best, tf),
        source: "osm_building",
        ...(includeCandidates
          ? {
              candidates: scored.slice(0, 5).map((c) => serializeOsmCandidate(c, tf)),
              note: OSM_MULTIPLE_NOTE,
            }
          : {}),
        confidence: pick.best.containsFocus || pick.best.addrScore > 0 ? 0.8 : 0.6,
        debug: { bestId: pick.best.id, addrScore: pick.best.addrScore, contains: pick.best.containsFocus },
      })
    }
    if (pick.kind === "candidates") {
      return ok({
        candidates: pick.candidates.map((c) => serializeOsmCandidate(c, tf)),
        source: "osm_candidates",
        note: OSM_MULTIPLE_NOTE,
      })
    }
  } catch (e) {
    // Overpass is an external dependency; don't hard-fail the UX.
    console.warn("[segment] overpass lookup failed", { name: e instanceof Error ? e.name : typeof e })
    const timedOut = signal.aborted || (e instanceof Error && e.name === "AbortError")
    return rectFallback(
      values,
      "Overpass lookup failed" + (timedOut ? " (timed out)." : ".") + " Using a rough rectangle. " + RUN_SEGMENTER_HINT
    )
  }

  return rectFallback(
    values,
    "No building footprint found near this address. Using a rough rectangle; trace manually or run the Python segmenter (SEGMENT_SERVICE_URL)."
  )
}

/** Resolves the request image into a base64 data URL, or returns an error response. */
async function resolveImageDataUrl(
  data: { imageDataUrl?: string; imageUrl?: string }
): Promise<{ dataUrl: string } | { error: Response }> {
  let imageDataUrl = data.imageDataUrl?.trim() || null
  const imageUrl = data.imageUrl?.trim() || null

  if (!imageDataUrl && imageUrl) {
    if (!isLikelyUrl(imageUrl)) {
      return { error: NextResponse.json({ error: "Invalid imageUrl" }, { status: 400 }) }
    }
    try {
      imageDataUrl = await imageUrlToDataUrl(imageUrl, AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS))
    } catch (e) {
      // Only SafeImageError messages are client-safe; anything else may name internal hosts.
      if (!(e instanceof SafeImageError)) {
        console.warn("[segment] image fetch failed", { name: e instanceof Error ? e.name : typeof e })
      }
      return {
        error: NextResponse.json({ error: e instanceof SafeImageError ? e.message : "Failed to fetch image" }, { status: 502 }),
      }
    }
  }

  if (!imageDataUrl) {
    return { error: NextResponse.json({ error: "Provide imageDataUrl or imageUrl" }, { status: 400 }) }
  }

  const limitMb = Math.round(MAX_IMAGE_BYTES / (1024 * 1024))
  if (imageDataUrl.length > MAX_IMAGE_BYTES * 2) {
    return { error: NextResponse.json({ error: `Image payload exceeds ${limitMb}MB limit` }, { status: 413 }) }
  }

  const imageSizeBytes = estimateDataUrlBytes(imageDataUrl)
  if (imageSizeBytes === null) {
    return { error: NextResponse.json({ error: "imageDataUrl must be a base64 data:image/* URL" }, { status: 400 }) }
  }
  if (imageSizeBytes > MAX_IMAGE_BYTES) {
    return { error: NextResponse.json({ error: `Image exceeds ${limitMb}MB limit` }, { status: 413 }) }
  }
  return { dataUrl: imageDataUrl }
}

export async function POST(req: Request) {
  const clientKey = requestClientKey(req.headers)
  const rate = takeRateLimitToken({
    key: `segment:${clientKey}`,
    limit: RATE_LIMIT_MAX,
    windowMs: RATE_LIMIT_WINDOW_MS,
  })
  if (!rate.ok) {
    return NextResponse.json(
      { error: "Too many segmentation requests. Please slow down." },
      {
        status: 429,
        headers: { "retry-after": String(rate.retryAfterSec) },
      }
    )
  }

  const capped = await readCappedJson(req, MAX_BODY_BYTES)
  if (!capped.ok && capped.status === 413) {
    return NextResponse.json({ error: "Request body too large" }, { status: 413 })
  }
  const parsed = SegmentSchema.safeParse(capped.ok ? capped.body : {})
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", issues: parsed.error.issues }, { status: 400 })
  }

  let svc = process.env.SEGMENT_SERVICE_URL?.trim() || null
  if (!svc) svc = await detectLocalSegmenter()
  const { mode = "roof", clicks, roi, meta } = parsed.data
  const values = readMetaValues(meta)
  const upstreamSignal = AbortSignal.timeout(SEGMENT_UPSTREAM_TIMEOUT_MS)

  if (!svc) return await segmentWithoutService({ values, meta, clicks, signal: upstreamSignal })

  const image = await resolveImageDataUrl(parsed.data)
  if ("error" in image) return image.error
  const imageDataUrl = image.dataUrl

  const svcUrl = `${svc.replace(/\/$/, "")}/segment`

  async function callService(payload: Record<string, unknown>) {
    const res = await fetchWithTimeout(
      svcUrl,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          // Server-only shared secret; never sent to or derived from the client.
          ...(process.env.SEGMENT_SHARED_SECRET ? { "x-segment-secret": process.env.SEGMENT_SHARED_SECRET } : {}),
        },
        body: JSON.stringify(payload),
      },
      SEGMENT_SERVICE_TIMEOUT_MS
    )
    const json = await res.json().catch(() => null)
    return { res, json }
  }

  try {
    // If we have map metadata, use OSM to guide the segmenter to the correct building.
    // If the client already supplied an `osmFootprint`, treat it as locked and do not override.
    const guided = await buildSegmentGuidance({ clicks, roi, meta, values, signal: upstreamSignal })
    const { clicks: guidedClicks, roi: guidedRoi, meta: guidedMeta, osmCandidates, osmNote } = guided

    const respondOk = (raw: unknown) => {
      const json = sanitizeServiceJson(raw)
      return ok(mergeOsmCandidates(json && typeof json === "object" ? json : {}, osmCandidates, osmNote))
    }
    const osmExtras = osmCandidateExtras(osmCandidates, osmNote)

    // Try the most common payloads.
    const base = {
      mode,
      ...(guidedClicks ? { clicks: guidedClicks } : {}),
      ...(guidedRoi ? { roi: guidedRoi } : {}),
      ...(guidedMeta ? { meta: guidedMeta } : {}),
    }

    const attempt1 = await callService({ imageDataUrl, ...base })
    if (attempt1.res.ok) return respondOk(attempt1.json)

    // Some services expect `imageRef` instead of `imageDataUrl`.
    const attempt2 = await callService({ imageRef: imageDataUrl, ...base })
    if (attempt2.res.ok) return respondOk(attempt2.json)

    // Compatibility: some upstreams require a click even when a box/ROI is provided.
    if ((!guidedClicks || guidedClicks.length === 0) && guidedRoi) {
      const roiClick = { x: guidedRoi.x + guidedRoi.w / 2, y: guidedRoi.y + guidedRoi.h / 2, type: "pos" as const }
      const attempt3 = await callService({ imageDataUrl, ...base, clicks: [roiClick] })
      if (attempt3.res.ok) return respondOk(attempt3.json)
    }

    // Upstream bodies are logged server-side only; clients get the status code.
    console.warn("[segment] segmenter returned an error", { status: attempt2.res.status })
    const debug = { status: attempt2.res.status }
    const lockedFootprint = guidedMeta?.osmFootprint
    if (lockedFootprint) {
      return lockedFootprintResponse(lockedFootprint, "osm_footprint_after_segmenter_error", "CV failed; using OSM outline.", {
        ...osmExtras,
        debug,
      })
    }
    return bestFallback(values, "CV failed; using rectangle.", { ...osmExtras, debug })
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "AbortError"
    console.warn("[segment] segmenter call failed", { name: e instanceof Error ? e.name : typeof e, timedOut })
    const lockedFootprint = meta?.osmFootprint
    if (lockedFootprint) {
      return lockedFootprintResponse(
        lockedFootprint,
        "osm_footprint_after_segmenter_exception",
        timedOut ? "Timeout; using OSM outline." : "CV failed; using OSM outline."
      )
    }
    return bestFallback(values, timedOut ? "Timeout; using rectangle." : "CV failed; using rectangle.")
  }
}
