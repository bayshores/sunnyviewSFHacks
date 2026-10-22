import type { Point } from "@/components/PanelPacking"
import { clamp } from "./geometry"
import type { InternalSize, ViewState } from "./types"

export const MIN_ZOOM = 1
export const MAX_ZOOM = 8
export const ZOOM_STEP = 1.18
export const WHEEL_ZOOM_SENSITIVITY = 0.0014
export const DEFAULT_INTERNAL_SIZE: InternalSize = { w: 1024, h: 640 }
export const INITIAL_VIEW: ViewState = { zoom: 1, panX: 0, panY: 0 }

export type FitTransform = { scale: number; offX: number; offY: number }
export type InternalHit = { x: number; y: number; scale: number }

/** Letterbox-fit of the internal space into a viewport of `width` x `height` CSS px. */
export function fitTransform(width: number, height: number, size: InternalSize): FitTransform {
  const scale = Math.min(width / size.w, height / size.h)
  return {
    scale,
    offX: (width - size.w * scale) / 2,
    offY: (height - size.h * scale) / 2,
  }
}

/**
 * Map a viewport-local point (CSS px relative to the container) to internal coordinates,
 * clamped to the internal bounds. `scale` is the effective CSS px per internal unit.
 */
export function toInternal(
  localX: number,
  localY: number,
  width: number,
  height: number,
  size: InternalSize,
  view: ViewState
): InternalHit {
  const fit = fitTransform(width, height, size)
  const qx = (localX - fit.offX) / fit.scale
  const qy = (localY - fit.offY) / fit.scale
  const cx = size.w / 2
  const cy = size.h / 2
  const ix = cx + (qx - cx) / view.zoom - view.panX
  const iy = cy + (qy - cy) / view.zoom - view.panY
  return {
    x: clamp(ix, 0, size.w),
    y: clamp(iy, 0, size.h),
    scale: fit.scale * view.zoom,
  }
}

function clampAxisPan(pan: number, viewportSpan: number, span: number): number {
  if (viewportSpan >= span) return 0
  const center = span / 2
  const clampedCenter = clamp(center - pan, viewportSpan / 2, span - viewportSpan / 2)
  return center - clampedCenter
}

/** Clamp zoom to >= 1 and pan so the visible window never leaves the internal bounds. */
export function clampViewToBounds(next: ViewState, width: number, height: number, size: InternalSize): ViewState {
  const baseScale = fitTransform(width, height, size).scale
  const zoom = Math.max(MIN_ZOOM, next.zoom)
  const viewportW = width / (baseScale * zoom)
  const viewportH = height / (baseScale * zoom)
  return {
    zoom,
    panX: clampAxisPan(next.panX, viewportW, size.w),
    panY: clampAxisPan(next.panY, viewportH, size.h),
  }
}

/**
 * Zoom by `factor` (result clamped to [MIN_ZOOM, MAX_ZOOM]) keeping `focus` (internal coords)
 * fixed on screen. Returns null when the zoom would not change. Pan is not bounds-clamped here.
 */
export function zoomAboutFocus(
  view: ViewState,
  factor: number,
  focus: Point | null,
  size: InternalSize
): ViewState | null {
  const nextZoom = clamp(view.zoom * factor, MIN_ZOOM, MAX_ZOOM)
  if (Math.abs(nextZoom - view.zoom) < 1e-6) return null
  if (!focus) return { zoom: nextZoom, panX: view.panX, panY: view.panY }

  const cx = size.w / 2
  const cy = size.h / 2
  const ratio = view.zoom / nextZoom
  return {
    zoom: nextZoom,
    panX: cx + ratio * (focus.x + view.panX - cx) - focus.x,
    panY: cy + ratio * (focus.y + view.panY - cy) - focus.y,
  }
}

/** Pan resulting from dragging the pointer by (dx, dy) CSS px from a drag start. */
export function panFromDrag(
  start: { panX: number; panY: number },
  dx: number,
  dy: number,
  baseScale: number,
  zoom: number
): ViewState {
  const z = Math.max(MIN_ZOOM, zoom)
  return {
    zoom: z,
    panX: start.panX + dx / (baseScale * z),
    panY: start.panY + dy / (baseScale * z),
  }
}

export function wheelZoomFactor(deltaY: number): number {
  return Math.exp(-deltaY * WHEEL_ZOOM_SENSITIVITY)
}
