import { NextRequest } from "next/server"
import { clamp, MERCATOR_MAX_LAT, parseNum } from "@/lib/geo/math"
import { buildArcgisImageryUrl } from "@/lib/arcgis-imagery"
import { fetchEsriCandidates, fetchNominatimSearch, GeocoderHttpError } from "@/lib/geo/providers"
import { requestClientKey, takeRateLimitToken } from "@/lib/rate-limit"

export const runtime = "nodejs"

const ROUTE_TIMEOUT_MS = 12_000
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 45
const LOG_PREFIX = "[static-map]"

const NOMINATIM_USER_AGENT = "sunnyviewSFHacks/1.0 (static-map proxy)"

type LatLng = { lat: number; lng: number }

function requireLatLng(lat: number, lng: number): LatLng {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error("No geocoding results")
  return { lat, lng }
}

// Provider HTTP failures surface as "Geocoding failed (status)" to keep the public error text stable.
function asGeocodingFailure(e: unknown): unknown {
  return e instanceof GeocoderHttpError ? new Error(`Geocoding failed (${e.status})`) : e
}

async function geocodeAddressViaNominatim(address: string, signal: AbortSignal): Promise<LatLng> {
  try {
    const hits = await fetchNominatimSearch({
      q: address,
      limit: 1,
      signal,
      userAgent: NOMINATIM_USER_AGENT,
      format: "json",
      dedupe: false,
      acceptLanguage: null,
    })
    const hit = hits[0]
    return requireLatLng(hit ? Number(hit.lat) : NaN, hit ? Number(hit.lon) : NaN)
  } catch (e) {
    throw asGeocodingFailure(e)
  }
}

async function geocodeAddressViaEsri(address: string, signal: AbortSignal): Promise<LatLng> {
  try {
    const candidates = await fetchEsriCandidates({ q: address, limit: 1, signal })
    const cand = candidates[0]
    return requireLatLng(Number(cand?.location?.y), Number(cand?.location?.x))
  } catch (e) {
    throw asGeocodingFailure(e)
  }
}

async function geocodeAddress(address: string, signal: AbortSignal) {
  try {
    const out = await geocodeAddressViaEsri(address, signal)
    console.info(`${LOG_PREFIX} geocode`, { provider: "esri", lat: Number(out.lat.toFixed(6)), lng: Number(out.lng.toFixed(6)) })
    return out
  } catch (e) {
    const message = e instanceof Error ? e.message : "Esri geocoder failed"
    console.warn(`${LOG_PREFIX} geocode provider failed`, { provider: "esri", message })
  }

  const out = await geocodeAddressViaNominatim(address, signal)
  console.info(`${LOG_PREFIX} geocode`, { provider: "nominatim", lat: Number(out.lat.toFixed(6)), lng: Number(out.lng.toFixed(6)) })
  return out
}

type ImageFetchResult =
  | { ok: true; body: ArrayBuffer; contentType: string; durationMs: number }
  | {
      ok: false
      durationMs: number
      status: number
      kind: "fetch" | "http" | "non-image" | "empty"
      details: string
      contentType?: string
    }

async function fetchUpstreamImage(url: URL, signal: AbortSignal): Promise<ImageFetchResult> {
  const startedAt = Date.now()
  let res: Response

  try {
    res = await fetch(url.toString(), {
      signal,
      headers: { accept: "image/*" },
      cache: "no-store",
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Fetch failed"
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      status: 0,
      kind: "fetch",
      details: message,
    }
  }

  const durationMs = Date.now() - startedAt
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    return {
      ok: false,
      durationMs,
      status: res.status,
      kind: "http",
      details: text.slice(0, 500),
      contentType: res.headers.get("content-type") ?? "",
    }
  }

  const contentTypeRaw = res.headers.get("content-type") ?? ""
  const contentType = contentTypeRaw.toLowerCase()
  if (!contentType.startsWith("image/")) {
    const text = await res.text().catch(() => "")
    return {
      ok: false,
      durationMs,
      status: 502,
      kind: "non-image",
      details: text.slice(0, 500),
      contentType: contentTypeRaw,
    }
  }

  const body = await res.arrayBuffer()
  if (!body.byteLength) {
    return {
      ok: false,
      durationMs,
      status: 502,
      kind: "empty",
      details: "Provider returned an empty image body",
      contentType: contentTypeRaw,
    }
  }

  return {
    ok: true,
    body,
    contentType: contentTypeRaw || "image/png",
    durationMs,
  }
}

function buildMapboxStaticUrl(params: {
  lat: number
  lng: number
  zoom: number
  outW: number
  outH: number
  token: string
}) {
  const center = `${params.lng.toFixed(6)},${params.lat.toFixed(6)},${Math.round(params.zoom)},0`
  const size = `${Math.round(params.outW)}x${Math.round(params.outH)}`
  return new URL(
    `https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/${center}/${size}?access_token=${encodeURIComponent(params.token)}`
  )
}

