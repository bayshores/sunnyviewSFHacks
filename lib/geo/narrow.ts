/** Narrows an unknown value to a plain (non-array) object, or null. */
export function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** Reads `value[key]` when `value` is a plain object; otherwise undefined. */
export function readKey(value: unknown, key: string): unknown {
  return asRecord(value)?.[key]
}
