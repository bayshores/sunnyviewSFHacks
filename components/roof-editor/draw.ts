import type { PlacedPanel, Point } from "@/components/PanelPacking"
import { fitTransform } from "./view-transform"
import type { AutoOutlineStatus, CandidatePolygon, EditorMode, InternalSize, ViewState } from "./types"

const FONT_FAMILY = "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto"
const GRID_STEP = 64
const CANDIDATE_COLORS = [
  "rgba(34,197,94,0.95)",
  "rgba(59,130,246,0.95)",
  "rgba(245,158,11,0.95)",
  "rgba(236,72,153,0.95)",
  "rgba(168,85,247,0.95)",
] as const

export type CanvasMetrics = { width: number; height: number; dpr: number }

export type SceneState = {
  /** Viewport size in CSS px. */
  width: number
  height: number
  dpr: number
  size: InternalSize
  view: ViewState
  hasImageBackground: boolean
  image: HTMLImageElement | null
  panels: readonly PlacedPanel[]
  vertices: readonly Point[]
  closed: boolean
  mode: EditorMode
  hoverIdx: number | null
  orientationDeg: number
  centerPin: Point | null
  /** Candidate outlines to draw (null when hidden). */
  candidates: readonly CandidatePolygon[] | null
  panelWattW: number
  mPerPx: number | null
  status: AutoOutlineStatus | null
}

/** Resize the canvas backing store only when size or DPR changed. Returns the current metrics. */
export function syncCanvasBackingStore(
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number,
  dpr: number,
  last: CanvasMetrics
): CanvasMetrics {
  const width = Math.max(1, Math.floor(cssWidth * dpr))
  const height = Math.max(1, Math.floor(cssHeight * dpr))
  if (last.width === width && last.height === height && last.dpr === dpr) return last
  canvas.width = width
  canvas.height = height
  return { width, height, dpr }
}

export function autoOutlineStatus(
  busy: boolean,
  error: string | null,
  hint: string | null
): AutoOutlineStatus | null {
  if (busy) return { title: "Detecting roof…", tone: "info" }
  if (error) return { title: "Auto-outline failed", tone: "error", detail: error }
  if (hint) return { title: hint, tone: "hint" }
  return null
}

export function overlayLines(
  panelCount: number,
  panelWattW: number,
  mPerPx: number | null,
  orientationDeg: number
): { panels: string; dc: string; scale: string; orient: string } {
  const dcKw = (panelCount * panelWattW) / 1000
  return {
    panels: `Panels: ${panelCount}`,
    dc: `DC: ${dcKw.toFixed(1)} kW`,
    scale: `Scale: ${mPerPx ? `${mPerPx.toExponential(2)} m/px` : "—"}`,
    orient: `Orient: ${orientationDeg.toFixed(0)}°`,
  }
}

export function clipStatusDetail(detail: string): string {
  return detail.length > 44 ? `${detail.slice(0, 41)}…` : detail
}

function drawBackground(ctx: CanvasRenderingContext2D, s: SceneState): void {
  if (s.hasImageBackground && s.image) {
    ctx.drawImage(s.image, 0, 0, s.size.w, s.size.h)
    return
  }
  ctx.fillStyle = s.hasImageBackground ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.04)"
  ctx.fillRect(0, 0, s.size.w, s.size.h)
}

function drawGrid(ctx: CanvasRenderingContext2D, size: InternalSize, uiScale: number): void {
  ctx.strokeStyle = "rgba(255,255,255,0.05)"
  ctx.lineWidth = 1 * uiScale
  for (let x = 0; x <= size.w; x += GRID_STEP) {
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, size.h)
    ctx.stroke()
  }
  for (let y = 0; y <= size.h; y += GRID_STEP) {
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(size.w, y)
    ctx.stroke()
  }
}

