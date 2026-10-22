import { toFiniteNumber } from "@/lib/geo/math"
import { parseAddressHints, scoreAddrMatch, type AddressHints } from "@/lib/segment/address"
import {
  mercatorProject,
  mercatorToNormalized,
  pixelToMercator,
  staticMapTransformFromCenter,
  type StaticMapTransform,
} from "@/lib/segment/mercator"
import {
  distPointToPolygonBoundary2,
  pointInPolygon,
  polygonArea,
  polygonCentroid,
  type Pt,
} from "@/lib/segment/polygon"

export type OverpassTagMap = Record<string, string>

export type OverpassElement = {
  type?: string
  id?: number
  tags?: Record<string, unknown>
  geometry?: Array<{ lat?: unknown; lon?: unknown }>
  members?: Array<{ role?: unknown; geometry?: Array<{ lat?: unknown; lon?: unknown }>; type?: unknown; ref?: unknown }>
}

type CacheEntry = { t: number; elements: OverpassElement[] }
const MEM_TTL_MS = 10 * 60 * 1000

function memCache() {
  const g = globalThis as unknown as { __sunnyviewOverpassCache?: Map<string, CacheEntry> }
  if (!g.__sunnyviewOverpassCache) g.__sunnyviewOverpassCache = new Map()
  return g.__sunnyviewOverpassCache
}

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter",
]

function shouldRetryStatus(status: number) {
  return status === 429 || status === 502 || status === 503 || status === 504
}

async function fetchOverpassQuery(opts: { query: string; signal?: AbortSignal }) {
  const key = `q:${opts.query}`
  const now = Date.now()
  const mem = memCache()
  const hit = mem.get(key)
  if (hit && now - hit.t < MEM_TTL_MS) return hit.elements

  let lastErr: Error | null = null

  for (let attempt = 0; attempt < OVERPASS_ENDPOINTS.length; attempt++) {
    const base = OVERPASS_ENDPOINTS[attempt]
    const url = new URL(base)
    url.searchParams.set("data", opts.query)

    const ac = new AbortController()
    const timeoutMs = 4500
    const t = setTimeout(() => ac.abort(), timeoutMs)
    const onAbort = () => ac.abort()
    if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true })

    try {
      const res = await fetch(url.toString(), {
        signal: ac.signal,
        headers: { accept: "application/json" },
        cache: "no-store",
      })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        const err = new Error(`Overpass failed (${res.status})${text ? `: ${text.slice(0, 120)}` : ""}`)
        if (shouldRetryStatus(res.status)) {
          lastErr = err
          continue
        }
        throw err
      }

      const json = (await res.json().catch(() => null)) as any
      const elements = Array.isArray(json?.elements) ? (json.elements as OverpassElement[]) : []
      mem.set(key, { t: now, elements })
      return elements
    } catch (e) {
      const err = e instanceof Error ? e : new Error("Overpass request failed")
      lastErr = err
      // Try next endpoint on fetch abort/network errors.
      continue
    } finally {
      clearTimeout(t)
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort)
    }
  }

  if (lastErr) throw lastErr
  throw new Error("Overpass request failed")
}

export type BuildingCandidate = {
  id: string
  tags: OverpassTagMap
  ringMerc: Pt[]
  containsFocus: boolean
  areaM2: number
  centroidD2: number
  boundaryD2: number
  addrScore: number
  score: number
}

function toTags(t: Record<string, unknown> | undefined): OverpassTagMap {
  const out: OverpassTagMap = {}
  if (!t) return out
  for (const [k, v] of Object.entries(t)) {
    if (typeof v === "string") out[k] = v
  }
  return out
}

