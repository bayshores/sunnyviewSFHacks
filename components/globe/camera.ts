// Imperative camera helpers shared by the globe hooks.

import { centerSpinProgress, centerSpinVelocity, CENTER_SPIN, frameDeltaSeconds } from "./math"
import type { CesiumModule, CesiumViewer, RafRef } from "./types"

export const FLY_TO_HEIGHT_M = 1200
export const FLY_TO_DURATION_S = 1.9
export const CENTER_FLY_HOME_DURATION_S = 0.85

export function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false
}

/** Cancels a pending animation frame stored in `rafRef` (no-op when none). */
export function cancelRafRef(rafRef: RafRef): void {
  if (rafRef.current !== null) {
    window.cancelAnimationFrame(rafRef.current)
    rafRef.current = null
  }
}

export function flyToSite(Cesium: CesiumModule, viewer: CesiumViewer, lat: number, lng: number): void {
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lng, lat, FLY_TO_HEIGHT_M),
    duration: FLY_TO_DURATION_S,
  })
}

/**
 * Eased "whoosh" spin after the landing globe is clicked: waits CENTER_SPIN.delayMs, then rotates
 * with a sine velocity profile for CENTER_SPIN.durationMs. The pending frame id lives in `rafRef`.
 */
export function startCenterSpin(getViewer: () => CesiumViewer | null, rafRef: RafRef): void {
  const start = performance.now()
  let lastNow = start

  const tick = (now: number) => {
    const viewerNow = getViewer()
    if (!viewerNow) return

    const elapsed = now - start
    if (elapsed < CENTER_SPIN.delayMs) {
      lastNow = now
      rafRef.current = window.requestAnimationFrame(tick)
      return
    }
    const t = centerSpinProgress(elapsed)
    const velocity = centerSpinVelocity(t)
    const dt = frameDeltaSeconds(now, lastNow)
    lastNow = now
    viewerNow.camera.rotateRight(velocity * dt)
    viewerNow.scene.requestRender()

    if (t >= 1) {
      rafRef.current = null
      return
    }
    rafRef.current = window.requestAnimationFrame(tick)
  }

  rafRef.current = window.requestAnimationFrame(tick)
}
