import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { PVWATTS_DEFAULT_URL, callPVWatts } from "@/lib/pvwatts"

const params = { lat: 37.5, lon: -122.1, dcKw: 5, tilt: 20, azimuth: 180, losses: 14 }
const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
  vi.stubEnv("PVWATTS_API_KEY", "k123")
})
afterEach(() => {
  fetchMock.mockReset()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

describe("callPVWatts", () => {
  it("throws when the API key is missing or blank", async () => {
    vi.stubEnv("PVWATTS_API_KEY", "  ")
    await expect(callPVWatts(params)).rejects.toThrow("Missing PVWATTS_API_KEY")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("builds the PVWatts v8 request URL on the NLR host with defaults and overrides", async () => {
    fetchMock.mockResolvedValue(ok({}))
    await callPVWatts(params)
    const u = new URL(fetchMock.mock.calls[0][0])
    expect(u.origin + u.pathname).toBe("https://developer.nlr.gov/api/pvwatts/v8.json")
    expect(PVWATTS_DEFAULT_URL).toBe("https://developer.nlr.gov/api/pvwatts/v8.json")
    expect(Object.fromEntries(u.searchParams)).toEqual({
      api_key: "k123", lat: "37.5", lon: "-122.1", system_capacity: "5", tilt: "20",
      azimuth: "180", losses: "14", module_type: "1", array_type: "1",
    })
    await callPVWatts({ ...params, moduleType: 2, arrayType: 0 })
    const u2 = new URL(fetchMock.mock.calls[1][0])
    expect(u2.searchParams.get("module_type")).toBe("2")
    expect(u2.searchParams.get("array_type")).toBe("0")
  })

  it("uses PVWATTS_BASE_URL when set, ignoring surrounding whitespace", async () => {
    vi.stubEnv("PVWATTS_BASE_URL", "  https://pv.example.test/api/pvwatts/v8.json  ")
    fetchMock.mockResolvedValue(ok({}))
    await callPVWatts(params)
    const u = new URL(fetchMock.mock.calls[0][0])
    expect(u.origin + u.pathname).toBe("https://pv.example.test/api/pvwatts/v8.json")
    expect(u.searchParams.get("api_key")).toBe("k123")
    expect(u.searchParams.get("system_capacity")).toBe("5")
  })

  it("falls back to the default URL when PVWATTS_BASE_URL is blank", async () => {
    vi.stubEnv("PVWATTS_BASE_URL", "   ")
    fetchMock.mockResolvedValue(ok({}))
    await callPVWatts(params)
    const u = new URL(fetchMock.mock.calls[0][0])
    expect(u.origin + u.pathname).toBe(PVWATTS_DEFAULT_URL)
  })

  it.each(["not a url", "ftp://pv.example.test/v8.json", "/api/pvwatts/v8.json"])(
    "throws without fetching when PVWATTS_BASE_URL is invalid (%s)",
    async (bad) => {
      vi.stubEnv("PVWATTS_BASE_URL", bad)
      await expect(callPVWatts(params)).rejects.toThrow("Invalid PVWATTS_BASE_URL")
      expect(fetchMock).not.toHaveBeenCalled()
    }
  )

  it("checks the API key before the base URL", async () => {
    vi.stubEnv("PVWATTS_API_KEY", "")
    vi.stubEnv("PVWATTS_BASE_URL", "not a url")
    await expect(callPVWatts(params)).rejects.toThrow("Missing PVWATTS_API_KEY")
  })

  it("passes an abort signal and disables caching", async () => {
    fetchMock.mockResolvedValue(ok({}))
    await callPVWatts(params)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.cache).toBe("no-store")
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it("parses 12 monthly values and annual total", async () => {
    const monthly = Array.from({ length: 12 }, (_, i) => i + 1)
    fetchMock.mockResolvedValue(ok({ outputs: { ac_monthly: monthly, ac_annual: 999 }, inputs: { a: 1 } }))
    expect(await callPVWatts(params)).toEqual({ annualKwh: 999, monthlyKwh: monthly, inputs: { a: 1 } })
  })

  it("falls back: sums monthly for annual and spreads evenly when length != 12", async () => {
    fetchMock.mockResolvedValue(ok({ outputs: { ac_monthly: [10, "x", 20] } }))
    const r = await callPVWatts(params)
    expect(r.annualKwh).toBe(30)
    expect(r.monthlyKwh).toHaveLength(12)
    expect(r.monthlyKwh.every((v) => v === 2.5)).toBe(true)
    expect(r.inputs).toEqual({})
  })

  it("handles an unparsable success body", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 200 }))
    const r = await callPVWatts(params)
    expect(r.annualKwh).toBe(0)
    expect(r.monthlyKwh).toEqual(Array(12).fill(0))
  })

  it("throws with truncated upstream text on non-ok", async () => {
    fetchMock.mockResolvedValue(new Response("x".repeat(500), { status: 429 }))
    await expect(callPVWatts(params)).rejects.toThrow(/^PVWatts error 429: x{240}$/)
  })

  it("rethrows non-abort fetch errors", async () => {
    fetchMock.mockRejectedValue(new Error("dns"))
    await expect(callPVWatts(params)).rejects.toThrow("dns")
  })

  it("reports a timeout when the request is aborted", async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementation(
      (_u: string, init: RequestInit) =>
        new Promise((_res, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted"))))
    )
    const p = callPVWatts(params)
    const assertion = expect(p).rejects.toThrow("PVWatts request timed out after 12000ms")
    await vi.advanceTimersByTimeAsync(12_000)
    await assertion
  })
})
