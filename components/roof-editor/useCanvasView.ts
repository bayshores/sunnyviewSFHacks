"use client"

import { useCallback, useEffect, useState } from "react"
import type { RefObject } from "react"
import type { Point } from "@/components/PanelPacking"
import { clamp } from "./geometry"
import type { InternalSize, ViewState } from "./types"
import {
  INITIAL_VIEW,
  MAX_ZOOM,
  MIN_ZOOM,
  clampViewToBounds,
  toInternal,
  wheelZoomFactor,
  zoomAboutFocus,
} from "./view-transform"
import type { InternalHit } from "./view-transform"

type UseCanvasViewParams = {
  canvasRef: RefObject<HTMLCanvasElement | null>
  containerRef: RefObject<HTMLDivElement | null>
  /** Live view state; kept in a ref so pans/zooms redraw without re-rendering. */
  viewRef: RefObject<ViewState>
  internalSize: InternalSize
  invalidate: () => void
}

export type CanvasView = {
  /** Zoom level for UI display (state mirror of viewRef). */
  zoom: number
  setView: (next: ViewState) => void
  zoomBy: (factor: number, focus: Point | null) => void
  /** Map client coords to internal coords, or null when the container is not mounted. */
  clientToInternal: (clientX: number, clientY: number) => InternalHit | null
}

export function useCanvasView({
  canvasRef,
  containerRef,
  viewRef,
  internalSize,
  invalidate,
}: UseCanvasViewParams): CanvasView {
  const [zoom, setZoom] = useState(INITIAL_VIEW.zoom)

  const setView = useCallback(
    (next: ViewState) => {
      const zoomed = { zoom: clamp(next.zoom, MIN_ZOOM, MAX_ZOOM), panX: next.panX, panY: next.panY }
      const container = containerRef.current
      let clamped = zoomed
      if (container) {
        const rect = container.getBoundingClientRect()
        clamped = clampViewToBounds(zoomed, rect.width, rect.height, internalSize)
      }
      viewRef.current = clamped
      setZoom(clamped.zoom)
      invalidate()
    },
    [containerRef, internalSize, invalidate, viewRef]
  )

  const zoomBy = useCallback(
    (factor: number, focus: Point | null) => {
      const next = zoomAboutFocus(viewRef.current, factor, focus, internalSize)
      if (next) setView(next)
    },
    [internalSize, setView, viewRef]
  )

  const clientToInternal = useCallback(
    (clientX: number, clientY: number): InternalHit | null => {
      const container = containerRef.current
      if (!container) return null
      const rect = container.getBoundingClientRect()
      return toInternal(clientX - rect.left, clientY - rect.top, rect.width, rect.height, internalSize, viewRef.current)
    },
    [containerRef, internalSize, viewRef]
  )

  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    // React may attach wheel listeners as passive; use a native non-passive capture
    // listener so we can prevent parent scrolling.
    const opts: AddEventListenerOptions = { passive: false, capture: true }
    const handler = (e: WheelEvent) => {
      // Stop scroll chaining and any parent capture handlers.
      e.stopImmediatePropagation()
      if (e.cancelable) e.preventDefault()
      e.stopPropagation()
      const hit = clientToInternal(e.clientX, e.clientY)
      if (!hit) return
      zoomBy(wheelZoomFactor(e.deltaY), { x: hit.x, y: hit.y })
    }

    canvas.addEventListener("wheel", handler, opts)
    container.addEventListener("wheel", handler, opts)
    return () => {
      canvas.removeEventListener("wheel", handler, opts)
      container.removeEventListener("wheel", handler, opts)
    }
  }, [canvasRef, clientToInternal, containerRef, zoomBy])

  return { zoom, setView, zoomBy, clientToInternal }
}
