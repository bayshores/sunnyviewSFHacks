import { describe, expect, it } from "vitest"
import {
  INITIAL_VIEW,
  MAX_ZOOM,
  MIN_ZOOM,
  clampViewToBounds,
  fitTransform,
  panFromDrag,
  toInternal,
  wheelZoomFactor,
  zoomAboutFocus,
} from "./view-transform"
import type { InternalSize, ViewState } from "./types"

const SIZE: InternalSize = { w: 1000, h: 500 }
// Viewport twice as wide as tall relative to SIZE: base scale 0.5, letterboxed vertically.
const VIEW_W = 500
const VIEW_H = 400

/** Forward mapping (inverse of toInternal, without clamping). */
function internalToLocal(p: { x: number; y: number }, view: ViewState): { x: number; y: number } {
  const fit = fitTransform(VIEW_W, VIEW_H, SIZE)
  const cx = SIZE.w / 2
  const cy = SIZE.h / 2
  const qx = cx + view.zoom * (p.x + view.panX - cx)
  const qy = cy + view.zoom * (p.y + view.panY - cy)
  return { x: fit.offX + qx * fit.scale, y: fit.offY + qy * fit.scale }
}

describe("fitTransform", () => {
  it("letterboxes and centers the internal space", () => {
    expect(fitTransform(VIEW_W, VIEW_H, SIZE)).toEqual({ scale: 0.5, offX: 0, offY: 75 })
    expect(fitTransform(2000, 500, SIZE)).toEqual({ scale: 1, offX: 500, offY: 0 })
  })
})

describe("toInternal", () => {
  it("maps the viewport center to the internal center at any zoom without pan", () => {
    for (const zoom of [1, 2, 5]) {
      const hit = toInternal(VIEW_W / 2, VIEW_H / 2, VIEW_W, VIEW_H, SIZE, { zoom, panX: 0, panY: 0 })
      expect(hit.x).toBeCloseTo(500)
      expect(hit.y).toBeCloseTo(250)
      expect(hit.scale).toBeCloseTo(0.5 * zoom)
    }
  })

  it("maps the letterboxed image corners at zoom 1", () => {
    const tl = toInternal(0, 75, VIEW_W, VIEW_H, SIZE, INITIAL_VIEW)
    const br = toInternal(500, 325, VIEW_W, VIEW_H, SIZE, INITIAL_VIEW)
    expect(tl).toMatchObject({ x: 0, y: 0 })
    expect(br).toMatchObject({ x: 1000, y: 500 })
  })

  it("round-trips with the forward mapping under zoom and pan", () => {
    const view = { zoom: 3, panX: -120, panY: 40 }
    const p = { x: 640, y: 180 }
    const local = internalToLocal(p, view)
    const hit = toInternal(local.x, local.y, VIEW_W, VIEW_H, SIZE, view)
    expect(hit.x).toBeCloseTo(p.x)
    expect(hit.y).toBeCloseTo(p.y)
  })

  it("clamps results to the internal bounds", () => {
    const hit = toInternal(-50, 0, VIEW_W, VIEW_H, SIZE, INITIAL_VIEW)
    expect(hit.x).toBe(0)
    expect(hit.y).toBe(0)
    const far = toInternal(9999, 9999, VIEW_W, VIEW_H, SIZE, INITIAL_VIEW)
    expect(far).toMatchObject({ x: 1000, y: 500 })
  })
})

