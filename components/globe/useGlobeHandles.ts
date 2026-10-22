"use client"

import { useCallback, useRef } from "react"
import { cancelRafRef } from "./camera"
import type { LandingOrbit } from "./landing-orbit"
import type { CesiumModule, CesiumViewer } from "./types"

/**
 * Mutable Cesium handles shared between the globe hooks. Kept in refs (never state) so animation
 * and imperative Cesium updates do not re-render the component. This hook has no effects, so it
 * can be called before `useCesiumViewer` and hand it a stable teardown callback.
 */
export function useGlobeHandles() {
  const viewerRef = useRef<CesiumViewer | null>(null)
  const cesiumRef = useRef<CesiumModule | null>(null)
  const markerEntityRef = useRef<import("cesium").Entity | null>(null)
  const pickHandlerRef = useRef<import("cesium").ScreenSpaceEventHandler | null>(null)
  const clickSpinRafRef = useRef<number | null>(null)
  const landingSpinRafRef = useRef<number | null>(null)
  const landingSpinLastNowRef = useRef<number | null>(null)
  const orbitRef = useRef<LandingOrbit | null>(null)

  /** Stops the landing orbit and removes its primitives from `viewerArg` (or the live viewer). */
  const clearLandingOrbit = useCallback((viewerArg?: CesiumViewer | null) => {
    const orbit = orbitRef.current
    orbitRef.current = null
    const viewer = viewerArg ?? viewerRef.current
    orbit?.dispose(viewer)
    if (!viewer) return
    try {
      viewer.scene.requestRender()
    } catch {
      // ignore
    }
  }, [])

  const destroyPickHandler = useCallback(() => {
    if (pickHandlerRef.current) {
      try {
        pickHandlerRef.current.destroy()
      } catch {
        // ignore
      }
      pickHandlerRef.current = null
    }
  }, [])

  const cancelLandingSpin = useCallback(() => {
    if (landingSpinRafRef.current !== null) {
      window.cancelAnimationFrame(landingSpinRafRef.current)
      landingSpinRafRef.current = null
      landingSpinLastNowRef.current = null
    }
  }, [])

  /** Runs right before the viewer is destroyed: stop every loop/handler that touches it. */
  const teardownBeforeDestroy = useCallback(
    (viewer: CesiumViewer | null) => {
      cancelRafRef(clickSpinRafRef)
      cancelLandingSpin()
      destroyPickHandler()
      clearLandingOrbit(viewer)
      markerEntityRef.current = null
    },
    [cancelLandingSpin, clearLandingOrbit, destroyPickHandler]
  )

  return {
    viewerRef,
    cesiumRef,
    markerEntityRef,
    pickHandlerRef,
    clickSpinRafRef,
    landingSpinRafRef,
    landingSpinLastNowRef,
    orbitRef,
    clearLandingOrbit,
    destroyPickHandler,
    cancelLandingSpin,
    teardownBeforeDestroy,
  }
}