export async function GET(req: NextRequest) {
  const clientKey = requestClientKey(req.headers)
  const rate = takeRateLimitToken({
    key: `static-map:${clientKey}`,
    limit: RATE_LIMIT_MAX,
    windowMs: RATE_LIMIT_WINDOW_MS,
  })
  if (!rate.ok) {
    return Response.json(
      { error: "Too many static-map requests. Please slow down." },
      {
        status: 429,
        headers: { "retry-after": String(rate.retryAfterSec) },
      }
    )
  }

  const { searchParams } = new URL(req.url)

  const address = (searchParams.get("address") ?? "").trim()
  const latParam = parseNum(searchParams.get("lat"))
  const lngParam = parseNum(searchParams.get("lng"))

  const zoom = clamp(parseNum(searchParams.get("zoom")) ?? 19, 0, 22)
  const w = clamp(Math.round(parseNum(searchParams.get("w")) ?? 520), 64, 2048)
  const h = clamp(Math.round(parseNum(searchParams.get("h")) ?? 360), 64, 2048)
  const scale = clamp(Math.round(parseNum(searchParams.get("scale")) ?? 2), 1, 2)

  const ac = new AbortController()
  const signal = ac.signal
  const timeout = setTimeout(() => ac.abort(), ROUTE_TIMEOUT_MS)

  let lat = latParam
  let lng = lngParam

  console.info(`${LOG_PREFIX} request`, {
    hasAddress: !!address,
    hasCoords: lat !== null && lng !== null,
    zoom,
    w,
    h,
    scale,
  })

  try {
    if (lat === null || lng === null) {
      if (!address) {
        return Response.json({ error: "Provide either (lat,lng) or address." }, { status: 400 })
      }
      const hit = await geocodeAddress(address, signal)
      lat = hit.lat
      lng = hit.lng
    }

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return Response.json({ error: "Invalid coordinates." }, { status: 400 })
    }

    lat = clamp(lat, -MERCATOR_MAX_LAT, MERCATOR_MAX_LAT)
    lng = clamp(lng, -180, 180)

    const outW = clamp(w * scale, 64, 2048)
    const outH = clamp(h * scale, 64, 2048)

    let lastFailure: ImageFetchResult | null = null
    const arcgisAttempts = [
      { scale, label: `scale-${scale}` },
      ...(scale > 1 ? [{ scale: 1, label: "scale-1-fallback" }] : []),
    ]

    for (const attempt of arcgisAttempts) {
      const url = buildArcgisImageryUrl({ lat, lng, zoom, w, h, scale: attempt.scale })
      const img = await fetchUpstreamImage(url, signal)
      if (img.ok) {
        console.info(`${LOG_PREFIX} success`, {
          provider: "arcgis",
          attempt: attempt.label,
          durationMs: img.durationMs,
          bytes: img.body.byteLength,
          contentType: img.contentType,
          lat: Number(lat.toFixed(6)),
          lng: Number(lng.toFixed(6)),
          zoom,
        })
        return new Response(img.body, {
          status: 200,
          headers: {
            "content-type": img.contentType,
            "cache-control": "public, max-age=86400, s-maxage=86400",
            "x-static-map-provider": "arcgis",
            "x-static-map-attempt": attempt.label,
          },
        })
      }

      lastFailure = img
      console.warn(`${LOG_PREFIX} arcgis failed`, {
        attempt: attempt.label,
        kind: img.kind,
        status: img.status,
        durationMs: img.durationMs,
        contentType: img.contentType ?? "",
        details: img.details.slice(0, 220),
      })
    }

    const mapboxToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN?.trim() ?? ""
    if (mapboxToken) {
      const mapboxUrl = buildMapboxStaticUrl({ lat, lng, zoom, outW, outH, token: mapboxToken })
      const mapboxImage = await fetchUpstreamImage(mapboxUrl, signal)
      if (mapboxImage.ok) {
        console.info(`${LOG_PREFIX} success`, {
          provider: "mapbox",
          durationMs: mapboxImage.durationMs,
          bytes: mapboxImage.body.byteLength,
          contentType: mapboxImage.contentType,
          lat: Number(lat.toFixed(6)),
          lng: Number(lng.toFixed(6)),
          zoom,
        })
        return new Response(mapboxImage.body, {
          status: 200,
          headers: {
            "content-type": mapboxImage.contentType,
            "cache-control": "public, max-age=86400, s-maxage=86400",
            "x-static-map-provider": "mapbox",
          },
        })
      }

      lastFailure = mapboxImage
      console.warn(`${LOG_PREFIX} mapbox fallback failed`, {
        kind: mapboxImage.kind,
        status: mapboxImage.status,
        durationMs: mapboxImage.durationMs,
        contentType: mapboxImage.contentType ?? "",
        details: mapboxImage.details.slice(0, 220),
      })
    }

    const status = lastFailure && lastFailure.status > 0 ? 502 : 500
    return Response.json(
      {
        error: "Static map providers unavailable.",
        details: lastFailure?.details ?? "No provider response",
      },
      { status }
    )
  } catch (e) {
    const message = e instanceof Error ? e.message : "Static map failed."
    const timedOut = signal.aborted
    console.error(`${LOG_PREFIX} failed`, {
      timedOut,
      message,
    })
    return Response.json(
      { error: timedOut ? "Static map request timed out. Please try again." : message },
      { status: timedOut ? 504 : 500 }
    )
  } finally {
    clearTimeout(timeout)
    ac.abort()
  }
}
