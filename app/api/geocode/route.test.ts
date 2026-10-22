import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

import { GET } from "./route"

const g = globalThis as any

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function call(qs: string, ip = "1.1.1.1") {
  return GET(new NextRequest(`http://localhost/api/geocode?${qs}`, { headers: { "x-forwarded-for": ip } }))
}

const ESRI_CAND = {
  candidates: [{ address: "123 Main St, Springfield", location: { x: -122.1, y: 37.2 }, score: 98 }],
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  delete g.__sunnyviewGeocodeCache
  delete g.__sunnyviewRateLimitBuckets
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("GET /api/geocode", () => {
  it("returns 400 when q is missing", async () => {
    const res = await call("")
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "Missing q" })
  })

  it("returns 429 with retry-after when rate limited", async () => {
    fetchMock.mockImplementation(async () => json(ESRI_CAND))
    for (let i = 0; i < 90; i++) {
      const r = await call("q=abc")
      expect(r.status).toBe(200)
    }
    const res = await call("q=abc")
    expect(res.status).toBe(429)
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1)
    expect((await res.json()).error).toMatch(/Too many geocode/)
  })

  it("uses Esri first in lookup mode", async () => {
    fetchMock.mockImplementation(async () => json(ESRI_CAND))
    const res = await call("q=123%20Main%20St&limit=3&biasLat=37.2&biasLng=-122.1")
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.warning).toBeNull()
    expect(body.results).toEqual([
      {
        id: `esri:${encodeURIComponent("123 Main St, Springfield")}:-122.100000,37.200000`,
        lat: 37.2,
        lng: -122.1,
        displayName: "123 Main St, Springfield",
        score: 98,
        address: null,
        meta: { class: "esri", type: "candidate", importance: null },
      },
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = new URL(fetchMock.mock.calls[0][0])
    expect(url.pathname).toMatch(/findAddressCandidates$/)
    expect(url.searchParams.get("singleLine")).toBe("123 Main St")
    expect(url.searchParams.get("maxLocations")).toBe("3")
    expect(url.searchParams.get("location")).toBe("-122.1,37.2")
  })

  it("falls back to Nominatim when Esri fails and scores hits", async () => {
    fetchMock.mockImplementation(async (u: string) => {
      if (u.includes("arcgis")) return json({}, 500)
      return json([
        {
          place_id: 7,
          lat: "37.2",
          lon: "-122.1",
          display_name: "123, Main Street, Springfield",
          importance: 0.5,
          type: "house",
          class: "building",
          address: { house_number: "123", road: "Main Street", city: "Springfield" },
        },
      ])
    })
    const res = await call("q=123%20Main%20St")
    const body = await res.json()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const nomUrl = new URL(fetchMock.mock.calls[1][0])
    expect(nomUrl.hostname).toBe("nominatim.openstreetmap.org")
    expect(nomUrl.searchParams.get("limit")).toBe("8")
    expect(fetchMock.mock.calls[1][1].headers["user-agent"]).toBe("sunnyviewSFHacks/1.0 (geocode proxy)")
    expect(body.results).toHaveLength(1)
    expect(body.results[0]).toMatchObject({
      id: "place:7",
      lat: 37.2,
      lng: -122.1,
      score: 5 + 80 + 35 + 10 + 20 + 5,
      address: { houseNumber: "123", road: "Main Street", city: "Springfield", town: null },
      meta: { class: "building", type: "house", importance: 0.5 },
    })
    expect(body.warning).toBeNull()
  })

  it("warns when house number is not found and when ambiguous", async () => {
    fetchMock.mockImplementation(async (u: string) => {
      if (u.includes("arcgis")) return json({ candidates: [] })
      return json([
        { place_id: 1, lat: "1", lon: "2", display_name: "Main Street, A" },
        { place_id: 2, lat: "1.1", lon: "2.1", display_name: "Main Street, B" },
      ])
    })
    const res = await call("q=999%20Main%20St")
    const body = await res.json()
    expect(body.results).toHaveLength(2)
    expect(body.warning).toMatch(/House number not found/)
    const res2 = await call("q=Main%20St&limit=5")
    expect((await res2.json()).warning).toMatch(/ambiguous/)
  })

  it("serves the second identical request from cache", async () => {
    fetchMock.mockImplementation(async () => json(ESRI_CAND))
    const a = await (await call("q=cache%20me")).json()
    const b = await (await call("q=cache%20me")).json()
    expect(b).toEqual(a)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("suggest mode maps suggestions and skips incomplete ones", async () => {
    fetchMock.mockImplementation(async () =>
      json({ suggestions: [{ text: " 1 Main St ", magicKey: "K1" }, { text: "no key" }, { magicKey: "K2" }] })
    )
    const res = await call("q=1%20Mai&mode=suggest")
    const body = await res.json()
    expect(new URL(fetchMock.mock.calls[0][0]).pathname).toMatch(/suggest$/)
    expect(body).toEqual({
      results: [
        {
          id: "esri_suggest:K1",
          lat: null,
          lng: null,
          displayName: "1 Main St",
          score: 0,
          magicKey: "K1",
          address: null,
          meta: { class: "esri", type: "suggest", importance: null },
        },
      ],
      warning: null,
    })
  })

  it("resolve mode requires magicKey and passes it to Esri", async () => {
    const missing = await call("q=x&mode=resolve")
    expect(missing.status).toBe(400)
    expect(await missing.json()).toEqual({ error: "Missing magicKey" })

    fetchMock.mockImplementation(async () => json(ESRI_CAND))
    const res = await call("q=x&mode=resolve&magicKey=ABC")
    const body = await res.json()
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get("magicKey")).toBe("ABC")
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get("maxLocations")).toBe("1")
    expect(body.results[0].displayName).toBe("123 Main St, Springfield")
  })

  it("resolve mode with no candidate returns empty warning payload", async () => {
    fetchMock.mockImplementation(async () => json({ candidates: [] }))
    const res = await call("q=x&mode=resolve&magicKey=ABC")
    expect(await res.json()).toEqual({ results: [], warning: "No results. Try a more specific address." })
  })

  it("returns a user-safe payload when both providers fail", async () => {
    fetchMock.mockImplementation(async () => json({}, 503))
    const res = await call("q=nowhere")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      results: [],
      warning: "Geocoding is temporarily unavailable. Please try again in a moment.",
      error: "Geocoder error (503)",
    })
  })

  it("returns a timeout warning when the abort signal fires", async () => {
    vi.useFakeTimers()
    try {
      fetchMock.mockImplementation(
        (_u: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")))
          })
      )
      // suggest mode has no inner try/catch, so abort reaches the outer handler.
      const p = call("q=slow&mode=suggest")
      await vi.advanceTimersByTimeAsync(11_500)
      const res = await p
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.results).toEqual([])
      expect(body.warning).toBe("Geocoding timed out. Please try again.")
    } finally {
      vi.useRealTimers()
    }
  })

  it("expands street abbreviations and is unicode-aware when scoring", async () => {
    fetchMock.mockImplementation(async (u: string) => {
      if (u.includes("arcgis")) return json({ candidates: [] })
      return json([
        {
          place_id: 1,
          lat: "1",
          lon: "2",
          display_name: "5, Calle Ñandú, X",
          address: { house_number: "5", road: "Calle Ñandú" },
        },
      ])
    })
    const res = await call("q=5%20Calle%20%C3%91and%C3%BA")
    const body = await res.json()
    // 80 (house) + 35 (street equal, unicode-aware) + 10 (display contains query)
    expect(body.results[0].score).toBe(125)
  })
})
