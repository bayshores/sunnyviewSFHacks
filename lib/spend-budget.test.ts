import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { readDailyBudget, spendBudgetResponse, takeSpendBudget } from "@/lib/spend-budget"

const DAY1 = Date.parse("2026-03-01T10:00:00Z")
const DAY2 = Date.parse("2026-03-02T00:00:01Z")

beforeEach(() => {
  delete (globalThis as unknown as { __sunnyviewSpendBudget?: unknown }).__sunnyviewSpendBudget
})
afterEach(() => vi.unstubAllEnvs())

describe("spend-budget", () => {
  it("uses defaults for missing or invalid env values", () => {
    expect(readDailyBudget("tts", {} as NodeJS.ProcessEnv)).toBe(500)
    expect(readDailyBudget("gemini", {} as NodeJS.ProcessEnv)).toBe(1000)
    expect(readDailyBudget("tts", { TTS_DAILY_BUDGET: "abc" } as unknown as NodeJS.ProcessEnv)).toBe(500)
    expect(readDailyBudget("tts", { TTS_DAILY_BUDGET: "-5" } as unknown as NodeJS.ProcessEnv)).toBe(500)
    expect(readDailyBudget("gemini", { GEMINI_DAILY_BUDGET: "7" } as unknown as NodeJS.ProcessEnv)).toBe(7)
  })

  it("allows up to the budget globally, then blocks with time until UTC midnight", () => {
    vi.stubEnv("TTS_DAILY_BUDGET", "2")
    expect(takeSpendBudget("tts", DAY1).ok).toBe(true)
    expect(takeSpendBudget("tts", DAY1).ok).toBe(true)
    const blocked = takeSpendBudget("tts", DAY1)
    expect(blocked.ok).toBe(false)
    expect(blocked.retryAfterSec).toBe(14 * 3600)
  })

  it("keeps scopes independent and resets on a new UTC day", () => {
    vi.stubEnv("TTS_DAILY_BUDGET", "1")
    vi.stubEnv("GEMINI_DAILY_BUDGET", "1")
    expect(takeSpendBudget("tts", DAY1).ok).toBe(true)
    expect(takeSpendBudget("tts", DAY1).ok).toBe(false)
    expect(takeSpendBudget("gemini", DAY1).ok).toBe(true)
    expect(takeSpendBudget("tts", DAY2).ok).toBe(true)
  })

  it("supports a zero budget and builds a 429 response", async () => {
    vi.stubEnv("TTS_DAILY_BUDGET", "0")
    expect(takeSpendBudget("tts", DAY1).ok).toBe(false)
    const res = spendBudgetResponse(30, "nope")
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBe("30")
    expect(await res.json()).toEqual({ error: "nope" })
  })
})
