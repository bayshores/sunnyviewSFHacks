import { describe, expect, it } from "vitest"
import type { PlacedPanel } from "@/components/PanelPacking"
import { drawScene, syncCanvasBackingStore } from "./draw"
import type { SceneState } from "./draw"

type Call = { fn: string; args: unknown[] }

/** Records every method call and property assignment made on a fake 2D context. */
function recordingContext() {
  const calls: Call[] = []
  const props: Record<string, unknown[]> = {}
  const ctx = new Proxy(
    {},
    {
      get(_t, name: string) {
        return (...args: unknown[]) => {
          calls.push({ fn: name, args })
        }
      },
      set(_t, name: string, value) {
        ;(props[name] ??= []).push(value)
        return true
      },
    }
  ) as unknown as CanvasRenderingContext2D
  const count = (fn: string) => calls.filter((c) => c.fn === fn).length
  return { ctx, calls, props, count }
}

const PANEL: PlacedPanel = { cx: 50, cy: 60, widthPx: 10, heightPx: 20, rotationDeg: 15 } as PlacedPanel

function scene(over: Partial<SceneState> = {}): SceneState {
  return {
    width: 500,
    height: 250,
    dpr: 2,
    size: { w: 1000, h: 500 },
    view: { zoom: 1, panX: 0, panY: 0 },
    hasImageBackground: false,
    image: null,
    panels: [],
    vertices: [],
    closed: false,
    mode: "edit",
    hoverIdx: null,
    orientationDeg: 0,
    centerPin: null,
    candidates: null,
    panelWattW: 400,
    mPerPx: null,
    status: null,
    ...over,
  }
}

const RING = [
  { x: 100, y: 100 },
  { x: 300, y: 100 },
  { x: 300, y: 300 },
]

