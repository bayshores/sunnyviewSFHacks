import { clamp } from "@/lib/geo/math"
import { asRecord } from "@/lib/geo/narrow"

/**
 * Thin fetchers for the public geocoding providers (Esri World Geocoder, Nominatim).
 * Callers own timeouts (pass an AbortSignal) and the Nominatim user-agent string.
 */

const ESRI_BASE = "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer"
const NOMINATIM_BASE = "https://nominatim.openstreetmap.org"

export type EsriSuggest = {
  text?: string
  magicKey?: string
  isCollection?: boolean
}

export type EsriCandidate = {
  address?: string
  location?: { x?: number; y?: number }
  score?: number
}

export type NominatimHit = {
  place_id?: number
  osm_type?: string
  osm_id?: number
  lat?: string
  lon?: string
  display_name?: string
  importance?: number
  class?: string
  type?: string
  address?: Record<string, unknown>
}

export class GeocoderHttpError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`Geocoder error (${status})`)
    this.name = "GeocoderHttpError"
    this.status = status
  }
}

type Bias = { biasLat?: number | null; biasLng?: number | null }

function hasBias(b: Bias): b is { biasLat: number; biasLng: number } {
  return typeof b.biasLat === "number" && typeof b.biasLng === "number"
}

const ESRI_HEADERS = { accept: "application/json", "accept-language": "en" }

function nominatimHeaders(userAgent: string, acceptLanguage: string | null = "en") {
  return {
    accept: "application/json",
    ...(acceptLanguage ? { "accept-language": acceptLanguage } : {}),
    "user-agent": userAgent,
  }
}

async function readJson(res: Response): Promise<unknown> {
  return await res.json().catch(() => null)
}

/** Esri `findAddressCandidates` (US addresses). Throws GeocoderHttpError on non-2xx. */
export async function fetchEsriCandidates(
  opts: { q: string; limit: number; magicKey?: string | null; signal: AbortSignal } & Bias
): Promise<EsriCandidate[]> {
  const url = new URL(`${ESRI_BASE}/findAddressCandidates`)
  url.searchParams.set("f", "json")
  url.searchParams.set("singleLine", opts.q)
  url.searchParams.set("maxLocations", String(opts.limit))
  url.searchParams.set("category", "Address")
  url.searchParams.set("countryCode", "USA")
  if (hasBias(opts)) url.searchParams.set("location", `${opts.biasLng},${opts.biasLat}`)
  if (opts.magicKey) url.searchParams.set("magicKey", opts.magicKey)

  const res = await fetch(url.toString(), { signal: opts.signal, headers: ESRI_HEADERS })
  if (!res.ok) throw new GeocoderHttpError(res.status)
  const data = asRecord(await readJson(res))
  return Array.isArray(data?.candidates) ? (data.candidates as EsriCandidate[]) : []
}

/** Esri `suggest` (autocomplete). Throws GeocoderHttpError on non-2xx. */
export async function fetchEsriSuggestions(
  opts: { q: string; limit: number; signal: AbortSignal } & Bias
): Promise<EsriSuggest[]> {
  const url = new URL(`${ESRI_BASE}/suggest`)
  url.searchParams.set("f", "json")
  url.searchParams.set("text", opts.q)
  url.searchParams.set("maxSuggestions", String(opts.limit))
  url.searchParams.set("category", "Address")
  url.searchParams.set("countryCode", "USA")
  if (hasBias(opts)) url.searchParams.set("location", `${opts.biasLng},${opts.biasLat}`)

  const res = await fetch(url.toString(), { signal: opts.signal, headers: ESRI_HEADERS })
  if (!res.ok) throw new GeocoderHttpError(res.status)
  const data = asRecord(await readJson(res))
  return Array.isArray(data?.suggestions) ? (data.suggestions as EsriSuggest[]) : []
}

/** Esri `reverseGeocode`. Returns the best label, or null on non-2xx / no label. */
export async function fetchEsriReverseLabel(lat: number, lng: number, signal: AbortSignal): Promise<string | null> {
  const url = new URL(`${ESRI_BASE}/reverseGeocode`)
  url.searchParams.set("f", "json")
  url.searchParams.set("location", `${lng},${lat}`)
  url.searchParams.set("outSR", "4326")
  url.searchParams.set("langCode", "EN")

  const res = await fetch(url.toString(), { signal, headers: ESRI_HEADERS })
  if (!res.ok) return null
  const addr = asRecord(asRecord(await readJson(res))?.address)
  const longLabel = typeof addr?.LongLabel === "string" ? addr.LongLabel : null
  const match = typeof addr?.Match_addr === "string" ? addr.Match_addr : null
  return (longLabel ?? match ?? null)?.trim() || null
}

/** Nominatim `/search` with an optional +/-0.5 degree viewbox bias. Throws GeocoderHttpError on non-2xx. */
export async function fetchNominatimSearch(
  opts: {
    q: string
    limit: number
    signal: AbortSignal
    userAgent: string
    format?: "json" | "jsonv2"
    dedupe?: boolean
    acceptLanguage?: string | null
  } & Bias
): Promise<NominatimHit[]> {
  const url = new URL(`${NOMINATIM_BASE}/search`)
  url.searchParams.set("format", opts.format ?? "jsonv2")
  url.searchParams.set("addressdetails", "1")
  if (opts.dedupe ?? true) url.searchParams.set("dedupe", "1")
  url.searchParams.set("limit", String(opts.limit))
  url.searchParams.set("q", opts.q)

  if (hasBias(opts)) {
    const delta = 0.5
    const left = clamp(opts.biasLng - delta, -180, 180)
    const right = clamp(opts.biasLng + delta, -180, 180)
    const bottom = clamp(opts.biasLat - delta, -90, 90)
    const top = clamp(opts.biasLat + delta, -90, 90)
    url.searchParams.set("viewbox", `${left},${top},${right},${bottom}`)
  }

  const res = await fetch(url.toString(), {
    signal: opts.signal,
    headers: nominatimHeaders(opts.userAgent, opts.acceptLanguage === undefined ? "en" : opts.acceptLanguage),
  })
  if (!res.ok) throw new GeocoderHttpError(res.status)
  const data = (await readJson(res)) as unknown
  return Array.isArray(data) ? (data as NominatimHit[]) : []
}

/** Nominatim `/reverse` at zoom 18. Returns the raw JSON (or null). Throws GeocoderHttpError on non-2xx. */
export async function fetchNominatimReverse(opts: {
  lat: number
  lng: number
  signal?: AbortSignal
  userAgent: string
  extratags?: boolean
  /** Ask for the hit's geometry (`polygon_geojson=1`), e.g. a building footprint. */
  polygonGeojson?: boolean
}): Promise<unknown> {
  const url = new URL(`${NOMINATIM_BASE}/reverse`)
  url.searchParams.set("format", "jsonv2")
  url.searchParams.set("lat", String(opts.lat))
  url.searchParams.set("lon", String(opts.lng))
  url.searchParams.set("zoom", "18")
  url.searchParams.set("addressdetails", "1")
  if (opts.extratags) url.searchParams.set("extratags", "1")
  if (opts.polygonGeojson) url.searchParams.set("polygon_geojson", "1")

  const res = await fetch(url.toString(), { signal: opts.signal, headers: nominatimHeaders(opts.userAgent) })
  if (!res.ok) throw new GeocoderHttpError(res.status)
  return await readJson(res)
}
