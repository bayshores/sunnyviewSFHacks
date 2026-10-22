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
const MEM_MAX_ENTRIES = 200

function memCache() {
  const g = globalThis as unknown as { __sunnyviewOverpassCache?: Map<string, CacheEntry> }
  if (!g.__sunnyviewOverpassCache) g.__sunnyviewOverpassCache = new Map()
  return g.__sunnyviewOverpassCache
}

function cacheSet(key: string, entry: CacheEntry) {
  const mem = memCache()
  mem.delete(key)
  mem.set(key, entry)
  while (mem.size > MEM_MAX_ENTRIES) {
    const oldest = mem.keys().next().value
    if (oldest === undefined) break
    mem.delete(oldest)
  }
}

// Public instances, most reliable first (see wiki.openstreetmap.org/wiki/Overpass_API).
// overpass.kumi.systems is now an alias of overpass.private.coffee; overpass.nchc.org.tw is gone.
const DEFAULT_OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]

// Overpass operators ban anonymous clients (406) and ask apps to identify themselves.
const OVERPASS_USER_AGENT = "sunnyviewSFHacks/1.0 (+https://github.com/bayshores/sunnyviewSFHacks)"

// Each query gets a bounded budget across endpoints; callers running several queries
// (locateBuildings) pass a shared `deadline` so the total stays inside the route's budget.
export const OVERPASS_ATTEMPT_TIMEOUT_MS = 6_000
export const OVERPASS_QUERY_BUDGET_MS = 9_000
// Attempts shorter than this are pointless for Overpass; stop instead of sending them.
const OVERPASS_MIN_ATTEMPT_MS = 1_000
// Operators ask clients to wait >= 30s after a 429/406 before retrying the same server.
export const OVERPASS_COOLDOWN_MS = 30_000
// Overloaded server (5xx or runtime-error remark): skip it briefly so the next query tries another.
export const OVERPASS_SHORT_COOLDOWN_MS = 5_000
const COOLDOWN_MAX_ENTRIES = 32

function cooldowns() {
  const g = globalThis as unknown as { __sunnyviewOverpassCooldown?: Map<string, number> }
  if (!g.__sunnyviewOverpassCooldown) g.__sunnyviewOverpassCooldown = new Map()
  return g.__sunnyviewOverpassCooldown
}

