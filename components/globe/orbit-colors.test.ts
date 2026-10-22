import { describe, expect, it } from "vitest"
import {
  normalizeHue,
  normalizeOrbitSaturation,
  ORBIT_HEAD_ALPHA,
  ORBIT_LIGHTNESS,
  ORBIT_TRAIL_CORE_ALPHA,
  ORBIT_TRAIL_GLOW_ALPHA,
  orbitAccentColors,
} from "./orbit-colors"

type FakeColor = {
  h: number
  s: number
  l: number
  alpha: number
  withAlpha(alpha: number): FakeColor
}

function fakeColor(h: number, s: number, l: number, alpha = 1): FakeColor {
  return {
    h,
    s,
    l,
    alpha,
    withAlpha: (nextAlpha: number) => fakeColor(h, s, l, nextAlpha),
  }
}

function fakeCesium() {
  const calls: Array<[number, number, number]> = []
  return {
    calls,
    Color: {
      fromHsl(h: number, s: number, l: number) {
        calls.push([h, s, l])
        return fakeColor(h, s, l)
      },
    },
  }
}

describe("normalizeHue", () => {
  it("maps degrees into [0, 1)", () => {
    expect(normalizeHue(0)).toBe(0)
    expect(normalizeHue(90)).toBeCloseTo(0.25)
    expect(normalizeHue(180)).toBeCloseTo(0.5)
  })

  it("wraps hues at and above 360", () => {
    expect(normalizeHue(360)).toBe(0)
    expect(normalizeHue(450)).toBeCloseTo(0.25)
    expect(normalizeHue(720 + 36)).toBeCloseTo(0.1)
  })

  it("wraps negative hues", () => {
    expect(normalizeHue(-90)).toBeCloseTo(0.75)
    expect(normalizeHue(-360)).toBe(0)
    expect(normalizeHue(-450)).toBeCloseTo(0.75)
  })
})

describe("normalizeOrbitSaturation", () => {
  it("amplifies saturation by 3.6", () => {
    expect(normalizeOrbitSaturation(0.1)).toBeCloseTo(0.36)
    expect(normalizeOrbitSaturation(0.25)).toBeCloseTo(0.9)
  })

  it("clamps into [0, 1]", () => {
    expect(normalizeOrbitSaturation(0.5)).toBe(1)
    expect(normalizeOrbitSaturation(10)).toBe(1)
    expect(normalizeOrbitSaturation(-0.2)).toBe(0)
    expect(normalizeOrbitSaturation(0)).toBe(0)
  })
})

describe("orbitAccentColors", () => {
  it("builds the accent from normalised hue/saturation at fixed lightness", () => {
    const Cesium = fakeCesium()
    orbitAccentColors(Cesium, -90, 0.1)
    expect(Cesium.calls).toHaveLength(1)
    const [h, s, l] = Cesium.calls[0]
    expect(h).toBeCloseTo(0.75)
    expect(s).toBeCloseTo(0.36)
    expect(l).toBe(ORBIT_LIGHTNESS)
  })

  it("returns head / trail core / trail glow with the expected alphas", () => {
    const { headColor, trailCoreColor, trailGlowColor } = orbitAccentColors(fakeCesium(), 200, 0.2)
    expect(headColor.alpha).toBe(0.98)
    expect(trailCoreColor.alpha).toBe(0.46)
    expect(trailGlowColor.alpha).toBe(0.16)
    expect([ORBIT_HEAD_ALPHA, ORBIT_TRAIL_CORE_ALPHA, ORBIT_TRAIL_GLOW_ALPHA]).toEqual([0.98, 0.46, 0.16])
  })

  it("derives every colour from the same accent", () => {
    const { headColor, trailCoreColor, trailGlowColor } = orbitAccentColors(fakeCesium(), 400, 1)
    for (const color of [headColor, trailCoreColor, trailGlowColor]) {
      expect(color.h).toBeCloseTo(40 / 360)
      expect(color.s).toBe(1)
      expect(color.l).toBe(ORBIT_LIGHTNESS)
    }
  })
})
