import { clamp, toFiniteNumber } from "@/lib/geo/math"
import { asRecord } from "@/lib/geo/narrow"
import { mercatorToPixel, mercatorUnproject, pixelToMercator, type StaticMapTransform } from "@/lib/geo/mercator"
import { parseAddressHints } from "@/lib/segment/address"
import { extractGeojsonRingNorm, roiFromPixelPoints, type PixelRoi } from "@/lib/segment/geometry"
import { looksLikeBuildingHit, nominatimReverse } from "@/lib/segment/nominatim"
import {
  fetchOverpassBuildings,
  fetchOverpassByHouseNumber,
  fetchOverpassByOsmId,
  normalizeCandidatePolygon,
  pickTopOrCandidates,
  rankBuildingCandidates,
  staticMapTransformFromMeta,
  type BuildingCandidate,
  type OverpassElement,
} from "@/lib/segment/osm-buildings"

export type SegmentClick = { x: number; y: number; type: "pos" | "neg" }
export type OsmCandidateJson = Record<string, unknown>
export const OSM_MULTIPLE_NOTE = "Multiple buildings found. Click Edit to choose."

/** Numeric/text map metadata sent by the client, each field null when absent or invalid. */
export type MetaValues = {
  lat: number | null
  lng: number | null
  zoom: number | null
  widthPx: number | null
  heightPx: number | null
  address: string | null
  staticMap: unknown
  staticScale: number | null
}

export type MapMeta = MetaValues & { lat: number; lng: number; zoom: number; widthPx: number; heightPx: number }

export function readMetaValues(meta: unknown): MetaValues {
  const m = asRecord(meta)
  return {
    lat: toFiniteNumber(m?.lat),
    lng: toFiniteNumber(m?.lng),
    zoom: toFiniteNumber(m?.zoom),
    widthPx: toFiniteNumber(m?.widthPx),
    heightPx: toFiniteNumber(m?.heightPx),
    address: typeof m?.address === "string" ? String(m.address) : null,
    staticMap: m?.staticMap,
    staticScale: toFiniteNumber(asRecord(m?.staticMap)?.scale),
  }
}

function optionalNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined
}

/** Client-provided static map size/scale; non-numeric fields are ignored. */
function readStaticMapOverride(v: unknown): { w?: number; h?: number; scale?: number } | undefined {
  const r = asRecord(v)
  if (!r) return undefined
  return { w: optionalNumber(r.w), h: optionalNumber(r.h), scale: optionalNumber(r.scale) }
}

export function hasMapMeta(v: MetaValues): v is MapMeta {
  return v.lat !== null && v.lng !== null && v.zoom !== null && v.widthPx !== null && v.heightPx !== null
}

export function serializeOsmCandidate(c: BuildingCandidate, tf: StaticMapTransform): OsmCandidateJson {
  return {
    id: c.id,
    polygon: normalizeCandidatePolygon(c, tf),
    score: c.score,
    contains: c.containsFocus,
    addrScore: c.addrScore,
    tags: {
      building: c.tags.building ?? null,
      housenumber: c.tags["addr:housenumber"] ?? null,
      street: c.tags["addr:street"] ?? null,
    },
  }
}

/** Merges OSM candidates into a service response without mutating it (service candidates win by id). */
export function mergeOsmCandidates(out: unknown, osmCandidates: OsmCandidateJson[] | null, osmNote: string | null): Record<string, unknown> {
  if (!osmCandidates || osmCandidates.length === 0) return out as Record<string, unknown>
  // Arrays cannot carry extra keys in JSON; keep them untouched like the legacy behaviour.
  if (Array.isArray(out)) return out as unknown as Record<string, unknown>
  const base: Record<string, unknown> = asRecord(out) ?? {}

  const existing: unknown[] = Array.isArray(base.candidates) ? base.candidates : []
  const merged = new Map<string, unknown>()
  for (const it of existing) {
    const rawId = asRecord(it)?.id
    const id = typeof rawId === "string" ? rawId : null
    if (id) merged.set(id, it)
  }
  for (const it of osmCandidates) {
    const id = typeof it.id === "string" ? it.id : null
    if (id && !merged.has(id)) merged.set(id, it)
  }
  return {
    ...base,
    candidates: Array.from(merged.values()),
    ...(!base.note && osmNote ? { note: osmNote } : {}),
  }
}

