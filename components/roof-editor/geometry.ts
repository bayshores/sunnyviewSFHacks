import type { Point } from "@/components/PanelPacking"
import type { InternalSize } from "./types"

export type SegmentHit = { x: number; y: number; t: number; d: number }
export type EdgeHit = { idx: number; d: number }
export type BBox = { minX: number; minY: number; maxX: number; maxY: number }

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

export function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** Closest point on segment `ab` to `p`, with its parameter `t` in [0, 1] and distance `d`. */
export function distPointToSegment(p: Point, a: Point, b: Point): SegmentHit {
  const vx = b.x - a.x
  const vy = b.y - a.y
  const wx = p.x - a.x
  const wy = p.y - a.y
  const vv = vx * vx + vy * vy
  const t = vv > 1e-9 ? (wx * vx + wy * vy) / vv : 0
  const tt = Math.max(0, Math.min(1, t))
  const x = a.x + tt * vx
  const y = a.y + tt * vy
  return { x, y, t: tt, d: Math.hypot(p.x - x, p.y - y) }
}

/** Index of the closest vertex within `radius` of `p`, or null. */
export function nearestVertexIdx(p: Point, vertices: readonly Point[], radius: number): number | null {
  let bestIdx: number | null = null
  let best = Infinity
  for (let i = 0; i < vertices.length; i++) {
    const d = dist(p, vertices[i])
    if (d <= radius && d < best) {
      best = d
      bestIdx = i
    }
  }
  return bestIdx
}

/**
 * Closest edge of the closed ring `vertices` to `p` (edge i joins vertex i and i + 1, wrapping).
 * Returns null when there are fewer than two vertices.
 */
export function nearestEdge(p: Point, vertices: readonly Point[]): EdgeHit | null {
  const n = vertices.length
  if (n < 2) return null
  let bestIdx = 0
  let bestD = Infinity
  for (let i = 0; i < n; i++) {
    const hit = distPointToSegment(p, vertices[i], vertices[(i + 1) % n])
    if (hit.d < bestD) {
      bestD = hit.d
      bestIdx = i
    }
  }
  return { idx: bestIdx, d: bestD }
}

/** Index of the closest edge within `radius` of `p`, or null. */
export function nearestEdgeWithin(p: Point, vertices: readonly Point[], radius: number): number | null {
  const hit = nearestEdge(p, vertices)
  return hit && hit.d <= radius ? hit.idx : null
}

export function pointInPolygon(p: Point, polygon: readonly Point[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x
    const yi = polygon[i].y
    const xj = polygon[j].x
    const yj = polygon[j].y
    const intersects = yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi
    if (intersects) inside = !inside
  }
  return inside
}

export function bboxOf(points: readonly Point[]): BBox {
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
  return { minX, minY, maxX, maxY }
}

/** Twice the signed shoelace area (positive when the interior is left of each edge in y-down space). */
export function signedArea2(vertices: readonly Point[]): number {
  let signed = 0
  for (let i = 0; i < vertices.length; i++) {
    const p = vertices[i]
    const q = vertices[(i + 1) % vertices.length]
    signed += p.x * q.y - q.x * p.y
  }
  return signed
}

/** Unit normal of edge `edgeIdx` pointing away from the polygon interior, or null for a degenerate edge. */
export function edgeOutwardNormal(vertices: readonly Point[], edgeIdx: number): Point | null {
  const n = vertices.length
  if (n < 2) return null
  const a = vertices[edgeIdx]
  const b = vertices[(edgeIdx + 1) % n]
  if (!a || !b) return null
  const ex = b.x - a.x
  const ey = b.y - a.y
  const len = Math.hypot(ex, ey)
  if (len <= 1e-6) return null
  const interiorIsLeft = signedArea2(vertices) > 0
  return interiorIsLeft ? { x: ey / len, y: -ex / len } : { x: -ey / len, y: ex / len }
}

type DeltaRange = { lo: number; hi: number }

const EMPTY_RANGE: DeltaRange = { lo: 1, hi: 0 }

