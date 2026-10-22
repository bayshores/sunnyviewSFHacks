import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

import { GET } from "./route"

const g = globalThis as any

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function png(bytes = 4, type = "image/png") {
  return new Response(new Uint8Array(bytes).fill(1), { status: 200, headers: { "content-type": type } })
}

function call(qs: string, ip = "3.3.3.3") {
  return GET(new NextRequest(`http://localhost/api/static-map?${qs}`, { headers: { "x-forwarded-for": ip } }))
}

let fetchMock: ReturnType<typeof vi.fn>
const originalToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN

beforeEach(() => {
  delete g.__sunnyviewRateLimitBuckets
  delete process.env.NEXT_PUBLIC_MAPBOX_TOKEN
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
  vi.spyOn(console, "info").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  if (originalToken === undefined) delete process.env.NEXT_PUBLIC_MAPBOX_TOKEN
  else process.env.NEXT_PUBLIC_MAPBOX_TOKEN = originalToken
})

describe("GET /api/static-map", () => {
  it("returns 400 without coordinates or address", async () => {
    const res = await call("zoom=18")
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "Provide either (lat,lng) or address." })
  })

  it("returns 429 when rate limited", async () => {
    fetchMock.mockImplementation(async () => png())
    for (let i = 0; i < 45; i++) await call("lat=10&lng=20")
    const res = await call("lat=10&lng=20")
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBeTruthy()
  })

  it("proxies the ArcGIS image with the expected bbox and headers", async () => {
    fetchMock.mockImplementation(async () => png(8))
    const res = await call("lat=0&lng=0&zoom=19&w=256&h=128&scale=2")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("image/png")
    expect(res.headers.get("x-static-map-provider")).toBe("arcgis")
    expect(res.headers.get("x-static-map-attempt")).toBe("scale-2")
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400, s-maxage=86400")
    expect((await res.arrayBuffer()).byteLength).toBe(8)

    const url = new URL(fetchMock.mock.calls[0][0])
    expect(url.hostname).toBe("services.arcgisonline.com")
    const res19 = (2 * Math.PI * 6378137) / (256 * 2 ** 19)
    const halfW = (res19 * 256) / 2
    const halfH = (res19 * 128) / 2
    expect(url.searchParams.get("bbox")).toBe(
      `${(-halfW).toFixed(6)},${(-halfH).toFixed(6)},${halfW.toFixed(6)},${halfH.toFixed(6)}`
    )
    expect(url.searchParams.get("size")).toBe("512,256")
    expect(url.searchParams.get("bboxSR")).toBe("3857")
  })

  it("retries ArcGIS at scale 1 before failing over", async () => {
    let n = 0
    fetchMock.mockImplementation(async () => (++n === 1 ? new Response("nope", { status: 500 }) : png()))
    const res = await call("lat=10&lng=20&w=300&h=200&scale=2")
    expect(res.status).toBe(200)
    expect(res.headers.get("x-static-map-attempt")).toBe("scale-1-fallback")
    expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get("size")).toBe("300,200")
  })

  it("falls back to Mapbox when ArcGIS fails and a token is configured", async () => {
    process.env.NEXT_PUBLIC_MAPBOX_TOKEN = "tok en"
    fetchMock.mockImplementation(async (u: string) =>
      u.includes("mapbox.com") ? png(3, "image/jpeg") : new Response("bad", { status: 503 })
    )
    const res = await call("lat=10&lng=20&zoom=18.4&w=100&h=100&scale=1")
    expect(res.status).toBe(200)
    expect(res.headers.get("x-static-map-provider")).toBe("mapbox")
    expect(res.headers.get("content-type")).toBe("image/jpeg")
    const mb = String(fetchMock.mock.calls.at(-1)![0])
    expect(mb).toContain("/static/20.000000,10.000000,18,0/100x100")
    expect(mb).toContain("access_token=tok%20en")
  })

  it("returns 502 with details when providers respond with errors", async () => {
    fetchMock.mockImplementation(async () => new Response("upstream down", { status: 500 }))
    const res = await call("lat=10&lng=20")
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: "Static map providers unavailable.", details: "upstream down" })
  })

  it("returns 500 when every provider fetch throws", async () => {
    fetchMock.mockRejectedValue(new Error("net down"))
    const res = await call("lat=10&lng=20")
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "Static map providers unavailable.", details: "net down" })
  })

  it("treats non-image content as a provider failure", async () => {
    fetchMock.mockImplementation(async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }))
    const res = await call("lat=10&lng=20&scale=1")
    expect(res.status).toBe(502)
    expect((await res.json()).details).toBe("<html>")
  })

  it("geocodes addresses via Esri first", async () => {
    fetchMock.mockImplementation(async (u: string) =>
      u.includes("findAddressCandidates") ? json({ candidates: [{ location: { x: 20, y: 10 } }] }) : png()
    )
    const res = await call("address=1%20Main%20St&scale=1")
    expect(res.status).toBe(200)
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get("maxLocations")).toBe("1")
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get("singleLine")).toBe("1 Main St")
  })

  it("falls back to Nominatim geocoding when Esri fails", async () => {
    fetchMock.mockImplementation(async (u: string) => {
      if (u.includes("findAddressCandidates")) return json({}, 500)
      if (u.includes("nominatim")) return json([{ lat: "10", lon: "20" }])
      return png()
    })
    const res = await call("address=1%20Main%20St&scale=1")
    expect(res.status).toBe(200)
    const nom = fetchMock.mock.calls.find((c) => String(c[0]).includes("nominatim"))!
    expect(nom[1].headers["user-agent"]).toBe("sunnyviewSFHacks/1.0 (static-map proxy)")
    expect(new URL(nom[0]).searchParams.get("limit")).toBe("1")
  })

  it("returns 500 with the geocoder message when both geocoders find nothing", async () => {
    fetchMock.mockImplementation(async (u: string) =>
      u.includes("findAddressCandidates") ? json({ candidates: [] }) : json([])
    )
    const res = await call("address=nowhere")
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "No geocoding results" })
  })

  it("returns 504 with a timeout message when the request is aborted", async () => {
    vi.useFakeTimers()
    try {
      fetchMock.mockImplementation(
        (_u: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            if (init.signal?.aborted) reject(new Error("aborted"))
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")))
          })
      )
      const p = call("address=slow")
      await vi.advanceTimersByTimeAsync(12_500)
      const res = await p
      expect(res.status).toBe(504)
      expect(await res.json()).toEqual({ error: "Static map request timed out. Please try again." })
    } finally {
      vi.useRealTimers()
    }
  })
})
