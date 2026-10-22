import type { Point } from "@/components/PanelPacking"
import {
  edgeOutwardNormal,
  insertVertexOnNearestEdge,
  nearestEdge,
  nearestEdgeWithin,
  nearestVertexIdx,
  pointInPolygon,
} from "./geometry"
import type { CandidatePolygon, EditorMode } from "./types"

/** Hit radii in screen (CSS) px; divide by the effective scale to get internal units. */
export const VERTEX_HIT_PX = 12
export const VERTEX_DOUBLE_CLICK_HIT_PX = 14
export const EDGE_HIT_PX = 10
/** Squared movement (px²) beyond which a press counts as a drag rather than a click. */
export const MOVE_THRESHOLD_SQ = 9
export const TRIPLE_CLICK_WINDOW_MS = 900

export type PointerDownTarget =
  | { kind: "vertex"; idx: number }
  | { kind: "edge"; idx: number; normal: Point }
  | { kind: "candidate"; id: string }
  | { kind: "polygon" }
  | { kind: "pan" }

export type PointerDownInput = {
  point: Point
  scale: number
  vertices: readonly Point[]
  closed: boolean
  candidates: readonly CandidatePolygon[] | null
  /** True when nearby outlines are shown and a pick handler exists. */
  canPickCandidate: boolean
}

function candidateAt(p: Point, candidates: readonly CandidatePolygon[] | null): string | null {
  if (!candidates) return null
  for (const c of candidates) {
    if (pointInPolygon(p, c.polygon)) return c.id
  }
  return null
}

/** Decide what an edit-mode pointer press grabs, in priority order. */
export function resolvePointerDown(input: PointerDownInput): PointerDownTarget {
  const { point, scale, vertices, closed, candidates, canPickCandidate } = input

  const idx = vertices.length > 0 ? nearestVertexIdx(point, vertices, VERTEX_HIT_PX / scale) : null
  if (idx !== null) return { kind: "vertex", idx }

  const isClosedRing = closed && vertices.length >= 3
  if (isClosedRing) {
    const edge = nearestEdge(point, vertices)
    if (edge && edge.d <= EDGE_HIT_PX / scale) {
      const normal = edgeOutwardNormal(vertices, edge.idx)
      if (normal) return { kind: "edge", idx: edge.idx, normal }
    }
  }

  if (canPickCandidate) {
    const id = candidateAt(point, candidates)
    if (id !== null) return { kind: "candidate", id }
  }

  if (isClosedRing && pointInPolygon(point, vertices)) return { kind: "polygon" }

  return { kind: "pan" }
}

export type HoverInput = {
  point: Point
  scale: number
  vertices: readonly Point[]
  closed: boolean
  mode: EditorMode
  draggingIdx: number | null
}

export type HoverResult = { vertex: number | null; edge: number | null }

export function resolveHover(input: HoverInput): HoverResult {
  const { point, scale, vertices, closed, mode, draggingIdx } = input
  const vertex =
    mode === "edit" && vertices.length > 0 ? nearestVertexIdx(point, vertices, VERTEX_HIT_PX / scale) : null

  const edgeHoverable = mode === "edit" && closed && vertices.length >= 3 && draggingIdx === null
  const edge = edgeHoverable && vertex === null ? nearestEdgeWithin(point, vertices, EDGE_HIT_PX / scale) : null
  return { vertex, edge }
}

export type DoubleClickAction =
  | { kind: "none" }
  | { kind: "close" }
  | { kind: "pick"; id: string }
  | { kind: "set-vertices"; vertices: Point[] }

export type DoubleClickInput = PointerDownInput

/**
 * Double-click adds a point (open ring), inserts on the nearest edge (closed ring),
 * closes the ring when hitting the first vertex, or picks a nearby candidate outline.
 */
export function resolveDoubleClick(input: DoubleClickInput): DoubleClickAction {
  const { point, scale, vertices, closed, candidates, canPickCandidate } = input
  const p = { x: point.x, y: point.y }

  const hitVertex = vertices.length > 0 ? nearestVertexIdx(p, vertices, VERTEX_DOUBLE_CLICK_HIT_PX / scale) : null
  if (hitVertex !== null) {
    // Other vertex hits are ignored: vertex clicks drive triple-click delete.
    return !closed && hitVertex === 0 && vertices.length >= 3 ? { kind: "close" } : { kind: "none" }
  }

  if (canPickCandidate) {
    const id = candidateAt(p, candidates)
    if (id !== null) return { kind: "pick", id }
  }

  if (closed && vertices.length >= 2) {
    return { kind: "set-vertices", vertices: insertVertexOnNearestEdge(vertices, p) }
  }

  return { kind: "set-vertices", vertices: [...vertices, p] }
}

export type ClickStreak = { idx: number; count: number; t: number }

/** Track consecutive clicks on the same vertex within the triple-click window. */
export function nextClickStreak(prev: ClickStreak | null, idx: number, now: number): ClickStreak {
  const count = prev && prev.idx === idx && now - prev.t < TRIPLE_CLICK_WINDOW_MS ? prev.count + 1 : 1
  return { idx, count, t: now }
}

export function exceedsMoveThreshold(dx: number, dy: number): boolean {
  return dx * dx + dy * dy > MOVE_THRESHOLD_SQ
}
