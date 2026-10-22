"use client"

import { useCallback, useEffect } from "react"
import { cancelRafRef, CENTER_FLY_HOME_DURATION_S, flyToSite, prefersReducedMotion, startCenterSpin } from "./camera"
import type { CesiumModule, RafRef, ViewerRef } from "./types"

export type UseCameraActionsOptions = {
  ready: boolean
  interactive: boolean
  hasLocation: boolean
  lat: number | null
  lng: number | null
  viewerRef: ViewerRef
  clickSpinRafRef: RafRef
  cancelLandingSpin: () => void
}

/**
 * Camera actions: `flyTo` the site (also run automatically when the location changes while
 * interactive) and `centerAndSpin` for the landing "Start" click.
 */
export function useCameraActions({
  ready,
  interactive,
  hasLocation,
  lat,
  lng,
  viewerRef,
  clickSpinRafRef,
  cancelLandingSpin,
}: UseCameraActionsOptions): { flyTo: () => Promise<void>; centerAndSpin: () => Promise<void> } {
  const flyTo = useCallback(async () => {
    if (!hasLocation || lat === null || lng === null) return
    const Cesium: CesiumModule = await import("cesium")
    const viewer = viewerRef.current
    if (!viewer) return
    flyToSite(Cesium, viewer, lat, lng)
  }, [hasLocation, lat, lng, viewerRef])

  const centerAndSpin = useCallback(async () => {
    const viewer = viewerRef.current
    if (!viewer) return

    try {
      viewer.camera.flyHome(CENTER_FLY_HOME_DURATION_S)
    } catch {
      // ignore
    }

    cancelLandingSpin()
    cancelRafRef(clickSpinRafRef)

    if (prefersReducedMotion()) return

    startCenterSpin(() => viewerRef.current, clickSpinRafRef)
  }, [cancelLandingSpin, clickSpinRafRef, viewerRef])

  useEffect(() => {
    if (!ready) return
    if (!interactive) return
    if (!hasLocation) return
    void flyTo()
  }, [ready, interactive, hasLocation, flyTo])

  return { flyTo, centerAndSpin }
}
