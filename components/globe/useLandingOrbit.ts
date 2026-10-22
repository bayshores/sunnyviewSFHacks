"use client"

import { useEffect, useRef } from "react"
import { prefersReducedMotion } from "./camera"
import { createLandingOrbit } from "./landing-orbit"
import type { MutableRefObject } from "react"
import type { LandingOrbit } from "./landing-orbit"
import type { CesiumModule, CesiumRef, CesiumViewer, ViewerRef } from "./types"

export type UseLandingOrbitOptions = {
  ready: boolean
  isHero: boolean
  landingActive: boolean
  hue: number
  saturation: number
  viewerRef: ViewerRef
  cesiumRef: CesiumRef
  orbitRef: MutableRefObject<LandingOrbit | null>
  clearLandingOrbit: (viewer?: CesiumViewer | null) => void
}

/** Hero-only orbiting particles while the landing globe is idle; recoloured live from the accent. */
export function useLandingOrbit({
  ready,
  isHero,
  landingActive,
  hue,
  saturation,
  viewerRef,
  cesiumRef,
  orbitRef,
  clearLandingOrbit,
}: UseLandingOrbitOptions): void {
  // Latest accent for orbit creation without making it an effect dependency (which would rebuild the orbit).
  const accentRef = useRef({ hue, saturation })
  accentRef.current.hue = hue
  accentRef.current.saturation = saturation

  useEffect(() => {
    if (!ready) return
    if (!isHero) return

    const viewer = viewerRef.current
    if (!viewer) return

    if (!landingActive) {
      clearLandingOrbit(viewer)
      return
    }

    if (orbitRef.current) return

    let cancelled = false

    const reduceMotion = prefersReducedMotion()

    ;(async () => {
      const Cesium: CesiumModule = cesiumRef.current ?? (await import("cesium"))
      cesiumRef.current = Cesium
      if (cancelled) return

      const liveViewer = viewerRef.current
      if (!liveViewer) return

      const orbit = createLandingOrbit({
        Cesium,
        viewer: liveViewer,
        getViewer: () => viewerRef.current,
        hue: accentRef.current.hue,
        saturation: accentRef.current.saturation,
      })
      if (!orbit) {
        // createLandingOrbit already removed what it added; mirror clearLandingOrbit's re-render.
        clearLandingOrbit(liveViewer)
        return
      }
      orbitRef.current = orbit

      if (reduceMotion) {
        if (!orbit.drawStatic()) {
          clearLandingOrbit(liveViewer)
        }
        return
      }

      orbit.startLoop(
        () => cancelled,
        () => clearLandingOrbit()
      )
    })()

    return () => {
      cancelled = true
      clearLandingOrbit()
    }
  }, [cesiumRef, clearLandingOrbit, isHero, landingActive, orbitRef, ready, viewerRef])

  useEffect(() => {
    if (!ready) return
    if (!isHero) return

    const Cesium = cesiumRef.current
    if (!Cesium) return

    const orbit = orbitRef.current
    if (!orbit) return

    orbit.applyAccent(Cesium, hue, saturation)

    const viewer = viewerRef.current
    if (viewer) {
      try {
        viewer.scene.requestRender()
      } catch {
        // ignore
      }
    }
  }, [cesiumRef, hue, isHero, orbitRef, ready, saturation, viewerRef])
}
