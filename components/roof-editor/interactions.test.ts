import { describe, expect, it } from "vitest"
import {
  EDGE_HIT_PX,
  TRIPLE_CLICK_WINDOW_MS,
  VERTEX_DOUBLE_CLICK_HIT_PX,
  VERTEX_HIT_PX,
  exceedsMoveThreshold,
  nextClickStreak,
  resolveDoubleClick,
  resolveHover,
  resolvePointerDown,
} from "./interactions"
import type { PointerDownInput } from "./interactions"
import type { CandidatePolygon } from "./types"

const SQUARE = [
  { x: 100, y: 100 },
  { x: 300, y: 100 },
  { x: 300, y: 300 },
  { x: 100, y: 300 },
]
const CANDIDATES: CandidatePolygon[] = [
  {
    id: "far",
    polygon: [
      { x: 400, y: 400 },
      { x: 500, y: 400 },
      { x: 500, y: 500 },
      { x: 400, y: 500 },
    ],
  },
  {
    id: "overlap",
    polygon: [
      { x: 150, y: 150 },
      { x: 250, y: 150 },
      { x: 250, y: 250 },
      { x: 150, y: 250 },
    ],
  },
]

function downInput(overrides: Partial<PointerDownInput>): PointerDownInput {
  return {
    point: { x: 0, y: 0 },
    scale: 1,
    vertices: SQUARE,
    closed: true,
    candidates: null,
    canPickCandidate: false,
    ...overrides,
  }
}

describe("resolvePointerDown", () => {
  it("grabs a vertex within the screen-space hit radius", () => {
    expect(resolvePointerDown(downInput({ point: { x: 100 + VERTEX_HIT_PX, y: 100 } }))).toEqual({
      kind: "vertex",
      idx: 0,
    })
  })

  it("scales hit radius by the effective zoom", () => {
    // At scale 2 the 12px radius covers only 6 internal units.
    const res = resolvePointerDown(downInput({ point: { x: 108, y: 100 }, scale: 2 }))
    expect(res.kind).not.toBe("vertex")
  })

  it("grabs an edge with its outward normal on a closed ring", () => {
    const res = resolvePointerDown(downInput({ point: { x: 200, y: 100 - EDGE_HIT_PX } }))
    expect(res.kind).toBe("edge")
    if (res.kind === "edge") {
      expect(res.idx).toBe(0)
      expect(res.normal.x).toBeCloseTo(0)
      expect(res.normal.y).toBeCloseTo(-1)
    }
  })

  it("does not grab edges on an open ring", () => {
    const res = resolvePointerDown(downInput({ point: { x: 200, y: 101 }, closed: false }))
    expect(res).toEqual({ kind: "pan" })
  })

  it("prefers a candidate outline over dragging the polygon when picking is enabled", () => {
    const point = { x: 200, y: 200 }
    expect(resolvePointerDown(downInput({ point, candidates: CANDIDATES, canPickCandidate: true }))).toEqual({
      kind: "candidate",
      id: "overlap",
    })
    expect(resolvePointerDown(downInput({ point, candidates: CANDIDATES, canPickCandidate: false }))).toEqual({
      kind: "polygon",
    })
  })

  it("drags the whole polygon from inside a closed ring and pans outside it", () => {
    expect(resolvePointerDown(downInput({ point: { x: 200, y: 200 } }))).toEqual({ kind: "polygon" })
    expect(resolvePointerDown(downInput({ point: { x: 600, y: 600 } }))).toEqual({ kind: "pan" })
  })

  it("pans when there are no vertices", () => {
    expect(resolvePointerDown(downInput({ point: { x: 1, y: 1 }, vertices: [] }))).toEqual({ kind: "pan" })
  })
})

