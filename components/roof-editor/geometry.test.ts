import { describe, expect, it } from "vitest"
import {
  bboxOf,
  clamp,
  clampEdgeDelta,
  dist,
  distPointToSegment,
  edgeOutwardNormal,
  edgeResizeCursor,
  insertVertexOnNearestEdge,
  moveEdgeAlongNormal,
  nearestEdge,
  nearestEdgeWithin,
  nearestVertexIdx,
  pointInPolygon,
  removeVertex,
  replaceVertex,
  signedArea2,
  translatePolygonClamped,
} from "./geometry"

// Square drawn clockwise on screen (y down): top-left, top-right, bottom-right, bottom-left.
const SQUARE_CW = [
  { x: 10, y: 10 },
  { x: 30, y: 10 },
  { x: 30, y: 30 },
  { x: 10, y: 30 },
]
const SQUARE_CCW = [...SQUARE_CW].reverse()
const BOUNDS = { w: 100, h: 50 }

function expectVec(v: { x: number; y: number } | null, x: number, y: number): void {
  expect(v).not.toBeNull()
  expect(v?.x).toBeCloseTo(x)
  expect(v?.y).toBeCloseTo(y)
}

describe("clamp / dist", () => {
  it("clamps into range", () => {
    expect(clamp(-1, 0, 10)).toBe(0)
    expect(clamp(11, 0, 10)).toBe(10)
    expect(clamp(5, 0, 10)).toBe(5)
  })

  it("computes euclidean distance", () => {
    expect(dist({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5)
  })
})

describe("distPointToSegment", () => {
  const a = { x: 0, y: 0 }
  const b = { x: 10, y: 0 }

  it("projects onto the segment interior", () => {
    expect(distPointToSegment({ x: 4, y: 3 }, a, b)).toEqual({ x: 4, y: 0, t: 0.4, d: 3 })
  })

  it("clamps to the endpoints", () => {
    expect(distPointToSegment({ x: -3, y: 4 }, a, b)).toMatchObject({ x: 0, y: 0, t: 0, d: 5 })
    expect(distPointToSegment({ x: 13, y: 4 }, a, b)).toMatchObject({ x: 10, y: 0, t: 1, d: 5 })
  })

  it("handles a degenerate segment", () => {
    expect(distPointToSegment({ x: 3, y: 4 }, a, a)).toMatchObject({ t: 0, d: 5 })
  })
})

describe("nearestVertexIdx", () => {
  it("returns the closest vertex inside the radius", () => {
    expect(nearestVertexIdx({ x: 29, y: 11 }, SQUARE_CW, 5)).toBe(1)
  })

  it("includes vertices exactly on the radius", () => {
    expect(nearestVertexIdx({ x: 10, y: -2 }, SQUARE_CW, 12)).toBe(0)
  })

  it("returns null outside the radius or with no vertices", () => {
    expect(nearestVertexIdx({ x: 20, y: 20 }, SQUARE_CW, 5)).toBeNull()
    expect(nearestVertexIdx({ x: 0, y: 0 }, [], 100)).toBeNull()
  })

  it("prefers the closer of two vertices within radius", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
    ]
    expect(nearestVertexIdx({ x: 3, y: 0 }, pts, 10)).toBe(1)
  })
})

describe("nearestEdge / nearestEdgeWithin", () => {
  it("finds the closest edge, including the closing edge", () => {
    expect(nearestEdge({ x: 20, y: 8 }, SQUARE_CW)).toEqual({ idx: 0, d: 2 })
    expect(nearestEdge({ x: 8, y: 20 }, SQUARE_CW)).toEqual({ idx: 3, d: 2 })
  })

  it("returns null for fewer than two vertices", () => {
    expect(nearestEdge({ x: 0, y: 0 }, [{ x: 1, y: 1 }])).toBeNull()
  })

  it("respects the hit radius", () => {
    expect(nearestEdgeWithin({ x: 20, y: 8 }, SQUARE_CW, 2)).toBe(0)
    expect(nearestEdgeWithin({ x: 20, y: 8 }, SQUARE_CW, 1.9)).toBeNull()
  })
})

