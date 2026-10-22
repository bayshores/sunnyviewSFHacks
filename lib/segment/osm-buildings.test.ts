import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { staticMapTransformFromCenter } from "@/lib/segment/mercator"
import {
  fetchOverpassBuildings,
  OVERPASS_ATTEMPT_TIMEOUT_MS,
  OVERPASS_COOLDOWN_MS,
  OVERPASS_QUERY_BUDGET_MS,
  OVERPASS_SHORT_COOLDOWN_MS,
  pickTopOrCandidates,
  rankBuildingCandidates,
} from "@/lib/segment/osm-buildings"

function squareGeom(lat0: number, lon0: number, d: number) {
  return [
    { lat: lat0 - d, lon: lon0 - d },
    { lat: lat0 - d, lon: lon0 + d },
    { lat: lat0 + d, lon: lon0 + d },
    { lat: lat0 + d, lon: lon0 - d },
    { lat: lat0 - d, lon: lon0 - d },
  ]
}

describe("OSM building ranking", () => {
  it("prefers polygon containing focus point", () => {
    const tf = staticMapTransformFromCenter({
      lat: 0,
      lng: 0,
      zoom: 18,
      baseW: 520,
      baseH: 360,
      scale: 2,
      widthPx: 1040,
      heightPx: 720,
    })

    const elements: any[] = [
      { type: "way", id: 1, tags: { building: "house" }, geometry: squareGeom(0, 0, 0.00005) },
      { type: "way", id: 2, tags: { building: "house" }, geometry: squareGeom(0, 0.0003, 0.00005) },
    ]

    const scored = rankBuildingCandidates({
      elements,
      tf,
      focusPx: { x: 520, y: 360 },
      address: "123 Main St",
    })

    expect(scored[0]?.id).toBe("way:1")
    expect(scored[0]?.containsFocus).toBe(true)
  })

  it("prefers address-tag match even if not containing focus", () => {
    const tf = staticMapTransformFromCenter({
      lat: 0,
      lng: 0,
      zoom: 18,
      baseW: 520,
      baseH: 360,
      scale: 2,
      widthPx: 1040,
      heightPx: 720,
    })

    const elements: any[] = [
      { type: "way", id: 1, tags: { building: "house" }, geometry: squareGeom(0, 0, 0.00005) },
      {
        type: "way",
        id: 2,
        tags: { building: "house", "addr:housenumber": "123", "addr:street": "Main Street" },
        geometry: squareGeom(0, 0.0003, 0.00005),
      },
    ]

    const scored = rankBuildingCandidates({
      elements,
      tf,
      focusPx: { x: 520, y: 360 },
      address: "123 Main St",
    })

    expect(scored[0]?.id).toBe("way:2")
    expect(scored[0]?.addrScore).toBeGreaterThan(0)
  })

  it("returns candidates when uncertain", () => {
    const tf = staticMapTransformFromCenter({
      lat: 0,
      lng: 0,
      zoom: 18,
      baseW: 520,
      baseH: 360,
      scale: 2,
      widthPx: 1040,
      heightPx: 720,
    })

    const elements: any[] = [
      { type: "way", id: 1, tags: { building: "house" }, geometry: squareGeom(0, 0.0006, 0.00005) },
      { type: "way", id: 2, tags: { building: "house" }, geometry: squareGeom(0, -0.0006, 0.00005) },
    ]

    const scored = rankBuildingCandidates({
      elements,
      tf,
      focusPx: { x: 520, y: 360 },
      address: "123 Main St",
    })
    const pick = pickTopOrCandidates(scored)
    expect(pick.kind).toBe("candidates")
  })

  it("does not let distant addr-tags beat containment", () => {
    const tf = staticMapTransformFromCenter({
      lat: 0,
      lng: 0,
      zoom: 18,
      baseW: 520,
      baseH: 360,
      scale: 2,
      widthPx: 1040,
      heightPx: 720,
    })

    const elements: any[] = [
      // Near building contains focus.
      { type: "way", id: 1, tags: { building: "apartments" }, geometry: squareGeom(0, 0, 0.00005) },
      // Far building has perfect address tags but is hundreds of meters away.
      {
        type: "way",
        id: 2,
        tags: { building: "house", "addr:housenumber": "123", "addr:street": "Main Street" },
        geometry: squareGeom(0, 0.004, 0.00005),
      },
    ]

    const scored = rankBuildingCandidates({
      elements,
      tf,
      focusPx: { x: 520, y: 360 },
      address: "123 Main St",
    })

    expect(scored[0]?.id).toBe("way:1")
    expect(scored[0]?.containsFocus).toBe(true)
  })
})