/** Extra fields attached to fallback responses when OSM candidates are available. */
export function osmCandidateExtras(osmCandidates: OsmCandidateJson[] | null, osmNote: string | null) {
  return osmCandidates && osmCandidates.length
    ? { candidates: osmCandidates, ...(osmNote ? { note: osmNote } : {}) }
    : {}
}

export type LocatedBuildings = {
  tf: StaticMapTransform
  focusPx: { x: number; y: number }
  scored: BuildingCandidate[]
  pick: ReturnType<typeof pickTopOrCandidates>
}

/**
 * OSM building lookup around the focus point: Nominatim reverse -> Overpass by id,
 * nearby buildings, and house-number tagged buildings, then ranking.
 * Individual upstream failures are ignored; only transform/ranking errors propagate.
 */
export async function locateBuildings(opts: {
  meta: MapMeta
  clicks: SegmentClick[] | undefined
  signal: AbortSignal
}): Promise<LocatedBuildings> {
  const { meta, signal } = opts
  const tf = staticMapTransformFromMeta({
    lat: meta.lat,
    lng: meta.lng,
    zoom: meta.zoom,
    widthPx: meta.widthPx,
    heightPx: meta.heightPx,
    staticMap: readStaticMapOverride(meta.staticMap),
  })

  const posClick = Array.isArray(opts.clicks) ? opts.clicks.find((c) => c.type === "pos") : null
  const focusPx = posClick ? { x: posClick.x, y: posClick.y } : { x: meta.widthPx / 2, y: meta.heightPx / 2 }
  const focus = mercatorUnproject(pixelToMercator(focusPx, tf))

  // 1) Try to resolve a likely building element via Nominatim reverse.
  let reverseElements: OverpassElement[] = []
  try {
    const rev = await nominatimReverse({ lat: focus.lat, lng: focus.lng, signal })
    if (looksLikeBuildingHit(rev) && (rev.osmType === "way" || rev.osmType === "relation") && rev.osmId) {
      reverseElements = await fetchOverpassByOsmId({ osmType: rev.osmType, osmId: rev.osmId, signal })
    }
  } catch {
    // ignore reverse failures
  }

  // 2) Always also fetch nearby buildings (reverse can be wrong in dense areas).
  let nearbyElements: OverpassElement[] = []
  try {
    nearbyElements = await fetchOverpassBuildings({ lat: focus.lat, lng: focus.lng, radiusM: 200, signal })
  } catch {
    // ignore
  }
  let elements = reverseElements.concat(nearbyElements)

  // 3) If we have an address number, also query addr-tagged buildings.
  const hints = parseAddressHints(meta.address)
  if (hints?.houseNumber) {
    try {
      const tagged = await fetchOverpassByHouseNumber({
        lat: focus.lat,
        lng: focus.lng,
        radiusM: 260,
        houseNumber: hints.houseNumber,
        signal,
      })
      if (tagged.length) elements = elements.concat(tagged)
    } catch {
      // ignore
    }
  }

  const scored = rankBuildingCandidates({ elements, tf, focusPx, address: meta.address })
  return { tf, focusPx, scored, pick: pickTopOrCandidates(scored) }
}

export type SegmentGuidance = {
  clicks: SegmentClick[] | undefined
  roi: PixelRoi | undefined
  meta: Record<string, unknown> | undefined
  osmCandidates: OsmCandidateJson[] | null
  osmNote: string | null
}

function ringCentroid(points: Array<{ x: number; y: number }>) {
  return {
    x: points.reduce((s, p) => s + p.x, 0) / points.length,
    y: points.reduce((s, p) => s + p.y, 0) / points.length,
  }
}

