import { NextRequest } from "next/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { GET } from "./route"

function req(qs: string, ip = "9.9.9.9") {
  return new NextRequest(`http://localhost/api/forecast?${qs}`, { headers: { "x-real-ip": ip } })
}

const QS = "lat=37.77&lng=-122.42&dcKw=5"

function resetState() {
  const g = globalThis as unknown as Record<string, unknown>
  delete g.__sunnyviewRateLimitBuckets
  delete g.__sunnyviewForecastCache
}

const daily = {
  time: ["2026-01-01", "2026-01-02", "2026-01-03"],
  shortwave_radiation_sum: [18, 20, null],
  cloudcover_mean: [10, 20, 30],
}

function archiveJson() {
  return { daily: { shortwave_radiation_sum: Array(365).fill(18), cloudcover_mean: Array(365).fill(40) } }
}

function routeFetch(handlers: { forecast: () => Response | Promise<Response>; archive: () => Response | Promise<Response> }) {
  return vi.fn(async (url: string) => (url.includes("archive-api") ? handlers.archive() : handlers.forecast()))
}

describe("GET /api/forecast", () => {
  beforeEach(() => {
    resetState()
    vi.spyOn(console, "info").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
    resetState()
  })

  it("400s with issues on invalid query", async () => {
    const res = await GET(req("lat=999&lng=0&dcKw=1"))
    expect(res.status).toBe(400)
    expect(Array.isArray((await res.json()).issues)).toBe(true)
    expect((await GET(req("lat=1"))).status).toBe(400)
  })

  it("returns live forecast with archive-based worthIt and then serves from cache", async () => {
    const f = routeFetch({ forecast: () => Response.json({ daily }), archive: () => Response.json(archiveJson()) })
    vi.stubGlobal("fetch", f)
    const res = await GET(req(QS))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.days).toHaveLength(3)
    expect(json.days[2].estKwh).toBe(0)
    expect(json.meta.source).toBe("open-meteo")
    expect(json.worthIt.basis.kind).toBe("archive-365d")
    expect(json.worthIt.assumptions).toEqual({
      utilityRateUsdPerKwh: 0.25,
      installCostUsdPerW: 2.75,
      goodPaybackYears: 9,
      maybePaybackYears: 14,
    })
    expect(["good", "maybe", "unlikely"]).toContain(json.worthIt.verdict)

    const callsBefore = f.mock.calls.length
    const cached = await (await GET(req(QS))).json()
    expect(f.mock.calls.length).toBe(callsBefore)
    expect(cached.days).toHaveLength(3)
    expect(cached.worthIt.basis.kind).toBe("archive-365d")
  })

  it("marks worthIt unavailable when the archive fails", async () => {
    vi.stubGlobal("fetch", routeFetch({ forecast: () => Response.json({ daily }), archive: () => new Response("", { status: 500 }) }))
    const json = await (await GET(req(QS))).json()
    expect(json.archive365).toBeNull()
    expect(json.worthIt.basis.kind).toBe("unavailable")
    expect(json.worthIt.paybackYears).toBeNull()
    expect(json.worthIt.verdict).toBeUndefined()
  })

  it("retries a 500 once then succeeds", async () => {
    let n = 0
    vi.stubGlobal(
      "fetch",
      routeFetch({
        forecast: () => (n++ === 0 ? new Response("err", { status: 503 }) : Response.json({ daily })),
        archive: () => Response.json(archiveJson()),
      })
    )
    const res = await GET(req(QS))
    expect((await res.json()).meta.source).toBe("open-meteo")
    expect(n).toBe(2)
  })

  it("falls back to a rough estimate when the forecast provider keeps failing", async () => {
    vi.stubGlobal("fetch", routeFetch({ forecast: () => new Response("err", { status: 500 }), archive: () => Response.json(archiveJson()) }))
    const res = await GET(req(QS))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.meta.source).toBe("fallback")
    expect(json.days).toHaveLength(7)
    expect(json.worthIt.basis.kind).toBe("archive-365d")
  })

  it("falls back when forecast payload has no days or fetch rejects", async () => {
    vi.stubGlobal("fetch", routeFetch({ forecast: () => Response.json({}), archive: () => Response.json({}) }))
    const json = await (await GET(req(QS))).json()
    expect(json.meta.source).toBe("fallback")
    expect(json.worthIt.basis.kind).toBe("unavailable")

    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("net"))))
    const json2 = await (await GET(req("lat=1&lng=2&dcKw=3"))).json()
    expect(json2.meta.source).toBe("fallback")
  })

  it("429s after 40 requests", async () => {
    vi.stubGlobal("fetch", routeFetch({ forecast: () => Response.json({ daily }), archive: () => Response.json(archiveJson()) }))
    for (let i = 0; i < 40; i++) expect((await GET(req(QS))).status).toBe(200)
    const res = await GET(req(QS))
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBeTruthy()
  })
})