function markCooldown(endpoint: string, ms: number) {
  if (ms <= 0) return
  const map = cooldowns()
  map.delete(endpoint)
  map.set(endpoint, Date.now() + ms)
  while (map.size > COOLDOWN_MAX_ENTRIES) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

function isCoolingDown(endpoint: string) {
  const until = cooldowns().get(endpoint)
  return until !== undefined && until > Date.now()
}

function parseEndpointList(raw: string | undefined): string[] {
  if (!raw) return []
  const out: string[] = []
  for (const part of raw.split(",")) {
    const s = part.trim()
    if (!s) continue
    try {
      const u = new URL(s)
      if (u.protocol === "https:" || u.protocol === "http:") out.push(u.toString())
    } catch {
      // ignore invalid entries
    }
  }
  return out
}

/** OVERPASS_URL (comma-separated) entries first, then the public defaults, de-duplicated. */
function overpassEndpoints(): string[] {
  return Array.from(new Set([...parseEndpointList(process.env.OVERPASS_URL), ...DEFAULT_OVERPASS_ENDPOINTS]))
}

function shouldRetryStatus(status: number) {
  return status === 406 || status === 429 || status >= 500
}

/** 406/429: operator-requested backoff. 5xx: brief skip. Anything else: none. */
function cooldownForStatus(status: number) {
  if (status === 406 || status === 429) return OVERPASS_COOLDOWN_MS
  return status >= 500 ? OVERPASS_SHORT_COOLDOWN_MS : 0
}

type AttemptResult =
  | { ok: true; elements: OverpassElement[] }
  | { ok: false; error: Error; retry: boolean; cooldownMs: number }

async function attemptOverpass(endpoint: string, query: string, signal: AbortSignal): Promise<AttemptResult> {
  const res = await fetch(endpoint, {
    method: "POST",
    signal,
    headers: {
      accept: "application/json, */*;q=0.5",
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      "user-agent": OVERPASS_USER_AGENT,
    },
    body: new URLSearchParams({ data: query }).toString(),
    cache: "no-store",
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    const error = new Error(`Overpass failed (${res.status})${text ? `: ${text.slice(0, 120)}` : ""}`)
    return { ok: false, error, retry: shouldRetryStatus(res.status), cooldownMs: cooldownForStatus(res.status) }
  }
  const json = (await res.json().catch(() => null)) as { elements?: unknown; remark?: unknown } | null
  // Overpass reports server-side timeouts/out-of-memory as HTTP 200 with a runtime-error remark.
  if (typeof json?.remark === "string" && /runtime error/i.test(json.remark)) {
    const error = new Error(`Overpass runtime error: ${json.remark.slice(0, 120)}`)
    return { ok: false, error, retry: true, cooldownMs: OVERPASS_SHORT_COOLDOWN_MS }
  }
  const elements = Array.isArray(json?.elements) ? (json.elements as OverpassElement[]) : []
  return { ok: true, elements }
}

type OverpassQueryOpts = {
  signal?: AbortSignal
  /** Absolute time (ms since epoch) by which the query must finish; capped by OVERPASS_QUERY_BUDGET_MS. */
  deadline?: number
}

async function fetchOverpassQuery(opts: OverpassQueryOpts & { query: string }) {
  const key = `q:${opts.query}`
  const hit = memCache().get(key)
  if (hit && Date.now() - hit.t < MEM_TTL_MS) return hit.elements
  if (opts.signal?.aborted) throw new Error("Overpass request aborted")

  const deadline = Math.min(Date.now() + OVERPASS_QUERY_BUDGET_MS, opts.deadline ?? Infinity)
  let lastErr: Error | null = null

  for (const endpoint of overpassEndpoints()) {
    if (isCoolingDown(endpoint)) continue
    const remaining = deadline - Date.now()
    if (remaining < OVERPASS_MIN_ATTEMPT_MS) {
      lastErr ??= new Error("Overpass time budget exhausted")
      break
    }

    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), Math.min(OVERPASS_ATTEMPT_TIMEOUT_MS, remaining))
    const onAbort = () => ac.abort()
    opts.signal?.addEventListener("abort", onAbort, { once: true })

    let result: AttemptResult
    try {
      result = await attemptOverpass(endpoint, opts.query, ac.signal)
    } catch (e) {
      if (opts.signal?.aborted) throw new Error("Overpass request aborted")
      // Per-attempt timeout (possibly cut short by the budget) or network error: try the next
      // endpoint without a cooldown, so a slow burst cannot take every endpoint out of rotation.
      const error = e instanceof Error ? e : new Error("Overpass request failed")
      result = { ok: false, error, retry: true, cooldownMs: 0 }
    } finally {
      clearTimeout(t)
      opts.signal?.removeEventListener("abort", onAbort)
    }

    if (result.ok) {
      cacheSet(key, { t: Date.now(), elements: result.elements })
      return result.elements
    }
    // Bad query (non-retryable 4xx): another endpoint will not help.
    if (!result.retry) throw result.error
    lastErr = result.error
    markCooldown(endpoint, result.cooldownMs)
  }

  throw lastErr ?? new Error("Overpass unavailable: all endpoints are cooling down")
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
  deadline?: number
}): Promise<OverpassElement[]> {
  const q = `[out:json][timeout:10];nwr["building"](around:${Math.round(opts.radiusM)},${opts.lat},${opts.lng});out tags geom;`
  return await fetchOverpassQuery({ query: q, signal: opts.signal, deadline: opts.deadline })
}

export async function fetchOverpassByOsmId(opts: {
  osmType: "way" | "relation"
  osmId: number
  signal?: AbortSignal
  deadline?: number
}): Promise<OverpassElement[]> {
  const typ = opts.osmType
  const q = `[out:json][timeout:10];${typ}(${opts.osmId});out tags geom;`
  return await fetchOverpassQuery({ query: q, signal: opts.signal, deadline: opts.deadline })
}

export async function fetchOverpassByHouseNumber(opts: {
  lat: number
  lng: number
  radiusM: number
  houseNumber: string
  signal?: AbortSignal
  deadline?: number
}): Promise<OverpassElement[]> {
  const hn = opts.houseNumber.replace(/"/g, "")
  const q =
    `[out:json][timeout:10];nwr["building"]["addr:housenumber"="${hn}"]` +
    `(around:${Math.round(opts.radiusM)},${opts.lat},${opts.lng});out tags geom;`
  return await fetchOverpassQuery({ query: q, signal: opts.signal, deadline: opts.deadline })
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
