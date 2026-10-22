import { describe, expect, it } from "vitest"

import { DEFAULT_CO2_KG_PER_KWH, FALLBACK_KWH_PER_KW_YEAR, fallbackAnnualEstimate } from "./solar-defaults"

describe("solar-defaults", () => {
  it("exports the shared constants", () => {
    expect(FALLBACK_KWH_PER_KW_YEAR).toBe(1400)
    expect(DEFAULT_CO2_KG_PER_KWH).toBe(0.4)
  })

  it("computes annual, monthly and CO2 values", () => {
    const out = fallbackAnnualEstimate(5)
    expect(out.annualKwh).toBe(7000)
    expect(out.monthlyKwh).toHaveLength(12)
    expect(out.monthlyKwh.every((m) => Math.abs(m - 7000 / 12) < 1e-9)).toBe(true)
    expect(out.annualCo2Kg).toBeCloseTo(2800)
  })

  it("honours a custom CO2 factor", () => {
    expect(fallbackAnnualEstimate(1, 0.5).annualCo2Kg).toBe(700)
  })

  it("clamps negative and non-finite capacity to zero", () => {
    expect(fallbackAnnualEstimate(-3).annualKwh).toBe(0)
    expect(fallbackAnnualEstimate(Number.NaN).annualKwh).toBe(0)
  })
})
