import { DEFAULT_CO2_KG_PER_KWH } from "@/lib/solar-defaults"

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

export function co2KgPerKwh(_lat?: number, _lng?: number) {
  const raw = process.env.CO2_KG_PER_KWH
  const parsed = raw ? Number(raw) : NaN
  if (Number.isFinite(parsed) && parsed > 0) return clamp(parsed, 0.05, 2)
  return DEFAULT_CO2_KG_PER_KWH
}