function latLonRingToMercator(ring: Array<{ lat?: unknown; lon?: unknown }>): Pt[] | null {
  const pts: Pt[] = []
  for (const p of ring) {
    const lat = toFiniteNumber(p.lat)
    const lon = toFiniteNumber(p.lon)
    if (lat === null || lon === null) return null
    const m = mercatorProject(lat, lon)
    pts.push({ x: m.x, y: m.y })
  }
  if (pts.length < 3) return null
  // drop duplicate closing point
  const first = pts[0]
  const last = pts[pts.length - 1]
  if (Math.abs(first.x - last.x) < 1e-6 && Math.abs(first.y - last.y) < 1e-6) pts.pop()
  return pts.length >= 3 ? pts : null
}

function extractRings(el: OverpassElement): Array<{ id: string; tags: OverpassTagMap; ringMerc: Pt[] }> {
  const tags = toTags(el.tags)
  const id = typeof el.id === "number" ? el.id : 0
  const typ = typeof el.type === "string" ? el.type : "?"

  const out: Array<{ id: string; tags: OverpassTagMap; ringMerc: Pt[] }> = []

  const geom = Array.isArray(el.geometry) ? el.geometry : null
  if (geom) {
    const ringMerc = latLonRingToMercator(geom)
    if (ringMerc) out.push({ id: `${typ}:${id}`, tags, ringMerc })
  }

  const members = Array.isArray(el.members) ? el.members : null
  if (members) {
    for (let i = 0; i < members.length; i++) {
      const m = members[i]
      const role = typeof m?.role === "string" ? m.role : null
      if (role && role !== "outer" && role !== "") continue
      const mg = Array.isArray(m?.geometry) ? m.geometry : null
      if (!mg) continue
      const ringMerc = latLonRingToMercator(mg)
      if (!ringMerc) continue
      out.push({ id: `${typ}:${id}:m${i}`, tags, ringMerc })
    }
  }

  return out
}

export async function fetchOverpassBuildings(opts: {
  lat: number
  lng: number
  radiusM: number
  signal?: AbortSignal
}): Promise<OverpassElement[]> {
  const q = `[out:json][timeout:10];nwr["building"](around:${Math.round(opts.radiusM)},${opts.lat},${opts.lng});out tags geom;`
  return await fetchOverpassQuery({ query: q, signal: opts.signal })
}

export async function fetchOverpassByOsmId(opts: {
  osmType: "way" | "relation"
  osmId: number
  signal?: AbortSignal
}): Promise<OverpassElement[]> {
  const typ = opts.osmType
  const q = `[out:json][timeout:10];${typ}(${opts.osmId});out tags geom;`
  return await fetchOverpassQuery({ query: q, signal: opts.signal })
}

