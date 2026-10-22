import { clamp, MERCATOR_MAX_LAT, toFiniteNumber } from "@/lib/geo/math"
import { EARTH_RADIUS_M } from "@/lib/geo/mercator"
import { fetchNominatimReverse } from "@/lib/geo/providers"

import type { OverpassElement } from "@/lib/segment/osm-buildings"

// Plausible single-building roof footprint. Larger polygons are usually campuses or landuse.
export const MIN_FOOTPRINT_AREA_M2 = 10
export const MAX_FOOTPRINT_AREA_M2 = 20_000
export const MAX_FOOTPRINT_VERTICES = 500

type ReverseHit = {
  osm_type?: unknown
  osm_id?: unknown
  category?: unknown
  type?: unknown
  address?: unknown
  geojson?: unknown
}

export type LatLon = { lat: number; lon: number }

function str(v: unknown) {
  return typeof v === "string" && v.trim() ? v.trim() : null
}

export type NominatimReverseResult = {
  osmType: "way" | "relation" | "node" | null
  osmId: number | null
  category: string | null
  type: string | null
  address: Record<string, unknown> | null
  /** Outer rings (closing point dropped) of the hit's Polygon/MultiPolygon geometry, if any. */
  footprintRings: LatLon[][]
}

/** GeoJSON `[lon, lat]` ring -> lat/lon points without the closing duplicate; null if malformed. */
function parseRing(raw: unknown): LatLon[] | null {
  if (!Array.isArray(raw)) return null
  const pts: LatLon[] = []
  for (const p of raw) {
    if (!Array.isArray(p)) return null
    const lon = toFiniteNumber(p[0])
    const lat = toFiniteNumber(p[1])
    if (lat === null || lon === null) return null
    pts.push({ lat, lon })
  }
  const first = pts[0]
  const last = pts[pts.length - 1]
  if (pts.length > 1 && Math.abs(first.lat - last.lat) < 1e-12 && Math.abs(first.lon - last.lon) < 1e-12) pts.pop()
  return pts.length >= 3 ? pts : null
}

/** Outer rings of a GeoJSON Polygon or MultiPolygon (holes ignored, like the Overpass path). */
export function parseFootprintRings(geojson: unknown): LatLon[][] {
  const g = geojson && typeof geojson === "object" ? (geojson as { type?: unknown; coordinates?: unknown }) : null
  if (!g || !Array.isArray(g.coordinates)) return []
  const polygons = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : []
  const rings: LatLon[][] = []
  for (const poly of polygons) {
    const outer = Array.isArray(poly) ? parseRing(poly[0]) : null
    if (outer) rings.push(outer)
  }
  return rings
}

/** Ring area in m2 using a local equirectangular projection (accurate for building-sized rings). */
function ringAreaM2(ring: LatLon[]) {
  const lat0 = (ring.reduce((s, p) => s + p.lat, 0) / ring.length) * (Math.PI / 180)
  const k = (Math.PI / 180) * EARTH_RADIUS_M
  let a = 0
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]
    const q = ring[(i + 1) % ring.length]
    a += p.lon * k * Math.cos(lat0) * (q.lat * k) - q.lon * k * Math.cos(lat0) * (p.lat * k)
  }
  return Math.abs(a) / 2
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
    polygonGeojson: true,
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
    footprintRings: parseFootprintRings(json?.geojson),
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

/** Stricter than looksLikeBuildingHit: `residential` alone also matches landuse/highway polygons. */
function looksLikeBuildingFootprint(hit: NominatimReverseResult) {
  if (!looksLikeBuildingHit(hit)) return false
  const cat = (hit.category ?? "").toLowerCase()
  const type = (hit.type ?? "").toLowerCase()
  return cat === "building" || type === "house" || type === "building"
}

function addressTags(address: Record<string, unknown> | null): Record<string, string> {
  const hn = str(address?.house_number)
  const street = str(address?.road)
  return { ...(hn ? { "addr:housenumber": hn } : {}), ...(street ? { "addr:street": street } : {}) }
}

/**
 * Turns a Nominatim building hit's footprint into an Overpass-shaped element so it can be ranked
 * alongside Overpass results (id becomes `nominatim:<type>:<id>`). Returns null for non-buildings
 * and implausible footprints (too small, campus/landuse sized, or too many vertices).
 */
export function nominatimFootprintElement(hit: NominatimReverseResult): OverpassElement | null {
  if (!looksLikeBuildingFootprint(hit) || (hit.osmType !== "way" && hit.osmType !== "relation") || !hit.osmId) return null
  const rings = hit.footprintRings
  if (rings.length === 0) return null
  if (rings.reduce((n, r) => n + r.length, 0) > MAX_FOOTPRINT_VERTICES) return null
  const areaM2 = rings.reduce((s, r) => s + ringAreaM2(r), 0)
  if (!(areaM2 >= MIN_FOOTPRINT_AREA_M2 && areaM2 <= MAX_FOOTPRINT_AREA_M2)) return null

  const tags = { building: hit.type ?? "yes", ...addressTags(hit.address) }
  const base = { type: `nominatim:${hit.osmType}`, id: hit.osmId, tags }
  if (rings.length === 1) return { ...base, geometry: rings[0] }
  return { ...base, members: rings.map((geometry) => ({ type: "way", role: "outer", geometry })) }
}