describe("clampViewToBounds", () => {
  it("forces zoom >= 1 and zero pan when the whole image fits", () => {
    expect(clampViewToBounds({ zoom: 0.5, panX: 100, panY: -80 }, VIEW_W, VIEW_H, SIZE)).toEqual({
      zoom: 1,
      panX: 0,
      panY: 0,
    })
  })

  it("keeps pan within the image on the zoomed axis", () => {
    const v = clampViewToBounds({ zoom: 2, panX: 10_000, panY: -10_000 }, VIEW_W, VIEW_H, SIZE)
    // Visible width = 500 / (0.5 * 2) = 500 -> center in [250, 750] -> pan in [-250, 250]
    expect(v.panX).toBe(250)
    // Visible height = 400 / (0.5 * 2) = 400 -> center in [200, 300] -> pan in [-50, 50]
    expect(v.panY).toBe(-50)
  })

  it("keeps the minimum and maximum edges reachable", () => {
    const left = clampViewToBounds({ zoom: 4, panX: 375, panY: 0 }, VIEW_W, VIEW_H, SIZE)
    const right = clampViewToBounds({ zoom: 4, panX: -375, panY: 0 }, VIEW_W, VIEW_H, SIZE)
    // Visible width = 250 -> pan in [-375, 375]: exactly at the edges stays put.
    expect(left.panX).toBe(375)
    expect(right.panX).toBe(-375)
  })

  it("zeroes pan on an axis that still fits after zoom", () => {
    // Visible height at zoom 1.2: 400 / 0.6 = 666 >= 500 -> panY forced to 0
    const v = clampViewToBounds({ zoom: 1.2, panX: 5, panY: 30 }, VIEW_W, VIEW_H, SIZE)
    expect(v.panY).toBe(0)
  })

  it("leaves in-range pans untouched", () => {
    const v = clampViewToBounds({ zoom: 2, panX: 100, panY: 20 }, VIEW_W, VIEW_H, SIZE)
    expect(v).toEqual({ zoom: 2, panX: 100, panY: 20 })
  })
})

describe("zoomAboutFocus", () => {
  it("keeps the focus point fixed on screen", () => {
    const view = { zoom: 1.5, panX: 30, panY: -20 }
    const focus = { x: 700, y: 120 }
    const before = internalToLocal(focus, view)
    const next = zoomAboutFocus(view, 2, focus, SIZE)
    expect(next).not.toBeNull()
    const after = internalToLocal(focus, next as ViewState)
    expect(next?.zoom).toBe(3)
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
  })

  it("keeps the focus fixed when zooming out too", () => {
    const view = { zoom: 6, panX: -100, panY: 50 }
    const focus = { x: 300, y: 400 }
    const before = internalToLocal(focus, view)
    const next = zoomAboutFocus(view, 0.5, focus, SIZE) as ViewState
    const after = internalToLocal(focus, next)
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
  })

  it("keeps pan unchanged without a focus", () => {
    expect(zoomAboutFocus({ zoom: 2, panX: 5, panY: 6 }, 1.18, null, SIZE)).toEqual({
      zoom: 2 * 1.18,
      panX: 5,
      panY: 6,
    })
  })

  it("clamps zoom to [MIN_ZOOM, MAX_ZOOM]", () => {
    expect(zoomAboutFocus({ zoom: 7, panX: 0, panY: 0 }, 10, null, SIZE)?.zoom).toBe(MAX_ZOOM)
    expect(zoomAboutFocus({ zoom: 2, panX: 0, panY: 0 }, 0.01, null, SIZE)?.zoom).toBe(MIN_ZOOM)
  })

  it("returns null when zoom would not change", () => {
    expect(zoomAboutFocus({ zoom: MAX_ZOOM, panX: 0, panY: 0 }, 2, { x: 1, y: 1 }, SIZE)).toBeNull()
    expect(zoomAboutFocus(INITIAL_VIEW, 0.5, null, SIZE)).toBeNull()
  })
})

describe("panFromDrag", () => {
  it("converts screen drag to internal pan using base scale and zoom", () => {
    expect(panFromDrag({ panX: 10, panY: 20 }, 50, -30, 0.5, 2)).toEqual({ zoom: 2, panX: 60, panY: -10 })
  })

  it("treats zoom below 1 as 1", () => {
    expect(panFromDrag({ panX: 0, panY: 0 }, 10, 10, 0.5, 0.5)).toEqual({ zoom: 1, panX: 20, panY: 20 })
  })
})

describe("wheelZoomFactor", () => {
  it("zooms in for negative deltaY and out for positive", () => {
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1)
    expect(wheelZoomFactor(100)).toBeLessThan(1)
    expect(wheelZoomFactor(0)).toBe(1)
    expect(wheelZoomFactor(100) * wheelZoomFactor(-100)).toBeCloseTo(1)
  })
})
