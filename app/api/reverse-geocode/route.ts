import { NextRequest } from "next/server"

import { asRecord } from "@/lib/geo/narrow"
import { clamp, MERCATOR_MAX_LAT, parseNum } from "@/lib/geo/math"
import { fetchEsriReverseLabel, fetchNominatimReverse, GeocoderHttpError } from "@/lib/geo/providers"
import { requestClientKey, takeRateLimitToken } from "@/lib/rate-limit"

export const runtime = "nodejs"

const ROUTE_TIMEOUT_MS = 10_000
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 90

type ReverseOut = {
  lat: number
  lng: number
  displayName: string
  provider: "esri" | "nominatim" | "none"
}

type CacheEntry = { t: number; payload: ReverseOut }
const CACHE_TTL_MS = 60_000
const CACHE_MAX_ENTRIES = 500

function cacheMap() {
  const g = globalThis as unknown as { __sunnyviewReverseGeocodeCache?: Map<string, CacheEntry> }
  if (!g.__sunnyviewReverseGeocodeCache) g.__sunnyviewReverseGeocodeCache = new Map()
  return g.__sunnyviewReverseGeocodeCache
}

function cacheGet(key: string) {
  const hit = cacheMap().get(key)
  if (!hit) return null
  if (Date.now() - hit.t > CACHE_TTL_MS) return null
  return hit.payload
}

function cacheSet(key: string, payload: ReverseOut) {
  const map = cacheMap()
  // Delete first so a refreshed key moves to the end of the insertion order (oldest evicted first).
  map.delete(key)
  map.set(key, { t: Date.now(), payload })
  if (map.size > CACHE_MAX_ENTRIES) {
    const oldestKey = map.keys().next().value
    if (oldestKey) map.delete(oldestKey)
  }
}

const NOMINATIM_USER_AGENT = "sunnyviewSFHacks/1.0 (reverse geocode proxy)"

async function nominatimReverseLabel(lat: number, lng: number, signal: AbortSignal): Promise<string | null> {
  try {
    const json = asRecord(await fetchNominatimReverse({ lat, lng, signal, userAgent: NOMINATIM_USER_AGENT }))
    const displayName = typeof json?.display_name === "string" ? json.display_name : null
    return displayName?.trim() || null
  } catch (e) {
    if (e instanceof GeocoderHttpError) return null
    throw e
  }
}

export async function GET(req: NextRequest) {
  const clientKey = requestClientKey(req.headers)
  const rate = takeRateLimitToken({
    key: `reverse-geocode:${clientKey}`,
    limit: RATE_LIMIT_MAX,
    windowMs: RATE_LIMIT_WINDOW_MS,
  })
  if (!rate.ok) {
    return Response.json(
      { error: "Too many reverse-geocode requests. Please slow down." },
      {
        status: 429,
        headers: { "retry-after": String(rate.retryAfterSec) },
      }
    )
  }

  const { searchParams } = new URL(req.url)
  const latRaw = parseNum(searchParams.get("lat"))
  const lngRaw = parseNum(searchParams.get("lng"))
  if (latRaw === null || lngRaw === null) {
    return Response.json({ error: "Missing lat/lng" }, { status: 400 })
  }

  const lat = clamp(latRaw, -MERCATOR_MAX_LAT, MERCATOR_MAX_LAT)
  const lng = clamp(lngRaw, -180, 180)

  const key = `rev:${lat.toFixed(5)}:${lng.toFixed(5)}`
  const cached = cacheGet(key)
  if (cached) return Response.json(cached, { status: 200 })

  const ac = new AbortController()
  const timeoutId = setTimeout(() => ac.abort(), ROUTE_TIMEOUT_MS)

  // Upstream failures (network errors, timeouts) fall through to the next provider
  // and finally to a coordinate label, so the client never sees a raw 500.
  let upstreamFailed = false
  const tryLabel = async (lookup: () => Promise<string | null>) => {
    try {
      return await lookup()
    } catch {
      upstreamFailed = true
      return null
    }
  }

  try {
    const esri = await tryLabel(() => fetchEsriReverseLabel(lat, lng, ac.signal))
    if (esri) {
      const out: ReverseOut = { lat, lng, displayName: esri, provider: "esri" }
      cacheSet(key, out)
      return Response.json(out, { status: 200 })
    }

    const nom = await tryLabel(() => nominatimReverseLabel(lat, lng, ac.signal))
    if (nom) {
      const out: ReverseOut = { lat, lng, displayName: nom, provider: "nominatim" }
      cacheSet(key, out)
      return Response.json(out, { status: 200 })
    }

    const out: ReverseOut = {
      lat,
      lng,
      displayName: `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
      provider: "none",
    }
    // Don't cache a transient-failure result; a retry may succeed.
    if (!upstreamFailed) cacheSet(key, out)
    return Response.json(out, { status: 200 })
  } finally {
    clearTimeout(timeoutId)
    ac.abort()
  }
}
