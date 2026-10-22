import { clamp, toFiniteNumber } from "@/lib/geo/math"
import { mercatorResolutionMetersPerPx } from "@/lib/geo/mercator"

export type NormPolygon = { type: "Polygon"; coordinates: number[][][] }
export type PixelRoi = { x: number; y: number; w: number; h: number }

/** Small centred square used when there is no map metadata at all. */
export const TINY_FALLBACK_POLYGON: NormPolygon = {
  type: "Polygon",
  coordinates: [[[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6]]],
}

/** Extracts the outer ring (normalized coords, closing point dropped) from a GeoJSON-ish polygon. */
export function extractGeojsonRingNorm(poly: unknown): Array<[number, number]> | null {
  if (!poly || typeof poly !== "object") return null

  const obj = poly as Record<string, unknown>
  if (obj?.type === "Feature" && obj?.geometry) return extractGeojsonRingNorm(obj.geometry)

  const typ = typeof obj?.type === "string" ? String(obj.type) : null
  const coords = obj?.coordinates
  if (!Array.isArray(coords)) return null

  let ring: unknown[] | null = null
  if (typ === "Polygon" && Array.isArray(coords[0])) ring = coords[0] as unknown[]
  else if (typ === "MultiPolygon" && Array.isArray(coords[0]) && Array.isArray((coords[0] as unknown[])[0])) {
    ring = (coords[0] as unknown[])[0] as unknown[]
  } else if (!typ && coords.length >= 3 && Array.isArray(coords[0])) {
    // tolerate {coordinates:[[x,y],...]} without type
    ring = coords as unknown[]
  }
  if (!ring) return null

  const pts: Array<[number, number]> = []
  for (const item of ring) {
    if (!Array.isArray(item) || item.length < 2) return null
    const x = toFiniteNumber(item[0])
    const y = toFiniteNumber(item[1])
    if (x === null || y === null) return null
    pts.push([x, y])
  }

  if (pts.length >= 2) {
    const a = pts[0]
    const b = pts[pts.length - 1]
    if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) pts.pop()
  }

  return pts.length >= 3 ? pts : null
}

/**
 * A conservative residential roof rectangle (about 14m x 9m) centred in the image, in normalized coords.
 * Only used when neither CV nor OSM footprints are available.
 */
export function fallbackRectRoofPolygon(params: {
  widthPx: number
  heightPx: number
  zoom: number
  scale?: number | null
}): NormPolygon {
  const resMPerPx = mercatorResolutionMetersPerPx(params.zoom)
  const s = typeof params.scale === "number" && Number.isFinite(params.scale) ? Math.max(1, Math.min(2, Math.round(params.scale))) : 2
  const mPerPxOut = resMPerPx / s
  const roofWm = 14
  const roofHm = 9
  const wPx = Math.min(params.widthPx * 0.45, Math.max(30, roofWm / mPerPxOut))
  const hPx = Math.min(params.heightPx * 0.45, Math.max(30, roofHm / mPerPxOut))
  const cx = params.widthPx / 2
  const cy = params.heightPx / 2
  const x0 = clamp(cx - wPx / 2, 0, params.widthPx)
  const x1 = clamp(cx + wPx / 2, 0, params.widthPx)
  const y0 = clamp(cy - hPx / 2, 0, params.heightPx)
  const y1 = clamp(cy + hPx / 2, 0, params.heightPx)
  const toN = (x: number, y: number) => [x / params.widthPx, y / params.heightPx]
  return {
    type: "Polygon",
    coordinates: [[toN(x0, y0), toN(x1, y0), toN(x1, y1), toN(x0, y1)]],
  }
}

/** Bounding ROI (pixel space) of the points, padded and clamped to the image. */
export function roiFromPixelPoints(points: Array<{ x: number; y: number }>, widthPx: number, heightPx: number, pad = 24): PixelRoi {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  const x = clamp(Math.floor(minX - pad), 0, widthPx)
  const y = clamp(Math.floor(minY - pad), 0, heightPx)
  const w = clamp(Math.ceil(maxX - minX + pad * 2), 1, widthPx - x)
  const h = clamp(Math.ceil(maxY - minY + pad * 2), 1, heightPx - y)
  return { x, y, w, h }
}