/**
 * Derives default prompts/ROI for the segmenter. A client supplied `osmFootprint` is treated as locked;
 * otherwise OSM is used to find the building matching the address. Never throws on OSM failures.
 */
export async function buildSegmentGuidance(opts: {
  clicks: SegmentClick[] | undefined
  roi: PixelRoi | undefined
  meta: Record<string, unknown> | undefined
  values: MetaValues
  signal: AbortSignal
}): Promise<SegmentGuidance> {
  const { values } = opts
  let clicks = opts.clicks
  let roi = opts.roi
  let meta = opts.meta
  let osmCandidates: OsmCandidateJson[] | null = null
  let osmNote: string | null = null

  const clientRing = extractGeojsonRingNorm(meta?.osmFootprint)
  const { widthPx: metaW, heightPx: metaH } = values

  // Derive default prompts/ROI from a client-provided footprint.
  if (clientRing && metaW !== null && metaH !== null) {
    const px = clientRing.map(([nx, ny]) => ({ x: nx * metaW, y: ny * metaH }))
    if (!clicks || clicks.length === 0) {
      const c = ringCentroid(clientRing.map(([nx, ny]) => ({ x: nx, y: ny })))
      clicks = [{ x: c.x * metaW, y: c.y * metaH, type: "pos" as const }]
    }
    if (!roi) roi = roiFromPixelPoints(px, metaW, metaH)
  }

  // Without a locked footprint, attempt address-matched OSM guidance.
  if (!clientRing && hasMapMeta(values)) {
    try {
      const { tf, scored, pick } = await locateBuildings({ meta: values, clicks: opts.clicks, signal: opts.signal })

      // Always compute a few candidate footprints for disambiguation.
      osmCandidates = scored.slice(0, 5).map((c) => serializeOsmCandidate(c, tf))
      if (pick.kind === "candidates") osmNote = OSM_MULTIPLE_NOTE

      // Only lock the footprint when the best candidate actually contains the focus point.
      // In dense areas, addr-tags can be wrong; locking the wrong footprint prevents CV from recovering.
      if (pick.kind === "single" && pick.best.containsFocus) {
        const best = pick.best
        const footprint = normalizeCandidatePolygon(best, tf)

        if (!clicks || clicks.length === 0) {
          const cp = mercatorToPixel(ringCentroid(best.ringMerc), tf)
          clicks = [{ x: cp.x, y: cp.y, type: "pos" as const }]
        }

        if (!roi) {
          roi = roiFromPixelPoints(best.ringMerc.map((p) => mercatorToPixel(p, tf)), values.widthPx, values.heightPx)
        }

        if (meta && typeof meta === "object") {
          meta = {
            ...meta,
            osmBestId: best.id,
            osmSource: "guided",
            // Normalized GeoJSON polygon for the building footprint we believe matches the address.
            // CV services can use this to keep only the roof attached to the requested address.
            osmFootprint: footprint,
          }
        }
      }
    } catch {
      // ignore guidance failures
    }
  }

  // Default ROI: focus segmentation around the interaction point.
  // This helps in dense scenes where a center click might land on a courtyard/pool.
  if (!roi && metaW !== null && metaH !== null) {
    const posClick = Array.isArray(clicks) ? clicks.find((c) => c.type === "pos") : null
    const fx = posClick ? posClick.x : metaW / 2
    const fy = posClick ? posClick.y : metaH / 2
    const size = Math.round(Math.min(metaW, metaH) * 0.72)
    const x = clamp(Math.floor(fx - size / 2), 0, metaW)
    const y = clamp(Math.floor(fy - size / 2), 0, metaH)
    roi = { x, y, w: clamp(size, 1, metaW - x), h: clamp(size, 1, metaH - y) }
  }

  // Ensure we always have a default click for SAM-like services.
  if (!roi && (!clicks || clicks.length === 0) && metaW !== null && metaH !== null) {
    clicks = [{ x: metaW / 2, y: metaH / 2, type: "pos" as const }]
  }

  return { clicks, roi, meta, osmCandidates, osmNote }
}