function drawPanels(ctx: CanvasRenderingContext2D, panels: readonly PlacedPanel[], uiScale: number): void {
  if (panels.length === 0) return
  ctx.save()
  ctx.globalAlpha = 0.85
  for (const p of panels) {
    ctx.save()
    ctx.translate(p.cx, p.cy)
    ctx.rotate((p.rotationDeg * Math.PI) / 180)
    ctx.translate(-p.widthPx / 2, -p.heightPx / 2)
    ctx.fillStyle = "rgba(245, 158, 11, 0.22)"
    ctx.strokeStyle = "rgba(245, 158, 11, 0.7)"
    ctx.lineWidth = 1 * uiScale
    ctx.fillRect(0, 0, p.widthPx, p.heightPx)
    ctx.strokeRect(0, 0, p.widthPx, p.heightPx)
    ctx.restore()
  }
  ctx.restore()
}

function drawPolygon(ctx: CanvasRenderingContext2D, s: SceneState, uiScale: number): void {
  const { vertices, closed } = s
  if (vertices.length === 0) return

  ctx.beginPath()
  ctx.moveTo(vertices[0].x, vertices[0].y)
  for (let i = 1; i < vertices.length; i++) ctx.lineTo(vertices[i].x, vertices[i].y)
  if (closed) ctx.closePath()

  ctx.strokeStyle = "rgba(59, 130, 246, 0.95)"
  ctx.lineWidth = 2 * uiScale
  ctx.stroke()
  if (closed) {
    ctx.fillStyle = "rgba(59, 130, 246, 0.08)"
    ctx.fill()
  }

  if (s.mode !== "edit") return
  for (let i = 0; i < vertices.length; i++) {
    const v = vertices[i]
    const hovered = s.hoverIdx === i
    ctx.beginPath()
    ctx.arc(v.x, v.y, (hovered ? 7 : 5) * uiScale, 0, Math.PI * 2)
    ctx.fillStyle = hovered ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.8)"
    ctx.fill()
    ctx.strokeStyle = "rgba(0,0,0,0.65)"
    ctx.lineWidth = 2 * uiScale
    ctx.stroke()
  }
}

function drawOrientationHint(ctx: CanvasRenderingContext2D, s: SceneState, uiScale: number): void {
  if (!s.closed || s.vertices.length < 3) return
  ctx.save()
  ctx.translate(s.size.w / 2, s.size.h / 2)
  ctx.rotate((s.orientationDeg * Math.PI) / 180)
  ctx.strokeStyle = "rgba(255,255,255,0.25)"
  ctx.lineWidth = 2 * uiScale
  ctx.beginPath()
  ctx.moveTo(-60, 0)
  ctx.lineTo(60, 0)
  ctx.stroke()
  ctx.restore()
}

function drawCenterPin(ctx: CanvasRenderingContext2D, pin: Point | null, uiScale: number): void {
  if (!pin) return
  const arm = 10 * uiScale
  ctx.save()
  ctx.strokeStyle = "rgba(255,255,255,0.85)"
  ctx.lineWidth = 2 * uiScale
  ctx.beginPath()
  ctx.moveTo(pin.x - arm, pin.y)
  ctx.lineTo(pin.x + arm, pin.y)
  ctx.moveTo(pin.x, pin.y - arm)
  ctx.lineTo(pin.x, pin.y + arm)
  ctx.stroke()
  ctx.restore()
}