function deltaRangeForPoint(p: Point, normal: Point, bounds: InternalSize): DeltaRange {
  let lo = -Infinity
  let hi = Infinity

  if (Math.abs(normal.x) > 1e-9) {
    const t1 = (0 - p.x) / normal.x
    const t2 = (bounds.w - p.x) / normal.x
    lo = Math.max(lo, Math.min(t1, t2))
    hi = Math.min(hi, Math.max(t1, t2))
  } else if (p.x < 0 || p.x > bounds.w) {
    return EMPTY_RANGE
  }

  if (Math.abs(normal.y) > 1e-9) {
    const t1 = (0 - p.y) / normal.y
    const t2 = (bounds.h - p.y) / normal.y
    lo = Math.max(lo, Math.min(t1, t2))
    hi = Math.min(hi, Math.max(t1, t2))
  } else if (p.y < 0 || p.y > bounds.h) {
    return EMPTY_RANGE
  }

  return { lo, hi }
}

/**
 * Clamp a displacement along `normal` so both edge endpoints stay inside [0, w] x [0, h].
 * If no displacement can satisfy both, `delta` is returned unchanged.
 */
export function clampEdgeDelta(delta: number, a: Point, b: Point, normal: Point, bounds: InternalSize): number {
  const ra = deltaRangeForPoint(a, normal, bounds)
  const rb = deltaRangeForPoint(b, normal, bounds)
  const lo = Math.max(ra.lo, rb.lo)
  const hi = Math.min(ra.hi, rb.hi)
  return lo <= hi ? clamp(delta, lo, hi) : delta
}

/** Move edge `edgeIdx` along `normal` by `rawDelta` (clamped to bounds); returns a new vertex array. */
export function moveEdgeAlongNormal(
  vertices: readonly Point[],
  edgeIdx: number,
  normal: Point,
  rawDelta: number,
  bounds: InternalSize
): Point[] {
  const n = vertices.length
  const j = (edgeIdx + 1) % n
  const a0 = vertices[edgeIdx]
  const b0 = vertices[j]
  const delta = clampEdgeDelta(rawDelta, a0, b0, normal, bounds)
  return vertices.map((v, i) => {
    if (i === edgeIdx || i === j) return { x: v.x + normal.x * delta, y: v.y + normal.y * delta }
    return { x: v.x, y: v.y }
  })
}

/** Translate all vertices by (dx, dy), clamped so the polygon's bbox stays inside bounds. */
export function translatePolygonClamped(
  vertices: readonly Point[],
  dxRaw: number,
  dyRaw: number,
  bounds: InternalSize
): Point[] {
  const bb = bboxOf(vertices)
  const dx = clamp(dxRaw, -bb.minX, bounds.w - bb.maxX)
  const dy = clamp(dyRaw, -bb.minY, bounds.h - bb.maxY)
  return vertices.map((v) => ({ x: v.x + dx, y: v.y + dy }))
}

/**
 * Insert `p` into the nearest edge of the closed ring. Inserting into the closing edge
 * (last -> first) appends at the end so vertex ordering stays stable.
 */
export function insertVertexOnNearestEdge(vertices: readonly Point[], p: Point): Point[] {
  const hit = nearestEdge(p, vertices)
  if (!hit) return [...vertices, { x: p.x, y: p.y }]
  const insertAt = hit.idx + 1
  return [...vertices.slice(0, insertAt), { x: p.x, y: p.y }, ...vertices.slice(insertAt)]
}

export function replaceVertex(vertices: readonly Point[], idx: number, p: Point): Point[] {
  return vertices.map((v, i) => (i === idx ? { x: p.x, y: p.y } : v))
}

export function removeVertex(vertices: readonly Point[], idx: number): Point[] {
  return vertices.filter((_, i) => i !== idx)
}

export type ResizeCursor = "ns-resize" | "ew-resize" | "nwse-resize" | "nesw-resize"

/** CSS cursor for dragging edge `ab` along its normal. */
export function edgeResizeCursor(a: Point, b: Point): ResizeCursor {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const adx = Math.abs(dx)
  const ady = Math.abs(dy)
  if (adx > ady * 1.4) return "ns-resize"
  if (ady > adx * 1.4) return "ew-resize"
  const nx = dy
  const ny = -dx
  return nx * ny >= 0 ? "nwse-resize" : "nesw-resize"
}
