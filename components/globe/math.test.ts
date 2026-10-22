import { describe, expect, it } from "vitest"
import {
  advanceTrail,
  CENTER_SPIN,
  centerSpinProgress,
  centerSpinVelocity,
  formatLocationLabel,
  frameDeltaSeconds,
  hasFiniteLocation,
  isFiniteCartesian3,
  MAX_FRAME_DT_SECONDS,
  orbitHeadScale,
  orbitPointComponents,
  orbitSecondaryHeadScale,
  shouldSkipFrame,
} from "./math"

const v = (x: number, y: number, z: number) => ({ x, y, z })

describe("isFiniteCartesian3", () => {
  it("accepts finite vectors", () => {
    expect(isFiniteCartesian3(v(0, 0, 0))).toBe(true)
    expect(isFiniteCartesian3(v(-6378137, 1.5, 1e-12))).toBe(true)
  })

  it("rejects NaN and infinite components", () => {
    expect(isFiniteCartesian3(v(NaN, 0, 0))).toBe(false)
    expect(isFiniteCartesian3(v(0, Infinity, 0))).toBe(false)
    expect(isFiniteCartesian3(v(0, 0, -Infinity))).toBe(false)
  })
})

describe("frameDeltaSeconds", () => {
  it("converts ms to seconds", () => {
    expect(frameDeltaSeconds(1016, 1000)).toBeCloseTo(0.016)
  })

  it("is zero on the first frame (lastNow === now)", () => {
    expect(frameDeltaSeconds(500, 500)).toBe(0)
  })

  it("clamps long gaps to MAX_FRAME_DT_SECONDS", () => {
    expect(frameDeltaSeconds(10_000, 0)).toBe(MAX_FRAME_DT_SECONDS)
    expect(MAX_FRAME_DT_SECONDS).toBe(0.05)
  })
})

describe("shouldSkipFrame", () => {
  it("never skips the first frame", () => {
    expect(shouldSkipFrame(0, null, 40)).toBe(false)
  })

  it("skips frames inside the interval and draws once it has elapsed", () => {
    expect(shouldSkipFrame(1030, 1000, 40)).toBe(true)
    expect(shouldSkipFrame(1040, 1000, 40)).toBe(false)
    expect(shouldSkipFrame(1100, 1000, 40)).toBe(false)
  })
})

describe("orbitPointComponents", () => {
  const u = v(1, 0, 0)
  const w = v(0, 1, 0)

  it("returns radius * u at angle 0", () => {
    expect(orbitPointComponents(u, w, 0, 10)).toEqual(v(10, 0, 0))
  })

  it("returns radius * v at angle PI/2", () => {
    const p = orbitPointComponents(u, w, Math.PI / 2, 10)
    expect(p.x).toBeCloseTo(0)
    expect(p.y).toBeCloseTo(10)
    expect(p.z).toBe(0)
  })

  it("stays on the circle of the given radius", () => {
    const p = orbitPointComponents(u, w, 1.234, 7)
    expect(Math.hypot(p.x, p.y, p.z)).toBeCloseTo(7)
  })
})

describe("advanceTrail", () => {
  it("prepends the head and carries previous points", () => {
    const prev = [v(1, 1, 1), v(2, 2, 2)]
    const head = v(0, 0, 0)
    expect(advanceTrail(prev, head, 36)).toEqual([head, prev[0], prev[1]])
  })

  it("caps the trail at maxPoints, dropping the oldest", () => {
    const prev = [v(1, 0, 0), v(2, 0, 0), v(3, 0, 0)]
    const next = advanceTrail(prev, v(0, 0, 0), 3)
    expect(next).toEqual([v(0, 0, 0), v(1, 0, 0), v(2, 0, 0)])
  })

  it("always yields at least two points", () => {
    const head = v(5, 5, 5)
    expect(advanceTrail([], head, 36)).toEqual([head, head])
  })

  it("returns null when a carried point is not finite", () => {
    expect(advanceTrail([v(1, 1, 1), v(NaN, 0, 0)], v(0, 0, 0), 36)).toBeNull()
  })

  it("ignores non-finite points beyond the carry window", () => {
    const next = advanceTrail([v(1, 1, 1), v(NaN, 0, 0)], v(0, 0, 0), 2)
    expect(next).toEqual([v(0, 0, 0), v(1, 1, 1)])
  })

  it("does not mutate the previous trail", () => {
    const prev = [v(1, 1, 1)]
    advanceTrail(prev, v(0, 0, 0), 36)
    expect(prev).toEqual([v(1, 1, 1)])
  })
})

describe("orbit head scale pulse", () => {
  it("oscillates around the base scale within its amplitude", () => {
    for (const now of [0, 123, 4567, 98765]) {
      expect(Math.abs(orbitHeadScale(now) - 0.76)).toBeLessThanOrEqual(0.08 + 1e-12)
      expect(Math.abs(orbitSecondaryHeadScale(now) - 0.68)).toBeLessThanOrEqual(0.06 + 1e-12)
    }
    expect(orbitHeadScale(0)).toBe(0.76)
  })
})

describe("center spin easing", () => {
  it("starts after the delay and finishes after the duration", () => {
    expect(centerSpinProgress(CENTER_SPIN.delayMs)).toBe(0)
    expect(centerSpinProgress(CENTER_SPIN.delayMs + CENTER_SPIN.durationMs / 2)).toBeCloseTo(0.5)
    expect(centerSpinProgress(CENTER_SPIN.delayMs + CENTER_SPIN.durationMs)).toBe(1)
    expect(centerSpinProgress(1e9)).toBe(1)
  })

  it("uses a sine velocity profile peaking mid-spin", () => {
    expect(centerSpinVelocity(0)).toBe(0)
    expect(centerSpinVelocity(0.5)).toBeCloseTo(CENTER_SPIN.maxRadPerSec)
    expect(centerSpinVelocity(1)).toBeCloseTo(0)
  })
})

describe("location helpers", () => {
  it("detects finite coordinates", () => {
    expect(hasFiniteLocation(37.37, -122.03)).toBe(true)
    expect(hasFiniteLocation(null, -122.03)).toBe(false)
    expect(hasFiniteLocation(37.37, null)).toBe(false)
    expect(hasFiniteLocation(NaN, 0)).toBe(false)
  })

  it("formats a 5-decimal label or a placeholder", () => {
    expect(formatLocationLabel(37.368831, -122.036349)).toBe("37.36883, -122.03635")
    expect(formatLocationLabel(null, null)).toBe("No location yet")
    expect(formatLocationLabel(Infinity, 1)).toBe("No location yet")
  })
})