describe("Overpass fetching", () => {
  const g = globalThis as any
  const MAIN = "https://overpass-api.de/api/interpreter"
  const COFFEE = "https://overpass.private.coffee/api/interpreter"
  const MAILRU = "https://maps.mail.ru/osm/tools/overpass/api/interpreter"
  let fetchMock: ReturnType<typeof vi.fn>
  const savedUrl = process.env.OVERPASS_URL

  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  }

  const ok = () => json({ elements: [{ type: "way", id: 7 }] })
  const calledUrls = () => fetchMock.mock.calls.map((c) => String(c[0]))
  const query = (lat = 37.4) => fetchOverpassBuildings({ lat, lng: -122.1, radiusM: 60 })

  beforeEach(() => {
    delete process.env.OVERPASS_URL
    delete g.__sunnyviewOverpassCache
    delete g.__sunnyviewOverpassCooldown
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    if (savedUrl === undefined) delete process.env.OVERPASS_URL
    else process.env.OVERPASS_URL = savedUrl
  })

  it("POSTs the query form-encoded with identifying headers to the main instance first", async () => {
    fetchMock.mockResolvedValue(ok())
    const elements = await query()
    expect(elements).toEqual([{ type: "way", id: 7 }])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(MAIN)
    expect(init.method).toBe("POST")
    const headers = new Headers(init.headers)
    expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded;charset=UTF-8")
    expect(headers.get("accept")).toContain("application/json")
    expect(headers.get("user-agent")).toMatch(/^sunnyviewSFHacks\/1\.0 \(\+https:\/\/github\.com\/bayshores\/sunnyviewSFHacks\)$/)
    const data = new URLSearchParams(String(init.body)).get("data")
    expect(data).toBe('[out:json][timeout:10];nwr["building"](around:60,37.4,-122.1);out tags geom;')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it("uses the default order main -> private.coffee -> mail.ru and drops dead hosts", async () => {
    fetchMock.mockResolvedValue(json({}, 503))
    await expect(query()).rejects.toThrow(/Overpass failed \(503\)/)
    expect(calledUrls()).toEqual([MAIN, COFFEE, MAILRU])
    expect(calledUrls().some((u) => u.includes("kumi.systems") || u.includes("nchc.org.tw"))).toBe(false)
  })

  it("puts OVERPASS_URL entries first, ignores invalid ones and de-duplicates", async () => {
    process.env.OVERPASS_URL = " https://my.overpass.test/api/interpreter , not a url, ftp://x.test/i, " + COFFEE
    fetchMock.mockResolvedValue(json({}, 429))
    await expect(query()).rejects.toThrow(/429/)
    expect(calledUrls()).toEqual(["https://my.overpass.test/api/interpreter", COFFEE, MAIN, MAILRU])
  })

  it.each([406, 429, 500, 502, 503, 504])("falls back to the next endpoint on HTTP %i", async (status) => {
    fetchMock.mockResolvedValueOnce(json({}, status)).mockResolvedValueOnce(ok())
    expect(await query()).toHaveLength(1)
    expect(calledUrls()).toEqual([MAIN, COFFEE])
  })

  it("falls back to the next endpoint on network errors", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(ok())
    expect(await query()).toHaveLength(1)
    expect(calledUrls()).toEqual([MAIN, COFFEE])
  })

  it("treats an Overpass runtime-error remark as a failure and does not cache it", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ elements: [], remark: "runtime error: Query timed out in \"query\" at line 1" }))
      .mockResolvedValueOnce(ok())
    expect(await query()).toHaveLength(1)
    expect(calledUrls()).toEqual([MAIN, COFFEE])
  })

  it("aborts a hanging attempt after the per-attempt timeout and tries the next endpoint", async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementation((url: string, init: RequestInit) => {
      if (url !== MAIN) return Promise.resolve(ok())
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
      })
    })
    const p = query()
    await vi.advanceTimersByTimeAsync(OVERPASS_ATTEMPT_TIMEOUT_MS + 10)
    expect(await p).toHaveLength(1)
    expect(calledUrls()).toEqual([MAIN, COFFEE])
  })

  it("keeps the whole query within its time budget", async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
        })
    )
    const p = query()
    const settled = p.then(
      () => "resolved",
      () => "rejected"
    )
    await vi.advanceTimersByTimeAsync(OVERPASS_QUERY_BUDGET_MS + 10)
    expect(await settled).toBe("rejected")
    expect(OVERPASS_QUERY_BUDGET_MS).toBeLessThan(20_000)
  })

  it("does not retry on a non-retryable 4xx", async () => {
    fetchMock.mockResolvedValue(json({}, 400))
    await expect(query()).rejects.toThrow(/Overpass failed \(400\)/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("serves repeat queries from the memory cache", async () => {
    fetchMock.mockResolvedValue(ok())
    await query()
    expect(await query()).toEqual([{ type: "way", id: 7 }])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("bounds the memory cache", async () => {
    fetchMock.mockImplementation(async () => ok())
    for (let i = 0; i < 260; i++) await query(37 + i / 1000)
    expect(g.__sunnyviewOverpassCache.size).toBeLessThanOrEqual(200)
  })

  it("skips an endpoint that just failed for a cooldown period, then retries it", async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValueOnce(json({}, 429)).mockResolvedValue(ok())
    await query(37.1)
    await query(37.2)
    expect(calledUrls()).toEqual([MAIN, COFFEE, COFFEE])
    vi.advanceTimersByTime(OVERPASS_COOLDOWN_MS + 1)
    await query(37.3)
    expect(calledUrls().at(-1)).toBe(MAIN)
  })

  function hangUntilAborted(_url: string, init: RequestInit) {
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
    })
  }

  it("applies the operator-requested 30s cooldown after a 406", async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValueOnce(new Response("Not Acceptable", { status: 406 })).mockResolvedValue(ok())
    await query(37.1)
    vi.advanceTimersByTime(OVERPASS_COOLDOWN_MS - 1000)
    await query(37.2)
    expect(calledUrls()).toEqual([MAIN, COFFEE, COFFEE])
  })

  it.each([
    ["HTTP 503", () => json({}, 503)],
    ["a runtime-error remark", () => json({ elements: [], remark: "runtime error: Query timed out" })],
  ])("only briefly cools an endpoint down after %s", async (_label, failure) => {
    vi.useFakeTimers()
    expect(OVERPASS_SHORT_COOLDOWN_MS).toBeLessThan(OVERPASS_COOLDOWN_MS)
    fetchMock.mockResolvedValueOnce(failure()).mockResolvedValue(ok())
    await query(37.1)
    await query(37.2)
    expect(calledUrls()).toEqual([MAIN, COFFEE, COFFEE])
    vi.advanceTimersByTime(OVERPASS_SHORT_COOLDOWN_MS + 1)
    await query(37.3)
    expect(calledUrls().at(-1)).toBe(MAIN)
  })

  it("does not cool an endpoint down after a network error", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValue(ok())
    await query(37.1)
    await query(37.2)
    expect(calledUrls()).toEqual([MAIN, COFFEE, MAIN])
  })

  it("does not cool endpoints down after timeouts, so one slow burst cannot disable Overpass", async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementation(hangUntilAborted)
    const first = query(37.1).catch((e: Error) => e)
    await vi.advanceTimersByTimeAsync(OVERPASS_QUERY_BUDGET_MS + 10)
    expect(await first).toBeInstanceOf(Error)
    // main timed out after a full attempt, private.coffee was cut short by the query budget
    expect(calledUrls()).toEqual([MAIN, COFFEE])

    fetchMock.mockReset()
    fetchMock.mockResolvedValue(ok())
    expect(await query(37.2)).toHaveLength(1)
    expect(calledUrls()).toEqual([MAIN])
  })

  it("respects a caller deadline shorter than the query budget", async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementation(hangUntilAborted)
    const p = fetchOverpassBuildings({ lat: 37, lng: -122, radiusM: 60, deadline: Date.now() + 2_500 }).catch((e: Error) => e)
    await vi.advanceTimersByTimeAsync(2_510)
    expect(await p).toBeInstanceOf(Error)
    expect(calledUrls()).toEqual([MAIN])
  })

  it("does not fetch when the caller deadline has (almost) passed, but still serves cache hits", async () => {
    fetchMock.mockResolvedValue(ok())
    await query(37.5)
    fetchMock.mockClear()
    const deadline = Date.now() + 100
    expect(await fetchOverpassBuildings({ lat: 37.5, lng: -122.1, radiusM: 60, deadline })).toHaveLength(1)
    await expect(fetchOverpassBuildings({ lat: 37.6, lng: -122.1, radiusM: 60, deadline })).rejects.toThrow(/budget/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("fails fast without fetching when the caller already aborted", async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(fetchOverpassBuildings({ lat: 37, lng: -122, radiusM: 60, signal: ac.signal })).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