describe("pointInPolygon", () => {
  it("detects inside and outside points", () => {
    expect(pointInPolygon({ x: 20, y: 20 }, SQUARE_CW)).toBe(true)
    expect(pointInPolygon({ x: 40, y: 20 }, SQUARE_CW)).toBe(false)
    expect(pointInPolygon({ x: 20, y: 20 }, SQUARE_CCW)).toBe(true)
  })

  it("handles concave polygons", () => {
    const lShape = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 10 },
      { x: 10, y: 10 },
      { x: 10, y: 20 },
      { x: 0, y: 20 },
    ]
    expect(pointInPolygon({ x: 5, y: 15 }, lShape)).toBe(true)
    expect(pointInPolygon({ x: 15, y: 15 }, lShape)).toBe(false)
  })

  it("is false for an empty polygon", () => {
    expect(pointInPolygon({ x: 0, y: 0 }, [])).toBe(false)
  })
})

describe("bboxOf", () => {
  it("computes the bounding box", () => {
    expect(bboxOf(SQUARE_CW)).toEqual({ minX: 10, minY: 10, maxX: 30, maxY: 30 })
  })
})

describe("signedArea2 / edgeOutwardNormal", () => {
  it("is positive for screen-clockwise winding and negative for counter-clockwise", () => {
    expect(signedArea2(SQUARE_CW)).toBe(800)
    expect(signedArea2(SQUARE_CCW)).toBe(-800)
  })

  it("points outward for clockwise winding", () => {
    expectVec(edgeOutwardNormal(SQUARE_CW, 0), 0, -1) // top edge
    expectVec(edgeOutwardNormal(SQUARE_CW, 1), 1, 0) // right edge
    expectVec(edgeOutwardNormal(SQUARE_CW, 2), 0, 1) // bottom edge
    expectVec(edgeOutwardNormal(SQUARE_CW, 3), -1, 0) // left edge (closing)
  })

  it("points outward for counter-clockwise winding", () => {
    // CCW order: BL(10,30) -> BR(30,30) -> TR(30,10) -> TL(10,10)
    expectVec(edgeOutwardNormal(SQUARE_CCW, 0), 0, 1) // bottom edge
    expectVec(edgeOutwardNormal(SQUARE_CCW, 1), 1, 0) // right edge
    expectVec(edgeOutwardNormal(SQUARE_CCW, 2), 0, -1) // top edge
    expectVec(edgeOutwardNormal(SQUARE_CCW, 3), -1, 0) // left edge (closing)
  })

  it("returns a unit vector for slanted edges", () => {
    const tri = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]
    // Interior (0,10) is below-left of the diagonal; outward is up-right.
    expectVec(edgeOutwardNormal(tri, 0), Math.SQRT1_2, -Math.SQRT1_2)
  })

  it("returns null for degenerate edges", () => {
    const pts = [
      { x: 5, y: 5 },
      { x: 5, y: 5 },
      { x: 9, y: 9 },
    ]
    expect(edgeOutwardNormal(pts, 0)).toBeNull()
    expect(edgeOutwardNormal([{ x: 0, y: 0 }], 0)).toBeNull()
  })
})

describe("clampEdgeDelta", () => {
  it("passes through deltas that stay in bounds", () => {
    expect(clampEdgeDelta(5, { x: 10, y: 10 }, { x: 30, y: 10 }, { x: 0, y: -1 }, BOUNDS)).toBe(5)
  })

  it("clamps so both endpoints stay within bounds", () => {
    const a = { x: 10, y: 10 }
    const b = { x: 30, y: 10 }
    const up = { x: 0, y: -1 }
    expect(clampEdgeDelta(50, a, b, up, BOUNDS)).toBe(10)
    expect(clampEdgeDelta(-100, a, b, up, BOUNDS)).toBe(-40)
  })

  it("uses the tightest endpoint for slanted normals", () => {
    const s = Math.SQRT1_2
    const normal = { x: s, y: s }
    const a = { x: 90, y: 10 }
    const b = { x: 60, y: 40 }
    const delta = clampEdgeDelta(1000, a, b, normal, BOUNDS)
    const moved = [a, b].map((p) => ({ x: p.x + normal.x * delta, y: p.y + normal.y * delta }))
    for (const p of moved) {
      expect(p.x).toBeGreaterThanOrEqual(-1e-9)
      expect(p.x).toBeLessThanOrEqual(BOUNDS.w + 1e-9)
      expect(p.y).toBeGreaterThanOrEqual(-1e-9)
      expect(p.y).toBeLessThanOrEqual(BOUNDS.h + 1e-9)
    }
    // a reaches the right edge and b the bottom edge at the same delta: 10 / sin(45deg)
    expect(delta).toBeCloseTo(10 / s)
  })

  it("leaves delta unchanged when an endpoint is already outside on a zero normal axis", () => {
    expect(clampEdgeDelta(7, { x: -5, y: 10 }, { x: 20, y: 10 }, { x: 0, y: 1 }, BOUNDS)).toBe(7)
  })
})

