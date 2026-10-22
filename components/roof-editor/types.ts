import type { Point } from "@/components/PanelPacking"

export type BackgroundSpec =
  | { kind: "none" }
  | { kind: "image"; src: string; widthPx: number; heightPx: number }

export type SegmentRoi = { x: number; y: number; w: number; h: number }

export type CandidatePolygon = { id: string; polygon: Point[]; score?: number }

export type EditorMode = "edit" | "view"

/** Size of the internal (image) coordinate space. */
export type InternalSize = { w: number; h: number }

/** Zoom/pan view state, expressed in internal coordinates. */
export type ViewState = { zoom: number; panX: number; panY: number }

export type AutoOutlineStatus = {
  title: string
  tone: "info" | "error" | "hint"
  detail?: string
}
