import { afterEach, describe, expect, it, vi } from "vitest"

import { co2KgPerKwh } from "@/lib/co2"
import { PANEL_OPTIONS } from "@/lib/panels"
import { STATIC_MAP_H_PX, STATIC_MAP_SCALE, STATIC_MAP_W_PX, buildStaticMapSpec } from "@/lib/static-map"
import { cn } from "@/lib/utils"
import { DEFAULT_CO2_KG_PER_KWH } from "@/lib/solar-defaults"

afterEach(() => vi.unstubAllEnvs())

describe("co2KgPerKwh", () => {
  it("uses the default for missing/invalid/non-positive env", () => {
    for (const v of ["", "abc", "0", "-1"]) {
      vi.stubEnv("CO2_KG_PER_KWH", v)
      expect(co2KgPerKwh()).toBe(DEFAULT_CO2_KG_PER_KWH)
    }
  })
  it("uses and clamps the override to [0.05, 2]", () => {
    vi.stubEnv("CO2_KG_PER_KWH", "0.5")
    expect(co2KgPerKwh(1, 2)).toBe(0.5)
    vi.stubEnv("CO2_KG_PER_KWH", "0.001")
    expect(co2KgPerKwh()).toBe(0.05)
    vi.stubEnv("CO2_KG_PER_KWH", "50")
    expect(co2KgPerKwh()).toBe(2)
  })
})

describe("PANEL_OPTIONS", () => {
  it("has unique ids, positive dimensions, and source URLs", () => {
    expect(PANEL_OPTIONS.length).toBeGreaterThan(0)
    expect(new Set(PANEL_OPTIONS.map((p) => p.id)).size).toBe(PANEL_OPTIONS.length)
    for (const p of PANEL_OPTIONS) {
      expect(p.spec.widthM).toBeGreaterThan(0)
      expect(p.spec.heightM).toBeGreaterThan(0)
      expect(p.spec.wattW).toBeGreaterThan(0)
      expect(p.sourceUrl).toMatch(/^https:\/\//)
    }
  })
})

describe("buildStaticMapSpec", () => {
  it("applies defaults", () => {
    const s = buildStaticMapSpec({ lat: 1, lng: 2 })
    expect(s.meta.zoom).toBe(19)
    expect(s.widthPx).toBe(STATIC_MAP_W_PX * STATIC_MAP_SCALE)
    expect(s.heightPx).toBe(STATIC_MAP_H_PX * STATIC_MAP_SCALE)
    expect(s.src).toBe("/api/static-map?lat=1&lng=2&zoom=19&w=520&h=360&scale=2")
  })
  it("rounds provided values and ignores NaN/null", () => {
    const s = buildStaticMapSpec({ lat: 1, lng: 2, zoom: 17.6, w: 100.4, h: 50.5, scale: 1 })
    expect(s.meta).toMatchObject({ zoom: 18, widthPx: 100, heightPx: 51, staticMap: { w: 100, h: 51, scale: 1 } })
    expect(buildStaticMapSpec({ lat: 1, lng: 2, zoom: null, w: NaN }).meta.zoom).toBe(19)
  })
})

describe("cn", () => {
  it("merges and dedupes tailwind classes", () => {
    expect(cn("p-2", false && "x", "p-4", ["m-1"])).toBe("p-4 m-1")
  })
})