describe("moveEdgeAlongNormal", () => {
  it("moves only the edge endpoints and does not mutate input", () => {
    const input = SQUARE_CW.map((v) => ({ ...v }))
    const next = moveEdgeAlongNormal(input, 1, { x: 1, y: 0 }, 5, BOUNDS)
    expect(next).toEqual([
      { x: 10, y: 10 },
      { x: 35, y: 10 },
      { x: 35, y: 30 },
      { x: 10, y: 30 },
    ])
    expect(input).toEqual(SQUARE_CW)
  })

  it("moves the closing edge (last -> first)", () => {
    const next = moveEdgeAlongNormal(SQUARE_CW, 3, { x: -1, y: 0 }, 100, BOUNDS)
    expect(next[3]).toEqual({ x: 0, y: 30 })
    expect(next[0]).toEqual({ x: 0, y: 10 })
    expect(next[1]).toEqual({ x: 30, y: 10 })
  })

  it("keeps both endpoints in bounds", () => {
    const next = moveEdgeAlongNormal(SQUARE_CW, 2, { x: 0, y: 1 }, 999, BOUNDS)
    expect(next[2].y).toBe(50)
    expect(next[3].y).toBe(50)
  })
})

describe("translatePolygonClamped", () => {
  it("translates freely inside bounds", () => {
    expect(translatePolygonClamped(SQUARE_CW, 5, -3, BOUNDS)[0]).toEqual({ x: 15, y: 7 })
  })

  it("clamps the bbox to the bounds on every side", () => {
    const right = translatePolygonClamped(SQUARE_CW, 500, 500, BOUNDS)
    expect(bboxOf(right)).toEqual({ minX: 80, minY: 30, maxX: 100, maxY: 50 })
    const left = translatePolygonClamped(SQUARE_CW, -500, -500, BOUNDS)
    expect(bboxOf(left)).toEqual({ minX: 0, minY: 0, maxX: 20, maxY: 20 })
  })
})

describe("insertVertexOnNearestEdge", () => {
  it("inserts between the endpoints of the nearest edge", () => {
    const next = insertVertexOnNearestEdge(SQUARE_CW, { x: 31, y: 20 })
    expect(next).toHaveLength(5)
    expect(next[2]).toEqual({ x: 31, y: 20 })
    expect(next[1]).toEqual(SQUARE_CW[1])
    expect(next[3]).toEqual(SQUARE_CW[2])
  })

  it("appends at the end when the closing edge is nearest (wrap-around)", () => {
    const next = insertVertexOnNearestEdge(SQUARE_CW, { x: 9, y: 20 })
    expect(next).toEqual([...SQUARE_CW, { x: 9, y: 20 }])
  })

  it("appends when there are fewer than two vertices", () => {
    expect(insertVertexOnNearestEdge([{ x: 1, y: 1 }], { x: 2, y: 2 })).toEqual([
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ])
  })
})

describe("replaceVertex / removeVertex", () => {
  it("replaces one vertex immutably", () => {
    const next = replaceVertex(SQUARE_CW, 2, { x: 1, y: 2 })
    expect(next[2]).toEqual({ x: 1, y: 2 })
    expect(SQUARE_CW[2]).toEqual({ x: 30, y: 30 })
  })

  it("removes one vertex immutably", () => {
    const next = removeVertex(SQUARE_CW, 0)
    expect(next).toEqual(SQUARE_CW.slice(1))
    expect(SQUARE_CW).toHaveLength(4)
  })
})

describe("edgeResizeCursor", () => {
  it("maps edge direction to a resize cursor", () => {
    expect(edgeResizeCursor({ x: 0, y: 0 }, { x: 10, y: 0 })).toBe("ns-resize")
    expect(edgeResizeCursor({ x: 0, y: 0 }, { x: 0, y: 10 })).toBe("ew-resize")
    expect(edgeResizeCursor({ x: 0, y: 0 }, { x: 10, y: 10 })).toBe("nesw-resize")
    expect(edgeResizeCursor({ x: 0, y: 0 }, { x: 10, y: -10 })).toBe("nwse-resize")
  })
})
