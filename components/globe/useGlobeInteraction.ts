"use client"

import { useEffect } from "react"
import type { MutableRefObject } from "react"
import type { CesiumModule, CesiumRef, ViewerRef } from "./types"

type ScreenSpaceEventHandler = import("cesium").ScreenSpaceEventHandler
type PositionedEvent = import("cesium").ScreenSpaceEventHandler.PositionedEvent

export type UseGlobeInteractionOptions = {
  ready: boolean
  interactive: boolean
  onPickLocation?: (p: { lat: number; lng: number }) => void
  viewerRef: ViewerRef
  cesiumRef: CesiumRef
  pickHandlerRef: MutableRefObject<ScreenSpaceEventHandler | null>
  destroyPickHandler: () => void
}

/** Enables camera inputs only when interactive, and wires LEFT_CLICK → onPickLocation(lat, lng). */
export function useGlobeInteraction({
  ready,
  interactive,
  onPickLocation,
  viewerRef,
  cesiumRef,
  pickHandlerRef,
  destroyPickHandler,
}: UseGlobeInteractionOptions): void {
  useEffect(() => {
    if (!ready) return
    const viewer = viewerRef.current
    if (!viewer) return
    const c = viewer.scene.screenSpaceCameraController
    c.enableInputs = interactive
    c.enableRotate = interactive
    c.enableTranslate = interactive
    c.enableZoom = interactive
    c.enableTilt = interactive
    c.enableLook = interactive
  }, [interactive, ready, viewerRef])

  useEffect(() => {
    if (!ready) return
    const viewer = viewerRef.current
    if (!viewer) return

    if (!interactive || !onPickLocation) {
      destroyPickHandler()
      return
    }

    let cancelled = false
    ;(async () => {
      const Cesium: CesiumModule = cesiumRef.current ?? (await import("cesium"))
      cesiumRef.current = Cesium
      if (cancelled) return

      destroyPickHandler()

      const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)
      pickHandlerRef.current = handler
      handler.setInputAction((movement: PositionedEvent) => {
        const viewerNow = viewerRef.current
        const CesiumNow = cesiumRef.current
        if (!viewerNow || !CesiumNow) return
        const pos = movement?.position
        if (!pos) return
        const cartesian = viewerNow.camera.pickEllipsoid(pos, viewerNow.scene.globe.ellipsoid)
        if (!cartesian) return
        const cartographic = CesiumNow.Cartographic.fromCartesian(cartesian)
        const pickedLat = CesiumNow.Math.toDegrees(cartographic.latitude)
        const pickedLng = CesiumNow.Math.toDegrees(cartographic.longitude)
        if (!Number.isFinite(pickedLat) || !Number.isFinite(pickedLng)) return
        onPickLocation({ lat: pickedLat, lng: pickedLng })
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
    })()

    return () => {
      cancelled = true
      destroyPickHandler()
    }
  }, [cesiumRef, destroyPickHandler, interactive, onPickLocation, pickHandlerRef, ready, viewerRef])
}