describe("resolveHover", () => {
  const base = { scale: 1, vertices: SQUARE, closed: true, mode: "edit" as const, draggingIdx: null }

  it("hovers a vertex and suppresses edge hover", () => {
    expect(resolveHover({ ...base, point: { x: 102, y: 101 } })).toEqual({ vertex: 0, edge: null })
  })

  it("hovers an edge when no vertex is near", () => {
    expect(resolveHover({ ...base, point: { x: 305, y: 200 } })).toEqual({ vertex: null, edge: 1 })
  })

  it("does not hover edges while dragging a vertex or on an open ring", () => {
    expect(resolveHover({ ...base, point: { x: 305, y: 200 }, draggingIdx: 2 }).edge).toBeNull()
    expect(resolveHover({ ...base, point: { x: 305, y: 200 }, closed: false }).edge).toBeNull()
  })

  it("never hovers in view mode", () => {
    expect(resolveHover({ ...base, point: { x: 100, y: 100 }, mode: "view" })).toEqual({ vertex: null, edge: null })
  })
})

describe("resolveDoubleClick", () => {
  it("adds a point to an open ring", () => {
    const res = resolveDoubleClick(downInput({ point: { x: 50, y: 60 }, vertices: [{ x: 0, y: 0 }], closed: false }))
    expect(res).toEqual({
      kind: "set-vertices",
      vertices: [
        { x: 0, y: 0 },
        { x: 50, y: 60 },
      ],
    })
  })

  it("closes the ring when double-clicking the first vertex with >= 3 points", () => {
    const res = resolveDoubleClick(
      downInput({ point: { x: 100 + VERTEX_DOUBLE_CLICK_HIT_PX, y: 100 }, closed: false })
    )
    expect(res).toEqual({ kind: "close" })
  })

  it("ignores double-clicks on other vertices or on the first vertex of a short ring", () => {
    expect(resolveDoubleClick(downInput({ point: { x: 300, y: 300 }, closed: false }))).toEqual({ kind: "none" })
    expect(
      resolveDoubleClick(downInput({ point: { x: 100, y: 100 }, vertices: SQUARE.slice(0, 2), closed: false }))
    ).toEqual({ kind: "none" })
    expect(resolveDoubleClick(downInput({ point: { x: 100, y: 100 } }))).toEqual({ kind: "none" })
  })

  it("picks a candidate when enabled", () => {
    expect(
      resolveDoubleClick(downInput({ point: { x: 450, y: 450 }, candidates: CANDIDATES, canPickCandidate: true }))
    ).toEqual({ kind: "pick", id: "far" })
  })

  it("inserts on the nearest edge of a closed ring", () => {
    const res = resolveDoubleClick(downInput({ point: { x: 200, y: 290 } }))
    expect(res.kind).toBe("set-vertices")
    if (res.kind === "set-vertices") {
      expect(res.vertices).toHaveLength(5)
      expect(res.vertices[3]).toEqual({ x: 200, y: 290 })
    }
  })

  it("appends when inserting on the closing edge", () => {
    const res = resolveDoubleClick(downInput({ point: { x: 110, y: 200 } }))
    expect(res).toEqual({ kind: "set-vertices", vertices: [...SQUARE, { x: 110, y: 200 }] })
  })
})

describe("nextClickStreak", () => {
  it("counts consecutive clicks on the same vertex within the window", () => {
    const first = nextClickStreak(null, 2, 1000)
    const second = nextClickStreak(first, 2, 1300)
    const third = nextClickStreak(second, 2, 1600)
    expect([first.count, second.count, third.count]).toEqual([1, 2, 3])
  })

  it("resets on a different vertex or after the window", () => {
    const first = nextClickStreak(null, 2, 1000)
    expect(nextClickStreak(first, 3, 1100).count).toBe(1)
    expect(nextClickStreak(first, 2, 1000 + TRIPLE_CLICK_WINDOW_MS).count).toBe(1)
  })
})

describe("exceedsMoveThreshold", () => {
  it("treats movement over 3px as a drag", () => {
    expect(exceedsMoveThreshold(3, 0)).toBe(false)
    expect(exceedsMoveThreshold(3, 0.1)).toBe(true)
  })
})
