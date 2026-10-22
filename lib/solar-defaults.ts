// Pure, client-safe constants and helpers (no process.env, no node imports).

/** Rough annual yield (kWh) per kW of DC capacity, used when PVWatts is unavailable. */
export const FALLBACK_KWH_PER_KW_YEAR = 1400

/** Default grid emissions factor (kg CO2 per kWh). */
export const DEFAULT_CO2_KG_PER_KWH = 0.4

export type FallbackAnnualEstimate = {
  annualKwh: number
  monthlyKwh: number[]
  annualCo2Kg: number
}

export function fallbackAnnualEstimate(
  dcKw: number,
  co2KgPerKwh: number = DEFAULT_CO2_KG_PER_KWH
): FallbackAnnualEstimate {
  const safeKw = Number.isFinite(dcKw) ? Math.max(0, dcKw) : 0
  const annualKwh = safeKw * FALLBACK_KWH_PER_KW_YEAR
  return {
    annualKwh,
    monthlyKwh: Array.from({ length: 12 }, () => annualKwh / 12),
    annualCo2Kg: annualKwh * co2KgPerKwh,
  }
}
