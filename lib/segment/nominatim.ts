import { clamp, MERCATOR_MAX_LAT, toFiniteNumber } from "@/lib/geo/math"
import { fetchNominatimReverse } from "@/lib/geo/providers"

type ReverseHit = {
  osm_type?: unknown
  osm_id?: unknown
  category?: unknown
  type?: unknown
  address?: unknown
}

function str(v: unknown) {
  return typeof v === "string" && v.trim() ? v.trim() : null
}

export type NominatimReverseResult = {
  osmType: "way" | "relation" | "node" | null
  osmId: number | null
  category: string | null
  type: string | null
  address: Record<string, unknown> | null
}

export async function nominatimReverse(opts: { lat: number; lng: number; signal?: AbortSignal }): Promise<NominatimReverseResult> {
  const lat = clamp(opts.lat, -MERCATOR_MAX_LAT, MERCATOR_MAX_LAT)
  const lng = clamp(opts.lng, -180, 180)

  const json = (await fetchNominatimReverse({
    lat,
    lng,
    signal: opts.signal,
    userAgent: "sunnyviewSFHacks/1.0 (segment proxy)",
    extratags: true,
  })) as ReverseHit | null

  const osmTypeRaw = str(json?.osm_type)
  const osmType = osmTypeRaw === "way" || osmTypeRaw === "relation" || osmTypeRaw === "node" ? osmTypeRaw : null
  const osmId = toFiniteNumber(json?.osm_id)
  const category = str(json?.category)
  const type = str(json?.type)
  const address = json?.address && typeof json.address === "object" ? (json.address as Record<string, unknown>) : null

  return {
    osmType,
    osmId: osmId !== null ? Math.round(osmId) : null,
    category,
    type,
    address,
  }
}

export function looksLikeBuildingHit(hit: NominatimReverseResult) {
  if (!hit.osmType || !hit.osmId) return false
  const cat = (hit.category ?? "").toLowerCase()
  const type = (hit.type ?? "").toLowerCase()
  if (cat === "building") return true
  if (type === "house" || type === "residential" || type === "building") return true
  return false
}
