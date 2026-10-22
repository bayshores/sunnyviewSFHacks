"use client"

import { useEffect } from "react"
import type { MutableRefObject } from "react"
import type { CesiumModule, ViewerRef } from "./types"

type Entity = import("cesium").Entity

const MARKER_FILL = "#ffd166"
const MARKER_OUTLINE = "#0b0f19"

function createSiteMarker(Cesium: CesiumModule, position: import("cesium").Cartesian3) {
  return {
    position,
    point: {
      pixelSize: 10,
      color: Cesium.Color.fromCssColorString(MARKER_FILL),
      outlineColor: Cesium.Color.fromCssColorString(MARKER_OUTLINE),
      outlineWidth: 2,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    label: {
      text: "Site",
      font: "14px sans-serif",
      fillColor: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      pixelOffset: new Cesium.Cartesian2(0, -12),
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  }
}

export type UseSiteMarkerOptions = {
  ready: boolean
  hasLocation: boolean
  lat: number | null
  lng: number | null
  viewerRef: ViewerRef
  markerEntityRef: MutableRefObject<Entity | null>
}

/** Adds (or moves) the "Site" point + label entity at lat/lng. */
export function useSiteMarker({ ready, hasLocation, lat, lng, viewerRef, markerEntityRef }: UseSiteMarkerOptions): void {
  useEffect(() => {
    if (!ready) return
    if (!hasLocation || lat === null || lng === null) return
    ;(async () => {
      const Cesium: CesiumModule = await import("cesium")
      const viewer = viewerRef.current
      if (!viewer) return

      const position = Cesium.Cartesian3.fromDegrees(lng, lat, 0)
      if (!markerEntityRef.current) {
        markerEntityRef.current = viewer.entities.add(createSiteMarker(Cesium, position))
      } else {
        // Entity.position's setter wraps a raw Cartesian3 in a ConstantPositionProperty at runtime,
        // but the typings only declare PositionProperty.
        markerEntityRef.current.position = position as unknown as import("cesium").PositionProperty
      }
      viewer.scene.requestRender()
    })()
  }, [ready, hasLocation, lat, lng, markerEntityRef, viewerRef])
}
