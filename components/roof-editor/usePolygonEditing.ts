"use client"

import { useCallback, useMemo, useRef, useState } from "react"
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, RefObject } from "react"
import type { Point } from "@/components/PanelPacking"
import { edgeResizeCursor, moveEdgeAlongNormal, removeVertex, replaceVertex, translatePolygonClamped } from "./geometry"
import {
  exceedsMoveThreshold,
  nextClickStreak,
  resolveDoubleClick,
  resolveHover,
  resolvePointerDown,
} from "./interactions"
import type { ClickStreak } from "./interactions"
import type { CanvasView } from "./useCanvasView"
import { fitTransform, panFromDrag } from "./view-transform"
import type { CandidatePolygon, EditorMode, InternalSize, ViewState } from "./types"

type PanDrag = { pointerId: number; startClientX: number; startClientY: number; startPanX: number; startPanY: number }
type PolyDrag = { pointerId: number; start: Point; startVertices: Point[] }
type EdgeDrag = { pointerId: number; edgeIdx: number; start: Point; startVertices: Point[]; normal: Point }

type UsePolygonEditingParams = {
  canvasRef: RefObject<HTMLCanvasElement | null>
  containerRef: RefObject<HTMLDivElement | null>
  viewRef: RefObject<ViewState>
  view: Pick<CanvasView, "setView" | "clientToInternal">
  internalSize: InternalSize
  mode: EditorMode
  vertices: Point[]
  closed: boolean
  showNearby: boolean
  candidatePolygons: CandidatePolygon[] | null
  onVerticesChange?: (next: Point[]) => void
  onClosedChange?: (next: boolean) => void
  onPickCandidate?: (id: string) => void
}

type CanvasPointerEvent = ReactPointerEvent<HTMLCanvasElement>

export type PolygonEditing = {
  hoverIdx: number | null
  cursor: string
  onPointerDown: (e: CanvasPointerEvent) => void
  onPointerMove: (e: CanvasPointerEvent) => void
  onPointerUp: (e: CanvasPointerEvent) => void
  onDoubleClick: (e: ReactMouseEvent<HTMLCanvasElement>) => void
}

function copyVertices(vertices: readonly Point[]): Point[] {
  return vertices.map((v) => ({ x: v.x, y: v.y }))
}