function drawCandidates(
  ctx: CanvasRenderingContext2D,
  candidates: readonly CandidatePolygon[] | null,
  uiScale: number
): void {
  if (!candidates || candidates.length === 0) return
  candidates.forEach((c, idx) => {
    const poly = c.polygon
    if (!poly || poly.length < 3) return
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(poly[0].x, poly[0].y)
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y)
    ctx.closePath()
    ctx.strokeStyle = CANDIDATE_COLORS[idx % CANDIDATE_COLORS.length]
    ctx.lineWidth = 2 * uiScale
    ctx.stroke()
    ctx.fillStyle = "rgba(0,0,0,0.14)"
    ctx.fill()

    // Label near first vertex (keep readable under zoom).
    const p0 = poly[0]
    const pad = 6 * uiScale
    ctx.fillStyle = "rgba(0,0,0,0.65)"
    ctx.fillRect(p0.x + pad, p0.y + pad, 92 * uiScale, 18 * uiScale)
    ctx.fillStyle = "rgba(255,255,255,0.92)"
    ctx.font = `${11 * uiScale}px ${FONT_FAMILY}`
    ctx.textAlign = "left"
    ctx.fillText(`Option ${idx + 1}`, p0.x + pad + 6 * uiScale, p0.y + pad + 13 * uiScale)
    ctx.restore()
  })
}

function drawOverlay(ctx: CanvasRenderingContext2D, s: SceneState): void {
  const lines = overlayLines(s.panels.length, s.panelWattW, s.mPerPx, s.orientationDeg)
  ctx.fillStyle = "rgba(0,0,0,0.55)"
  ctx.fillRect(12, 12, 282, 54)
  ctx.fillStyle = "rgba(255,255,255,0.9)"
  ctx.font = `12px ${FONT_FAMILY}`
  ctx.fillText(lines.panels, 22, 32)
  ctx.fillText(lines.dc, 22, 50)
  ctx.fillStyle = "rgba(255,255,255,0.65)"
  ctx.fillText(lines.scale, 132, 32)
  ctx.fillText(lines.orient, 132, 50)
}

function statusColor(tone: AutoOutlineStatus["tone"]): string {
  if (tone === "error") return "rgba(248,113,113,0.95)"
  if (tone === "hint") return "rgba(245,158,11,0.95)"
  return "rgba(255,255,255,0.9)"
}

function drawStatus(ctx: CanvasRenderingContext2D, status: AutoOutlineStatus | null): void {
  if (!status) return
  const showDetail = status.tone === "error" && Boolean(status.detail)
  ctx.fillStyle = "rgba(0,0,0,0.55)"
  ctx.fillRect(12, 74, 282, showDetail ? 46 : 28)
  ctx.fillStyle = statusColor(status.tone)
  ctx.font = `12px ${FONT_FAMILY}`
  ctx.fillText(status.title, 22, 93)

  if (showDetail && status.detail) {
    ctx.fillStyle = "rgba(255,255,255,0.75)"
    ctx.fillText(clipStatusDetail(String(status.detail)), 22, 111)
  }
}

/** Render the full editor scene. Assumes the canvas backing store is already sized. */
export function drawScene(ctx: CanvasRenderingContext2D, s: SceneState): void {
  ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0)
  ctx.clearRect(0, 0, s.width, s.height)

  const fit = fitTransform(s.width, s.height, s.size)
  const uiScale = 1 / Math.max(1, s.view.zoom)

  ctx.fillStyle = "rgba(0,0,0,0.35)"
  ctx.fillRect(0, 0, s.width, s.height)
  ctx.save()
  ctx.translate(fit.offX, fit.offY)
  ctx.scale(fit.scale, fit.scale)
  // View transform (zoom/pan) in internal coordinates.
  const vCx = s.size.w / 2
  const vCy = s.size.h / 2
  ctx.translate(vCx, vCy)
  ctx.scale(s.view.zoom, s.view.zoom)
  ctx.translate(s.view.panX - vCx, s.view.panY - vCy)

  drawBackground(ctx, s)
  drawGrid(ctx, s.size, uiScale)
  drawPanels(ctx, s.panels, uiScale)
  drawPolygon(ctx, s, uiScale)
  drawOrientationHint(ctx, s, uiScale)
  drawCenterPin(ctx, s.centerPin, uiScale)
  drawCandidates(ctx, s.candidates, uiScale)

  ctx.restore()

  drawOverlay(ctx, s)
  drawStatus(ctx, s.status)
}