describe("drawScene", () => {
  it("applies the DPR transform, clears, and always draws the overlay", () => {
    const r = recordingContext()
    drawScene(r.ctx, scene())
    expect(r.calls[0]).toEqual({ fn: "setTransform", args: [2, 0, 0, 2, 0, 0] })
    expect(r.calls[1]).toEqual({ fn: "clearRect", args: [0, 0, 500, 250] })
    const texts = r.calls.filter((c) => c.fn === "fillText").map((c) => c.args[0])
    expect(texts).toEqual(["Panels: 0", "DC: 0.0 kW", "Scale: —", "Orient: 0°"])
    expect(r.count("save")).toBe(r.count("restore"))
  })

  it("draws the loaded image as the background", () => {
    const r = recordingContext()
    const image = {} as HTMLImageElement
    drawScene(r.ctx, scene({ hasImageBackground: true, image }))
    expect(r.calls.find((c) => c.fn === "drawImage")?.args).toEqual([image, 0, 0, 1000, 500])
  })

  it("falls back to a tinted fill while the image is loading", () => {
    const loading = recordingContext()
    drawScene(loading.ctx, scene({ hasImageBackground: true, image: null }))
    expect(loading.count("drawImage")).toBe(0)
    expect(loading.props.fillStyle).toContain("rgba(255,255,255,0.05)")
    const none = recordingContext()
    drawScene(none.ctx, scene())
    expect(none.props.fillStyle).toContain("rgba(255,255,255,0.04)")
  })

  it("draws grid lines across the internal space", () => {
    const r = recordingContext()
    drawScene(r.ctx, scene())
    const lineTos = r.calls.filter((c) => c.fn === "lineTo")
    // 17 vertical (0..1024 step 64 within 1000 -> 16) + 8 horizontal lines.
    expect(lineTos.length).toBe(16 + 8)
  })

  it("draws one filled and stroked rect per panel inside a rotated frame", () => {
    const r = recordingContext()
    drawScene(r.ctx, scene({ panels: [PANEL, PANEL], panelWattW: 400 }))
    expect(r.calls.filter((c) => c.fn === "strokeRect")).toHaveLength(2)
    expect(r.calls.find((c) => c.fn === "rotate" && c.args[0] === (15 * Math.PI) / 180)).toBeDefined()
    const texts = r.calls.filter((c) => c.fn === "fillText").map((c) => c.args[0])
    expect(texts).toContain("Panels: 2")
    expect(texts).toContain("DC: 0.8 kW")
  })

  it("draws an open polygon with vertex handles in edit mode, highlighting the hovered one", () => {
    const r = recordingContext()
    drawScene(r.ctx, scene({ vertices: RING, closed: false, hoverIdx: 1 }))
    expect(r.count("closePath")).toBe(0)
    const arcs = r.calls.filter((c) => c.fn === "arc")
    expect(arcs.map((a) => a.args[2])).toEqual([5, 7, 5])
  })

  it("closes and fills a closed polygon, and draws the orientation hint", () => {
    const r = recordingContext()
    drawScene(r.ctx, scene({ vertices: RING, closed: true, orientationDeg: 30 }))
    expect(r.count("closePath")).toBe(1)
    expect(r.props.fillStyle).toContain("rgba(59, 130, 246, 0.08)")
    expect(r.calls.some((c) => c.fn === "rotate" && c.args[0] === (30 * Math.PI) / 180)).toBe(true)
  })

  it("omits vertex handles and the orientation hint for view mode / open rings", () => {
    const r = recordingContext()
    drawScene(r.ctx, scene({ vertices: RING, closed: false, mode: "view", orientationDeg: 30 }))
    expect(r.count("arc")).toBe(0)
    expect(r.calls.some((c) => c.fn === "rotate")).toBe(false)
  })

  it("scales line widths down when zoomed in", () => {
    const r = recordingContext()
    drawScene(r.ctx, scene({ vertices: RING, closed: true, view: { zoom: 4, panX: 0, panY: 0 } }))
    expect(r.props.lineWidth).toContain(0.5)
  })

  it("draws the center pin as a cross", () => {
    const r = recordingContext()
    drawScene(r.ctx, scene({ centerPin: { x: 200, y: 100 } }))
    const moves = r.calls.filter((c) => c.fn === "moveTo").map((c) => c.args)
    expect(moves).toContainEqual([190, 100])
    expect(moves).toContainEqual([200, 90])
  })

  it("draws labelled candidate outlines and skips degenerate ones", () => {
    const r = recordingContext()
    const candidates = [
      { id: "a", polygon: RING },
      { id: "b", polygon: RING.slice(0, 2) },
      { id: "c", polygon: RING },
    ]
    drawScene(r.ctx, scene({ candidates }))
    const labels = r.calls.filter((c) => c.fn === "fillText").map((c) => c.args[0])
    expect(labels).toContain("Option 1")
    expect(labels).toContain("Option 3")
    expect(labels).not.toContain("Option 2")
  })

  it("draws the status box, with a clipped detail for errors only", () => {
    const err = recordingContext()
    drawScene(err.ctx, scene({ status: { title: "Auto-outline failed", tone: "error", detail: "x".repeat(60) } }))
    const texts = err.calls.filter((c) => c.fn === "fillText").map((c) => c.args[0])
    expect(texts).toContain("Auto-outline failed")
    expect(texts).toContain(`${"x".repeat(41)}…`)
    expect(err.calls.find((c) => c.fn === "fillRect" && c.args[1] === 74)?.args[3]).toBe(46)

    const hint = recordingContext()
    drawScene(hint.ctx, scene({ status: { title: "Pick one", tone: "hint", detail: "ignored" } }))
    expect(hint.calls.find((c) => c.fn === "fillRect" && c.args[1] === 74)?.args[3]).toBe(28)
    expect(hint.props.fillStyle).toContain("rgba(245,158,11,0.95)")

    const info = recordingContext()
    drawScene(info.ctx, scene({ status: { title: "Detecting roof", tone: "info" } }))
    expect(info.props.fillStyle).toContain("rgba(255,255,255,0.9)")
  })
})

describe("syncCanvasBackingStore", () => {
  const canvas = () => ({ width: 0, height: 0 }) as HTMLCanvasElement

  it("resizes the backing store by DPR and returns new metrics", () => {
    const c = canvas()
    const next = syncCanvasBackingStore(c, 300.7, 100.2, 2, { width: 0, height: 0, dpr: 1 })
    expect(next).toEqual({ width: 601, height: 200, dpr: 2 })
    expect([c.width, c.height]).toEqual([601, 200])
  })

  it("leaves the canvas alone when nothing changed", () => {
    const c = canvas()
    const last = { width: 600, height: 200, dpr: 2 }
    expect(syncCanvasBackingStore(c, 300, 100, 2, last)).toBe(last)
    expect([c.width, c.height]).toEqual([0, 0])
  })

  it("never produces a zero-sized canvas", () => {
    const c = canvas()
    expect(syncCanvasBackingStore(c, 0, 0, 1, { width: 5, height: 5, dpr: 1 })).toEqual({ width: 1, height: 1, dpr: 1 })
  })
})
