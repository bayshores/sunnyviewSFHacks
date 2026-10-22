import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

import { GET } from "./route"

const g = globalThis as any

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function call(qs: string, ip = "2.2.2.2") {
  return GET(new NextRequest(`http://localhost/api/reverse-geocode?${qs}`, { headers: { "x-forwarded-for": ip } }))
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  delete g.__sunnyviewReverseGeocodeCache
  delete g.__sunnyviewRateLimitBuckets
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("GET /api/reverse-geocode", () => {
  it("returns 400 when lat/lng are missing or invalid", async () => {
    for (const qs of ["", "lat=1", "lng=2", "lat=abc&lng=2"]) {
      const res = await call(qs)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: "Missing lat/lng" })
    }
  })

  it("returns 429 when rate limited", async () => {
    fetchMock.mockImplementation(async () => json({ address: { LongLabel: "X" } }))
    for (let i = 0; i < 90; i++) await call("lat=10&lng=10")
    const res = await call("lat=10&lng=10")
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBeTruthy()
  })

  it("prefers Esri LongLabel, then Match_addr", async () => {
    fetchMock.mockImplementation(async () => json({ address: { LongLabel: " 1 A St ", Match_addr: "m" } }))
    const a = await (await call("lat=10&lng=20")).json()
    expect(a).toEqual({ lat: 10, lng: 20, displayName: "1 A St", provider: "esri" })

    fetchMock.mockImplementation(async () => json({ address: { Match_addr: "match" } }))
    const b = await (await call("lat=11&lng=20")).json()
    expect(b.displayName).toBe("match")
  })

  it("falls back to Nominatim when Esri has no label or errors", async () => {
    fetchMock.mockImplementation(async (u: string) => {
      if (u.includes("arcgis")) return json({}, 500)
      return json({ display_name: " Somewhere, Place " })
    })
    const body = await (await call("lat=10&lng=20")).json()
    expect(body).toEqual({ lat: 10, lng: 20, displayName: "Somewhere, Place", provider: "nominatim" })
    expect(fetchMock.mock.calls[1][1].headers["user-agent"]).toBe("sunnyviewSFHacks/1.0 (reverse geocode proxy)")
    const u = new URL(fetchMock.mock.calls[1][0])
    expect(u.pathname).toBe("/reverse")
    expect(u.searchParams.get("zoom")).toBe("18")
  })

  it("returns coordinates with provider none when all providers miss", async () => {
    fetchMock.mockImplementation(async () => json({}))
    const body = await (await call("lat=10&lng=20")).json()
    expect(body).toEqual({ lat: 10, lng: 20, displayName: "10.000000, 20.000000", provider: "none" })
  })

  it("clamps coordinates to Web Mercator bounds", async () => {
    fetchMock.mockImplementation(async () => json({ address: { LongLabel: "Pole" } }))
    const body = await (await call("lat=99&lng=-400")).json()
    expect(body.lat).toBe(85.05112878)
    expect(body.lng).toBe(-180)
  })

  it("serves repeated requests from cache", async () => {
    fetchMock.mockImplementation(async () => json({ address: { LongLabel: "Cached" } }))
    await call("lat=10&lng=20")
    const second = await (await call("lat=10.000001&lng=20")).json()
    expect(second.displayName).toBe("Cached")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("moves a refreshed key to the end of the cache order", async () => {
    fetchMock.mockImplementation(async () => json({ address: { LongLabel: "X" } }))
    await call("lat=10&lng=20")
    await call("lat=11&lng=20")
    expect([...g.__sunnyviewReverseGeocodeCache.keys()]).toEqual(["rev:10.00000:20.00000", "rev:11.00000:20.00000"])
    // Expire the first entry so the next request refreshes it.
    g.__sunnyviewReverseGeocodeCache.get("rev:10.00000:20.00000").t = 0
    await call("lat=10&lng=20")
    expect([...g.__sunnyviewReverseGeocodeCache.keys()]).toEqual(["rev:11.00000:20.00000", "rev:10.00000:20.00000"])
  })

  it("falls back to a coordinate label when every provider throws, without caching it", async () => {
    fetchMock.mockRejectedValue(new Error("boom"))
    const res = await call("lat=10&lng=20")
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ provider: "none", displayName: "10.000000, 20.000000" })
    const callsAfterFirst = fetchMock.mock.calls.length
    await call("lat=10&lng=20")
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirst)
  })

  it("uses Nominatim when Esri throws", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("esri down"))
      .mockResolvedValueOnce(Response.json({ display_name: "1 Main St" }))
    const res = await call("lat=11&lng=21")
    expect(await res.json()).toMatchObject({ provider: "nominatim", displayName: "1 Main St" })
  })
})
