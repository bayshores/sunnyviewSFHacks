"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { PanelSpec, PlacedPanel, Point } from "@/components/PanelPacking"
import { RoofToolbar } from "@/components/roof-editor/RoofToolbar"
import { autoOutlineStatus, drawScene, syncCanvasBackingStore } from "@/components/roof-editor/draw"
import { useBackgroundImage } from "@/components/roof-editor/useBackgroundImage"
import { useCanvasView } from "@/components/roof-editor/useCanvasView"
import { usePolygonEditing } from "@/components/roof-editor/usePolygonEditing"
import { useRafInvalidate } from "@/components/roof-editor/useRafInvalidate"
import { DEFAULT_INTERNAL_SIZE, INITIAL_VIEW } from "@/components/roof-editor/view-transform"
import type { CanvasMetrics } from "@/components/roof-editor/draw"
import type {
  BackgroundSpec,
  CandidatePolygon,
  EditorMode,
  InternalSize,
  SegmentRoi,
  ViewState,
} from "@/components/roof-editor/types"

export type { BackgroundSpec, SegmentRoi } from "@/components/roof-editor/types"

export type RoofCanvasProps = {
  background: BackgroundSpec
  mPerPx: number | null
  orientationDeg: number
  panelSpec: PanelSpec
  vertices: Point[]
  closed: boolean
  panels: PlacedPanel[]
  mode?: EditorMode
  onVerticesChange?: (next: Point[]) => void
  onClosedChange?: (next: boolean) => void
  onAutoOutline?: (opts?: { roi?: SegmentRoi | null }) => void
  autoOutlineBusy?: boolean
  autoOutlineError?: string | null
  autoOutlineHint?: string | null
  candidatePolygons?: CandidatePolygon[] | null
  onPickCandidate?: (id: string) => void
  centerPin?: Point | null
  containerClassName?: string
}

const NOOP = () => {}
const DEFAULT_CONTAINER_CLASS = "h-[340px] sm:h-[440px] lg:h-[520px]"

export function RoofCanvas({
  background,
  mPerPx,
  orientationDeg,
  panelSpec,
  vertices,
  closed,
  panels,
  mode = "edit",
  onVerticesChange,
  onClosedChange,
  onAutoOutline,
  autoOutlineBusy = false,
  autoOutlineError = null,
  autoOutlineHint = null,
  candidatePolygons = null,
  onPickCandidate,
  centerPin = null,
  containerClassName,
}: RoofCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const drawRef = useRef<() => void>(NOOP)
  const viewRef = useRef<ViewState>(INITIAL_VIEW)
  const canvasMetricsRef = useRef<CanvasMetrics>({ width: 0, height: 0, dpr: 0 })
  const [showNearby, setShowNearby] = useState(false)

  const hasImage = background.kind === "image"
  const imageWidth = background.kind === "image" ? background.widthPx : null
  const imageHeight = background.kind === "image" ? background.heightPx : null
  const imageSrc = background.kind === "image" ? background.src : null

  const internalSize = useMemo<InternalSize>(() => {
    if (imageWidth !== null && imageHeight !== null) return { w: imageWidth, h: imageHeight }
    return DEFAULT_INTERNAL_SIZE
  }, [imageHeight, imageWidth])

  const invalidate = useRafInvalidate(drawRef, containerRef)
  const { image, error: imageError } = useBackgroundImage(imageSrc)
  const view = useCanvasView({ canvasRef, containerRef, viewRef, internalSize, invalidate })
  const editing = usePolygonEditing({
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
  })
  const { hoverIdx } = editing

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    const rect = container.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    canvasMetricsRef.current = syncCanvasBackingStore(canvas, rect.width, rect.height, dpr, canvasMetricsRef.current)

    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const isEdit = mode === "edit"
    drawScene(ctx, {
      width: rect.width,
      height: rect.height,
      dpr,
      size: internalSize,
      view: viewRef.current,
      hasImageBackground: hasImage,
      image: hasImage ? image : null,
      panels,
      vertices,
      closed,
      mode,
      hoverIdx,
      orientationDeg,
      centerPin,
      candidates: isEdit && showNearby ? candidatePolygons : null,
      panelWattW: panelSpec.wattW,
      mPerPx,
      status: isEdit && hasImage ? autoOutlineStatus(autoOutlineBusy, autoOutlineError, autoOutlineHint) : null,
    })
  }, [
    autoOutlineBusy,
    autoOutlineError,
    autoOutlineHint,
    candidatePolygons,
    centerPin,
    closed,
    hasImage,
    hoverIdx,
    image,
    internalSize,
    mPerPx,
    mode,
    orientationDeg,
    panelSpec.wattW,
    panels,
    showNearby,
    vertices,
  ])

  useEffect(() => {
    drawRef.current = draw
    invalidate()
  }, [draw, invalidate])

  const handleAutoOutline = useCallback(() => onAutoOutline?.(), [onAutoOutline])
  const handleClear = useCallback(() => {
    onVerticesChange?.([])
    onClosedChange?.(false)
  }, [onClosedChange, onVerticesChange])
  const { zoomBy, setView } = view

  return (
    <div className="space-y-2">
      {mode === "edit" && (
        <RoofToolbar
          hasImage={hasImage}
          showNearby={showNearby}
          onToggleNearby={() => setShowNearby((prev) => !prev)}
          onAutoOutline={onAutoOutline ? handleAutoOutline : undefined}
          autoOutlineBusy={autoOutlineBusy}
          onClear={handleClear}
          zoom={view.zoom}
          onZoomBy={(factor) => zoomBy(factor, null)}
          onResetView={() => setView(INITIAL_VIEW)}
        />
      )}

      <div
        ref={containerRef}
        className={`glass-surface relative w-full overflow-hidden rounded-xl ${containerClassName ?? DEFAULT_CONTAINER_CLASS}`}
      >
        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-full w-full touch-none"
          style={{ cursor: editing.cursor }}
          onPointerDown={editing.onPointerDown}
          onPointerMove={editing.onPointerMove}
          onPointerUp={editing.onPointerUp}
          onDoubleClick={editing.onDoubleClick}
          onContextMenu={(e) => e.preventDefault()}
        />
        {hasImage && imageError && (
          <div className="pointer-events-none absolute inset-x-3 top-3 rounded-md border border-rose-300/35 bg-rose-500/15 px-3 py-2 text-[11px] text-rose-100 backdrop-blur">
            {imageError}
          </div>
        )}
      </div>
    </div>
  )
}