export async function fetchOverpassByHouseNumber(opts: {
  lat: number
  lng: number
  radiusM: number
  houseNumber: string
  signal?: AbortSignal
}): Promise<OverpassElement[]> {
  const hn = opts.houseNumber.replace(/"/g, "")
  const q =
    `[out:json][timeout:10];nwr["building"]["addr:housenumber"="${hn}"]` +
    `(around:${Math.round(opts.radiusM)},${opts.lat},${opts.lng});out tags geom;`
  return await fetchOverpassQuery({ query: q, signal: opts.signal })
}

function looksResidential(hints: AddressHints | null) {
  if (!hints) return true
  // lightweight: if it looks like a street address with house number, assume residential.
  return !!hints.houseNumber
}

function buildingTypePenalty(tags: OverpassTagMap, residentialIntent: boolean) {
  if (!residentialIntent) return 0
  const b = (tags.building ?? "").toLowerCase()
  if (!b) return 0
  if (b.includes("commercial") || b.includes("industrial") || b.includes("retail") || b.includes("school")) return -0.4
  if (b.includes("church") || b.includes("cathedral")) return -0.6
  return 0
}

export function rankBuildingCandidates(opts: {
  elements: OverpassElement[]
  tf: StaticMapTransform
  focusPx: { x: number; y: number }
  address: string | null
}) {
  const focusMerc = pixelToMercator(opts.focusPx, opts.tf)
  const hints = parseAddressHints(opts.address)
  const residentialIntent = looksResidential(hints)

  const rings = opts.elements.flatMap(extractRings)
  const scored: BuildingCandidate[] = []

  for (const r of rings) {
    const contains = pointInPolygon(focusMerc, r.ringMerc)
    const c = polygonCentroid(r.ringMerc)
    const dx = c.x - focusMerc.x
    const dy = c.y - focusMerc.y
    const centroidD2 = dx * dx + dy * dy
    const boundaryD2 = distPointToPolygonBoundary2(focusMerc, r.ringMerc)
    const area = polygonArea(r.ringMerc)
    const addrScore = scoreAddrMatch(r.tags, hints)

    // Score: prioritize address tag match, then containment, then proximity to boundary.
    const boundaryM = Math.sqrt(boundaryD2)
    const centroidM = Math.sqrt(centroidD2)
    const areaScale = Math.log10(Math.max(10, area))
    const typePenalty = buildingTypePenalty(r.tags, residentialIntent)

    let score = 0

    // Address tags are helpful, but can be wrong/out-of-date in dense areas.
    // Gate the boost by how close the focus point is to the footprint.
    const addrGate = contains ? 1 : Math.max(0, Math.min(1, 1 - boundaryM / 180))
    score += addrScore * 2000 * addrGate
    score += contains ? 1200 : 0
    score += Math.max(0, 450 - boundaryM) * 2
    score += Math.max(0, 120 - centroidM) * 0.5
    score -= areaScale * 8
    score += typePenalty * 100

    scored.push({
      id: r.id,
      tags: r.tags,
      ringMerc: r.ringMerc,
      containsFocus: contains,
      areaM2: area,
      centroidD2,
      boundaryD2,
      addrScore,
      score,
    })
  }

  scored.sort((a, b) => b.score - a.score)
  return scored
}

export function normalizeCandidatePolygon(candidate: BuildingCandidate, tf: StaticMapTransform) {
  const coords = candidate.ringMerc.map((p) => {
    const n = mercatorToNormalized(p, tf)
    return [n.x, n.y]
  })
  return { type: "Polygon" as const, coordinates: [coords] }
}

export function pickTopOrCandidates(scored: BuildingCandidate[]) {
  if (scored.length === 0) return { kind: "none" as const }

  const best = scored[0]
  const second = scored[1]
  const gap = second ? best.score - second.score : Infinity

  const boundaryM = Math.sqrt(best.boundaryD2)
  const centroidM = Math.sqrt(best.centroidD2)
  const deepInside = best.containsFocus && boundaryM >= 8

  // Be strict: auto-pick only when we're very sure.
  // If the address point is not inside the footprint, prefer user disambiguation.
  const addrStrong = best.addrScore >= 2
  const addrClose = best.containsFocus || boundaryM < 35 || centroidM < 55
  const addrConfident = addrStrong && addrClose && gap > 250
  const geoConfident = deepInside && gap > 500

  const confident = addrConfident || geoConfident
  if (confident) return { kind: "single" as const, best }

  // Return a few candidates for user disambiguation.
  return { kind: "candidates" as const, candidates: scored.slice(0, 5) }
}

export function staticMapTransformFromMeta(meta: {
  lat: number
  lng: number
  zoom: number
  widthPx: number
  heightPx: number
  staticMap?: { w?: number; h?: number; scale?: number }
}) {
  const scale = meta.staticMap?.scale ?? 2
  const baseW = meta.staticMap?.w ?? meta.widthPx / scale
  const baseH = meta.staticMap?.h ?? meta.heightPx / scale
  return staticMapTransformFromCenter({
    lat: meta.lat,
    lng: meta.lng,
    zoom: meta.zoom,
    baseW,
    baseH,
    scale,
    widthPx: meta.widthPx,
    heightPx: meta.heightPx,
  })
}
