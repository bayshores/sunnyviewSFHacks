import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/pvwatts", () => ({ callPVWatts: vi.fn() }))

import { callPVWatts } from "@/lib/pvwatts"
import { POST } from "./route"

const pv = vi.mocked(callPVWatts)

function req(body: unknown, ip = "9.9.9.9") {
  return new Request("http://localhost/api/estimate", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": ip },
    body: JSON.stringify(body),
  })
}

function body(overrides: Record<string, unknown> = {}, dcKw = 5) {
  return { siteSpec: { lat: 37.77, lng: -122.42, ...overrides }, layoutSummary: { dcKw } }
}

function resetState() {
  const g = globalThis as unknown as Record<string, unknown>
  delete g.__sunnyviewRateLimitBuckets
  delete g.__sunnyviewEstimateCache
}

describe("POST /api/estimate", () => {
  beforeEach(() => {
    resetState()
    pv.mockReset()
    vi.stubEnv("CO2_KG_PER_KWH", "")
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "")
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "")
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    resetState()
  })

  it("400s with issues on invalid body", async () => {
    const res = await POST(req({ nope: 1 }))
    expect(res.status).toBe(400)
    expect(Array.isArray((await res.json()).issues)).toBe(true)
  })

  it("413s on an oversized body, declared or streamed", async () => {
    const declared = new Request("http://localhost/api/estimate", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "8.8.8.1", "content-length": "16385" },
      body: "{}",
    })
    expect((await POST(declared)).status).toBe(413)
    const res = await POST(req({ ...body(), pad: "x".repeat(20_000) }, "8.8.8.2"))
    expect(res.status).toBe(413)
    expect(pv).not.toHaveBeenCalled()
  })

  it("falls back for non-positive dcKw", async () => {
    const json = await (await POST(req(body({}, 0)))).json()
    expect(json.annualKwh).toBe(0)
    expect(json.assumptions.source).toBe("fallback_bad_dc_kw")
  })

  it("falls back without a location using shared defaults", async () => {
    const json = await (await POST(req({ siteSpec: {}, layoutSummary: { dcKw: 2 } }))).json()
    expect(json.annualKwh).toBe(2800)
    expect(json.annualCo2Kg).toBeCloseTo(1120)
    expect(json.monthlyKwh).toHaveLength(12)
    expect(json.assumptions).toEqual({ source: "fallback_no_location", localKwhPerKwYear: 1400 })
    expect(pv).not.toHaveBeenCalled()
  })

  it("uses PVWatts on the happy path and honours CO2 env", async () => {
    vi.stubEnv("CO2_KG_PER_KWH", "0.5")
    pv.mockResolvedValue({ annualKwh: 8000, monthlyKwh: Array(12).fill(8000 / 12), inputs: { a: 1 } } as never)
    const json = await (await POST(req(body()))).json()
    expect(json.annualKwh).toBe(8000)
    expect(json.annualCo2Kg).toBe(4000)
    expect(json.assumptions.source).toBe("pvwatts")
  })

  it("serves the second identical request from memory cache", async () => {
    pv.mockResolvedValue({ annualKwh: 100, monthlyKwh: Array(12).fill(1), inputs: {} } as never)
    await POST(req(body()))
    const json = await (await POST(req(body()))).json()
    expect(pv).toHaveBeenCalledTimes(1)
    expect(json.assumptions.source).toBe("mem_cache")
  })

  it("falls back when PVWatts throws", async () => {
    pv.mockRejectedValue(new Error("pvwatts down"))
    const res = await POST(req(body()))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.assumptions.source).toBe("fallback_after_pvwatts_error")
    expect(json.annualKwh).toBe(7000)
  })

  it("429s after 40 requests", async () => {
    for (let i = 0; i < 40; i++) {
      expect((await POST(req({ siteSpec: {}, layoutSummary: { dcKw: 1 } }))).status).toBe(200)
    }
    const res = await POST(req(body()))
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBeTruthy()
  })
})
