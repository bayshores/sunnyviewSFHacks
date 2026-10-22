export const MERCATOR_MAX_LAT = 85.05112878

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

/** Parses a query-string style value into a finite number, or null when missing/invalid. */
export function parseNum(value: string | null): number | null {
  if (!value) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** Coerces a number or numeric string into a finite number, or null. */
export function toFiniteNumber(x: unknown): number | null {
  const n = typeof x === "number" ? x : typeof x === "string" ? Number(x) : NaN
  return Number.isFinite(n) ? n : null
}
