import type { MutableRefObject } from "react"

export type CesiumModule = typeof import("cesium")
export type CesiumViewer = import("cesium").Viewer

export type ViewerRef = MutableRefObject<CesiumViewer | null>
export type CesiumRef = MutableRefObject<CesiumModule | null>
export type RafRef = MutableRefObject<number | null>
