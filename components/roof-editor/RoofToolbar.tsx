"use client"

import { ZOOM_STEP } from "./view-transform"

const IMAGE_TIP =
  "Tip: drag inside the roof to move it; drag outside to pan; scroll/trackpad to zoom. Double-click to add a point. Double-click the first point to finish. Drag a point to reshape. Triple-click to delete."
const NO_IMAGE_TIP = "Trace the usable roof polygon."

const SECONDARY_BUTTON =
  "rounded-md bg-secondary px-3 py-1.5 text-xs font-medium text-secondary-foreground hover:bg-secondary/80"
const ZOOM_BUTTON = "rounded-md px-2 py-1 text-[11px] text-secondary-foreground hover:bg-secondary/80"

export type RoofToolbarProps = {
  hasImage: boolean
  showNearby: boolean
  onToggleNearby: () => void
  /** Omit to hide the Auto-outline button. */
  onAutoOutline?: () => void
  autoOutlineBusy: boolean
  onClear: () => void
  zoom: number
  onZoomBy: (factor: number) => void
  onResetView: () => void
}

export function RoofToolbar({
  hasImage,
  showNearby,
  onToggleNearby,
  onAutoOutline,
  autoOutlineBusy,
  onClear,
  zoom,
  onZoomBy,
  onResetView,
}: RoofToolbarProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="text-xs text-muted-foreground">{hasImage ? IMAGE_TIP : NO_IMAGE_TIP}</div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={`rounded-md px-3 py-1.5 text-xs font-medium ${
            showNearby
              ? "bg-primary text-primary-foreground"
              : "bg-secondary text-secondary-foreground hover:bg-secondary/80"
          }`}
          onClick={onToggleNearby}
          title={showNearby ? "Hide nearby roofs" : "Edit: show nearby roofs"}
        >
          {showNearby ? "Edit: On" : "Edit"}
        </button>

        {onAutoOutline && (
          <button
            type="button"
            className={SECONDARY_BUTTON}
            onClick={onAutoOutline}
            disabled={!hasImage || autoOutlineBusy}
            title={hasImage ? "Auto-outline" : "Auto-outline requires an image."}
          >
            {autoOutlineBusy ? "Auto-outlining…" : "Auto-outline"}
          </button>
        )}

        <button type="button" className={SECONDARY_BUTTON} onClick={onClear}>
          Clear
        </button>

        <div className="flex items-center gap-1 rounded-md bg-secondary/60 px-1.5 py-1">
          <button
            type="button"
            className={`${ZOOM_BUTTON} font-semibold`}
            onClick={() => onZoomBy(1 / ZOOM_STEP)}
            title="Zoom out"
          >
            −
          </button>
          <div className="min-w-[54px] text-center text-[11px] font-medium text-secondary-foreground">
            {Math.round(zoom * 100)}%
          </div>
          <button
            type="button"
            className={`${ZOOM_BUTTON} font-semibold`}
            onClick={() => onZoomBy(ZOOM_STEP)}
            title="Zoom in"
          >
            +
          </button>
          <button type="button" className={`${ZOOM_BUTTON} font-medium`} onClick={onResetView} title="Reset view">
            Reset
          </button>
        </div>
      </div>
    </div>
  )
}
