import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { requestClientKey, takeRateLimitToken } from "./rate-limit"

function reset() {
  delete (globalThis as unknown as { __sunnyviewRateLimitBuckets?: unknown }).__sunnyviewRateLimitBuckets
}

describe("takeRateLimitToken", () => {
  beforeEach(() => {
    reset()
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
  })
  afterEach(() => {
    vi.useRealTimers()
    reset()
  })

  it("allows up to the limit then blocks with retryAfterSec", () => {
    const opts = { key: "k", limit: 2, windowMs: 60_000 }
    expect(takeRateLimitToken(opts)).toEqual({ ok: true, retryAfterSec: 0 })
    expect(takeRateLimitToken(opts).ok).toBe(true)
    vi.advanceTimersByTime(10_500)
    const blocked = takeRateLimitToken(opts)
    expect(blocked.ok).toBe(false)
    expect(blocked.retryAfterSec).toBe(50)
  })

  it("resets after the window", () => {
    const opts = { key: "k", limit: 1, windowMs: 1000 }
    expect(takeRateLimitToken(opts).ok).toBe(true)
    expect(takeRateLimitToken(opts).ok).toBe(false)
    vi.advanceTimersByTime(1001)
    expect(takeRateLimitToken(opts).ok).toBe(true)
  })

  it("keeps keys independent and retryAfterSec at least 1", () => {
    const a = { key: "a", limit: 1, windowMs: 100 }
    takeRateLimitToken(a)
    expect(takeRateLimitToken({ ...a, key: "b" }).ok).toBe(true)
    expect(takeRateLimitToken(a).retryAfterSec).toBe(1)
  })

  it("sweeps expired buckets only periodically, but still honours expiry on access", () => {
    const g = globalThis as unknown as { __sunnyviewRateLimitBuckets: Map<string, unknown> }
    takeRateLimitToken({ key: "old", limit: 1, windowMs: 10 })
    vi.advanceTimersByTime(31_000)
    takeRateLimitToken({ key: "new", limit: 1, windowMs: 100_000 })
    expect(g.__sunnyviewRateLimitBuckets.has("old")).toBe(false)

    takeRateLimitToken({ key: "short", limit: 1, windowMs: 10 })
    vi.advanceTimersByTime(20)
    // inside the sweep interval: the stale bucket stays in the map ...
    takeRateLimitToken({ key: "other", limit: 1, windowMs: 100_000 })
    expect(g.__sunnyviewRateLimitBuckets.has("short")).toBe(true)
    // ... but is treated as expired when touched
    expect(takeRateLimitToken({ key: "short", limit: 1, windowMs: 10 }).ok).toBe(true)
  })

  it("caps the map size and evicts least-recently-used buckets first", () => {
    const g = globalThis as unknown as { __sunnyviewRateLimitBuckets: Map<string, unknown> }
    const long = { limit: 1, windowMs: 600_000 }
    takeRateLimitToken({ key: "hot", ...long })
    for (let i = 0; i < 3990; i++) takeRateLimitToken({ key: `bulk:${i}`, ...long })
    takeRateLimitToken({ key: "hot", ...long }) // touch (blocked) -> becomes most recent
    for (let i = 0; i < 100; i++) takeRateLimitToken({ key: `flood:${i}`, ...long })
    expect(g.__sunnyviewRateLimitBuckets.size).toBeLessThanOrEqual(4000)
    expect(g.__sunnyviewRateLimitBuckets.has("hot")).toBe(true)
    expect(g.__sunnyviewRateLimitBuckets.has("bulk:0")).toBe(false)
    expect(g.__sunnyviewRateLimitBuckets.has("flood:99")).toBe(true)
  })
})

describe("requestClientKey", () => {
  const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv

  it("returns unknown (one shared bucket) when no trusted header is configured, ignoring spoofable headers", () => {
    const h = new Headers({ "x-vercel-forwarded-for": "1.1.1.1", "x-real-ip": "2.2.2.2", "x-forwarded-for": "3.3.3.3" })
    expect(requestClientKey(h, env({}))).toBe("unknown")
  })

  it("defaults to x-vercel-forwarded-for on Vercel", () => {
    const h = new Headers({ "x-vercel-forwarded-for": "1.1.1.1, 9.9.9.9", "x-real-ip": "2.2.2.2" })
    expect(requestClientKey(h, env({ VERCEL: "1" }))).toBe("1.1.1.1")
  })

  it("honours only the configured TRUSTED_PROXY_HEADER", () => {
    const h = new Headers({ "x-real-ip": "2.2.2.2", "x-forwarded-for": "3.3.3.3" })
    expect(requestClientKey(h, env({ TRUSTED_PROXY_HEADER: "X-Real-IP" }))).toBe("2.2.2.2")
  })

  it("uses the right-most x-forwarded-for entry, ignoring spoofed leading values", () => {
    const h = new Headers({ "x-forwarded-for": "6.6.6.6, 3.3.3.3 , 4.4.4.4" })
    expect(requestClientKey(h, env({ TRUSTED_PROXY_HEADER: "x-forwarded-for" }))).toBe("4.4.4.4")
  })

  it("falls back to unknown when the trusted header is missing or empty, and bounds key length", () => {
    expect(requestClientKey(new Headers(), env({ TRUSTED_PROXY_HEADER: "x-real-ip" }))).toBe("unknown")
    expect(requestClientKey(new Headers({ "x-forwarded-for": " , " }), env({ TRUSTED_PROXY_HEADER: "x-forwarded-for" }))).toBe("unknown")
    const long = "a".repeat(500)
    expect(requestClientKey(new Headers({ "x-real-ip": long }), env({ TRUSTED_PROXY_HEADER: "x-real-ip" }))).toHaveLength(64)
  })
})