export function usePolygonEditing({
  canvasRef,
  containerRef,
  viewRef,
  view,
  internalSize,
  mode,
  vertices,
  closed,
  showNearby,
  candidatePolygons,
  onVerticesChange,
  onClosedChange,
  onPickCandidate,
}: UsePolygonEditingParams): PolygonEditing {
  const { setView, clientToInternal } = view

  const panDragRef = useRef<PanDrag | null>(null)
  const polyDragRef = useRef<PolyDrag | null>(null)
  const edgeDragRef = useRef<EdgeDrag | null>(null)
  const candidateDownRef = useRef<string | null>(null)
  const downVertexIdxRef = useRef<number | null>(null)
  const downPosRef = useRef<Point | null>(null)
  const movedRef = useRef(false)
  const clickStreakRef = useRef<ClickStreak | null>(null)

  const [draggingIdx, setDraggingIdx] = useState<number | null>(null)
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const [hoverEdgeIdx, setHoverEdgeIdx] = useState<number | null>(null)
  const [dragEdgeIdx, setDragEdgeIdx] = useState<number | null>(null)

  const canPickCandidate = showNearby && Boolean(onPickCandidate)

  const cursor = useMemo(() => {
    if (mode !== "edit") return "default"
    const idx = dragEdgeIdx ?? hoverEdgeIdx
    if (idx === null || vertices.length < 2) return "crosshair"
    const a = vertices[idx]
    const b = vertices[(idx + 1) % vertices.length]
    return a && b ? edgeResizeCursor(a, b) : "crosshair"
  }, [dragEdgeIdx, hoverEdgeIdx, mode, vertices])

  const startPan = useCallback(
    (e: CanvasPointerEvent) => {
      const { panX, panY } = viewRef.current
      panDragRef.current = {
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startPanX: panX,
        startPanY: panY,
      }
    },
    [viewRef]
  )

  const onPointerDown = useCallback(
    (e: CanvasPointerEvent) => {
      const canvas = canvasRef.current
      if (!canvas || !containerRef.current) return
      canvas.setPointerCapture(e.pointerId)

      if (mode !== "edit") {
        startPan(e)
        return
      }

      const internal = clientToInternal(e.clientX, e.clientY)
      if (!internal) return
      const point = { x: internal.x, y: internal.y }

      movedRef.current = false
      downPosRef.current = point
      downVertexIdxRef.current = null
      candidateDownRef.current = null
      edgeDragRef.current = null
      setDragEdgeIdx(null)

      const target = resolvePointerDown({
        point,
        scale: internal.scale,
        vertices,
        closed,
        candidates: candidatePolygons,
        canPickCandidate,
      })

      switch (target.kind) {
        case "vertex":
          downVertexIdxRef.current = target.idx
          setDraggingIdx(target.idx)
          setHoverEdgeIdx(null)
          return
        case "edge":
          // Drag an edge (line) to expand/shrink the mask on that side.
          edgeDragRef.current = {
            pointerId: e.pointerId,
            edgeIdx: target.idx,
            start: point,
            startVertices: copyVertices(vertices),
            normal: target.normal,
          }
          setDragEdgeIdx(target.idx)
          setHoverEdgeIdx(target.idx)
          return
        case "candidate":
          candidateDownRef.current = target.id
          return
        case "polygon":
          polyDragRef.current = { pointerId: e.pointerId, start: point, startVertices: copyVertices(vertices) }
          return
        case "pan":
          // Default interaction: drag to pan the view (mask does not change).
          startPan(e)
      }
    },
    [canPickCandidate, candidatePolygons, canvasRef, clientToInternal, closed, containerRef, mode, startPan, vertices]
  )

  const onPointerMove = useCallback(
    (e: CanvasPointerEvent) => {
      const container = containerRef.current
      if (!container) return

      const panDrag = panDragRef.current
      if (panDrag && panDrag.pointerId === e.pointerId) {
        const rect = container.getBoundingClientRect()
        const baseScale = fitTransform(rect.width, rect.height, internalSize).scale
        const dx = e.clientX - panDrag.startClientX
        const dy = e.clientY - panDrag.startClientY
        if (!movedRef.current && exceedsMoveThreshold(dx, dy)) movedRef.current = true
        setView(
          panFromDrag({ panX: panDrag.startPanX, panY: panDrag.startPanY }, dx, dy, baseScale, viewRef.current.zoom)
        )
        return
      }

      const internal = clientToInternal(e.clientX, e.clientY)
      if (!internal) return

      const polyDrag = polyDragRef.current
      if (polyDrag && polyDrag.pointerId === e.pointerId) {
        const dx = internal.x - polyDrag.start.x
        const dy = internal.y - polyDrag.start.y
        if (!movedRef.current && exceedsMoveThreshold(dx, dy)) movedRef.current = true
        onVerticesChange?.(translatePolygonClamped(polyDrag.startVertices, dx, dy, internalSize))
        return
      }

      const edgeDrag = edgeDragRef.current
      if (edgeDrag && edgeDrag.pointerId === e.pointerId) {
        const dx = internal.x - edgeDrag.start.x
        const dy = internal.y - edgeDrag.start.y
        if (!movedRef.current && exceedsMoveThreshold(dx, dy)) movedRef.current = true
        const { edgeIdx, startVertices, normal } = edgeDrag
        const rawDelta = dx * normal.x + dy * normal.y
        onVerticesChange?.(moveEdgeAlongNormal(startVertices, edgeIdx, normal, rawDelta, internalSize))
        return
      }

      const downPos = downPosRef.current
      if (!movedRef.current && downPos && exceedsMoveThreshold(internal.x - downPos.x, internal.y - downPos.y)) {
        movedRef.current = true
      }

      const point = { x: internal.x, y: internal.y }
      const hover = resolveHover({ point, scale: internal.scale, vertices, closed, mode, draggingIdx })
      setHoverIdx(hover.vertex)
      setHoverEdgeIdx(hover.edge)

      if (mode !== "edit" || draggingIdx === null) return
      onVerticesChange?.(replaceVertex(vertices, draggingIdx, point))
    },
    [clientToInternal, closed, containerRef, draggingIdx, internalSize, mode, onVerticesChange, setView, vertices, viewRef]
  )

  const onPointerUp = useCallback(
    (e: CanvasPointerEvent) => {
      canvasRef.current?.releasePointerCapture(e.pointerId)

      if (panDragRef.current?.pointerId === e.pointerId) panDragRef.current = null
      if (polyDragRef.current?.pointerId === e.pointerId) polyDragRef.current = null
      if (edgeDragRef.current?.pointerId === e.pointerId) edgeDragRef.current = null

      setDraggingIdx(null)
      setDragEdgeIdx(null)

      const pickId = candidateDownRef.current
      if (showNearby && mode === "edit" && pickId && !movedRef.current && onPickCandidate) {
        onPickCandidate(pickId)
      }
      candidateDownRef.current = null

      // Triple-click a vertex to delete it.
      const idx = downVertexIdxRef.current
      if (mode === "edit" && closed && idx !== null && !movedRef.current) {
        const streak = nextClickStreak(clickStreakRef.current, idx, Date.now())
        clickStreakRef.current = streak.count >= 3 ? null : streak
        if (streak.count >= 3) {
          const next = removeVertex(vertices, idx)
          onVerticesChange?.(next)
          if (next.length < 3) onClosedChange?.(false)
        }
      }

      downVertexIdxRef.current = null
      downPosRef.current = null
      movedRef.current = false
    },
    [canvasRef, closed, mode, onClosedChange, onPickCandidate, onVerticesChange, showNearby, vertices]
  )

  const onDoubleClick = useCallback(
    (e: ReactMouseEvent<HTMLCanvasElement>) => {
      if (mode !== "edit") return
      const internal = clientToInternal(e.clientX, e.clientY)
      if (!internal) return

      const action = resolveDoubleClick({
        point: { x: internal.x, y: internal.y },
        scale: internal.scale,
        vertices,
        closed,
        candidates: candidatePolygons,
        canPickCandidate,
      })

      if (action.kind === "close") onClosedChange?.(true)
      else if (action.kind === "pick") onPickCandidate?.(action.id)
      else if (action.kind === "set-vertices") onVerticesChange?.(action.vertices)
    },
    [canPickCandidate, candidatePolygons, clientToInternal, closed, mode, onClosedChange, onPickCandidate, onVerticesChange, vertices]
  )

  return { hoverIdx, cursor, onPointerDown, onPointerMove, onPointerUp, onDoubleClick }
}
