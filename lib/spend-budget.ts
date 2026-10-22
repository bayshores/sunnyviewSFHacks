// Global (not per-IP) in-memory daily request budget for usage billed to
// server-side API keys. Per-instance on serverless, so it is a best-effort
// brake against runaway spend, not an exact quota. Resets at 00:00 UTC.

export type SpendScope = "tts" | "gemini"

type BudgetState = { day: string; count: number }

const BUDGET_ENV: Record<SpendScope, string> = {
  tts: "TTS_DAILY_BUDGET",
  gemini: "GEMINI_DAILY_BUDGET",
}

const DEFAULT_DAILY_BUDGET: Record<SpendScope, number> = {
  tts: 500,
  gemini: 1000,
}

export type SpendBudgetResult = { ok: boolean; retryAfterSec: number }

function states() {
  const g = globalThis as unknown as { __sunnyviewSpendBudget?: Map<SpendScope, BudgetState> }
  if (!g.__sunnyviewSpendBudget) g.__sunnyviewSpendBudget = new Map()
  return g.__sunnyviewSpendBudget
}

export function readDailyBudget(scope: SpendScope, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[BUDGET_ENV[scope]]?.trim()
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_DAILY_BUDGET[scope]
  return Number(raw)
}

/** Consumes one unit of the day's budget for `scope`; ok=false when exhausted. */
export function takeSpendBudget(scope: SpendScope, now: number = Date.now()): SpendBudgetResult {
  const day = new Date(now).toISOString().slice(0, 10)
  const map = states()
  const existing = map.get(scope)
  const state: BudgetState = existing && existing.day === day ? existing : { day, count: 0 }

  if (state.count >= readDailyBudget(scope)) {
    map.set(scope, state)
    const nextMidnight = Date.parse(`${day}T00:00:00.000Z`) + 86_400_000
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((nextMidnight - now) / 1000)) }
  }
  map.set(scope, { day, count: state.count + 1 })
  return { ok: true, retryAfterSec: 0 }
}

export function spendBudgetResponse(retryAfterSec: number, message: string): Response {
  return Response.json({ error: message }, { status: 429, headers: { "retry-after": String(retryAfterSec) } })
}
