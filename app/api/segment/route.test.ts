import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { POST } from "./route"

const g = globalThis as any

const ENV_KEYS = ["SEGMENT_SERVICE_URL", "SEGMENT_IMAGE_FETCH_ALLOWLIST", "APP_ORIGIN", "VERCEL_URL", "PORT", "SEGMENT_SHARED_SECRET"] as const
const savedEnv: Record<string, string | undefined> = {}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function post(body: unknown, ip = "4.4.4.4") {
  return POST(
    new Request("http://localhost/api/segment", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify(body),
    })
  )
}

// A small rectangle (about 22m x 20m) centred on lat/lng.
function building(id: number, lat: number, lng: number, dLat = 0.0001, dLng = 0.00012, tags: Record<string, string> = { building: "house" }) {
  const ring = [
    { lat: lat - dLat, lon: lng - dLng },
    { lat: lat - dLat, lon: lng + dLng },
    { lat: lat + dLat, lon: lng + dLng },
    { lat: lat + dLat, lon: lng - dLng },
    { lat: lat - dLat, lon: lng - dLng },
  ]
  return { type: "way", id, tags, geometry: ring }
}

const LAT = 37
const LNG = -122
const META = {
  lat: LAT,
  lng: LNG,
  zoom: 19,
  widthPx: 1040,
  heightPx: 720,
  staticMap: { w: 520, h: 360, scale: 2 },
}
const DATA_URL = "data:image/png;base64,AAAA"

type Handlers = {
  nominatim?: () => Response
  overpass?: (query: string) => Response
  service?: (init: RequestInit, n: number) => Response | Promise<Response>
  image?: () => Response
}

let fetchMock: ReturnType<typeof vi.fn>
let serviceCalls: Array<Record<string, any>>

function install(h: Handlers) {
  serviceCalls = []
  fetchMock.mockImplementation(async (input: any, init: RequestInit = {}) => {
    const url = String(input)
    if (url.includes("nominatim.openstreetmap.org")) return h.nominatim ? h.nominatim() : json({})
    if (url.includes("/api/interpreter")) {
      const query = new URL(url).searchParams.get("data") ?? ""
      return h.overpass ? h.overpass(query) : json({ elements: [] })
    }
    if (url.endsWith("/segment")) {
      serviceCalls.push(JSON.parse(String(init.body)))
      return h.service ? await h.service(init, serviceCalls.length) : json({ roofPolygon: { type: "Polygon", coordinates: [] } })
    }
    if (url.includes("healthz")) throw new Error("no local segmenter")
    if (h.image) return h.image()
    throw new Error(`unexpected fetch ${url}`)
  })
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
  delete g.__sunnyviewRateLimitBuckets
  delete g.__sunnyviewOverpassCache
  delete g.__sunnyviewLocalSegmenterCache
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

describe("POST /api/segment request handling", () => {
  it("returns 400 with issues for an invalid body", async () => {
    install({})
    const res = await post({ clicks: [{ x: 1, y: 2, type: "wat" }] })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe("Invalid body")
    expect(Array.isArray(body.issues)).toBe(true)
  })

  it("returns 413 for an oversized body (declared and streamed) without parsing it", async () => {
    install({})
    const big = "x".repeat(17_000_001)
    const declared = await POST(
      new Request("http://localhost/api/segment", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "5.5.5.5", "content-length": "17000001" },
        body: "{}",
      })
    )
    expect(declared.status).toBe(413)
    const streamed = await post({ imageDataUrl: big }, "5.5.5.6")
    expect(streamed.status).toBe(413)
  })

  it("keeps treating unparseable JSON as an empty body (unchanged behaviour)", async () => {
    install({})
    const res = await POST(
      new Request("http://localhost/api/segment", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "5.5.5.7" },
        body: "{nope",
      })
    )
    expect(res.status).toBe(200)
    expect((await res.json()).source).toBe("fallback_rect")
  })

  it("returns 429 after 18 requests", async () => {
    install({})
    for (let i = 0; i < 18; i++) expect((await post({})).status).toBe(200)
    const res = await post({})
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBeTruthy()
  })
})

describe("POST /api/segment without a segmentation service", () => {
  it("returns the tiny centred rectangle when there is no map metadata", async () => {
    install({})
    const res = await post({})
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      roofPolygon: { type: "Polygon", coordinates: [[[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6]]] },
      source: "fallback_rect",
      confidence: 0.1,
      note: "Auto-outline fallback: SEGMENT_SERVICE_URL not configured and no map metadata available. Using a small rectangle; trace manually or run the Python segmenter.",
    })
  })

  it("echoes a locked client footprint", async () => {
    install({})
    const footprint = { type: "Polygon", coordinates: [[[0.1, 0.1], [0.2, 0.1], [0.2, 0.2], [0.1, 0.2], [0.1, 0.1]]] }
    const res = await post({ meta: { ...META, osmFootprint: footprint } })
    expect(await res.json()).toEqual({ roofPolygon: footprint, source: "osm_footprint_user", confidence: 0.7 })
  })

  it("picks a single confident OSM building", async () => {
    install({ overpass: () => json({ elements: [building(11, LAT, LNG)] }) })
    const res = await post({ meta: META })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.source).toBe("osm_building")
    expect(body.confidence).toBe(0.8)
    expect(body.debug).toMatchObject({ bestId: "way:11", contains: true })
    expect(body.candidates).toBeUndefined()
    const ring = body.roofPolygon.coordinates[0] as number[][]
    expect(body.roofPolygon.type).toBe("Polygon")
    expect(ring).toHaveLength(4)
    for (const [x, y] of ring) {
      expect(x).toBeGreaterThan(0.3)
      expect(x).toBeLessThan(0.7)
      expect(y).toBeGreaterThan(0.3)
      expect(y).toBeLessThan(0.7)
    }
  })

  it("includes ranked candidates alongside a single pick when several buildings exist", async () => {
    install({
      overpass: () =>
        json({
          elements: [
            building(21, LAT, LNG),
            // far enough away that the focus-containing building wins by a wide margin
            building(22, LAT + 0.0006, LNG + 0.0006),
          ],
        }),
    })
    const body = await (await post({ meta: META })).json()
    expect(body.source).toBe("osm_building")
    expect(body.debug.bestId).toBe("way:21")
    expect(body.note).toBe("Multiple buildings found. Click Edit to choose.")
    expect(body.candidates.map((c: any) => c.id)).toEqual(["way:21", "way:22"])
    expect(body.candidates[0]).toMatchObject({
      contains: true,
      tags: { building: "house", housenumber: null, street: null },
    })
  })

  it("returns osm_candidates when no building is a confident match", async () => {
    install({
      overpass: () =>
        json({ elements: [building(31, LAT, LNG, 0.0001, 0.00012), building(32, LAT, LNG, 0.00011, 0.00013)] }),
    })
    const body = await (await post({ meta: META })).json()
    expect(body.source).toBe("osm_candidates")
    expect(body.roofPolygon).toBeUndefined()
    expect(body.candidates).toHaveLength(2)
    expect(body.note).toBe("Multiple buildings found. Click Edit to choose.")
    expect(Object.keys(body.candidates[0]).sort()).toEqual(["addrScore", "contains", "id", "polygon", "score", "tags"])
  })

  it("uses nominatim reverse + overpass by osm id and house-number lookup", async () => {
    const queries: string[] = []
    install({
      nominatim: () => json({ osm_type: "way", osm_id: 41, category: "building", type: "house" }),
      overpass: (q) => {
        queries.push(q)
        if (q.startsWith("[out:json][timeout:10];way(41)")) return json({ elements: [building(41, LAT, LNG)] })
        return json({ elements: [] })
      },
    })
    const body = await (await post({ meta: { ...META, address: "12 Main St, Town" } })).json()
    expect(body.source).toBe("osm_building")
    expect(body.debug.bestId).toBe("way:41")
    expect(queries.some((q) => q.includes("way(41)"))).toBe(true)
    expect(queries.some((q) => q.includes("around:200"))).toBe(true)
    expect(queries.some((q) => q.includes('["addr:housenumber"="12"]') && q.includes("around:260"))).toBe(true)
  })

  it("falls back to a rough rectangle when OSM has no buildings", async () => {
    install({})
    const body = await (await post({ meta: META })).json()
    expect(body.source).toBe("fallback_rect")
    expect(body.confidence).toBe(0.15)
    expect(body.note).toMatch(/^No building footprint found near this address/)
    const ring = body.roofPolygon.coordinates[0] as number[][]
    expect(ring).toHaveLength(4)
    // rectangle is centred in the image
    const xs = ring.map((p) => p[0])
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(0.5, 6)
  })

  it("keeps the fallback rectangle resilient to Overpass and Nominatim failures", async () => {
    install({
      nominatim: () => json({}, 500),
      overpass: () => json({}, 500),
    })
    const res = await post({ meta: META })
    expect(res.status).toBe(200)
    expect((await res.json()).source).toBe("fallback_rect")
  })
})

describe("POST /api/segment with a segmentation service", () => {
  beforeEach(() => {
    process.env.SEGMENT_SERVICE_URL = "http://svc.test/"
  })

  it("forwards the request and returns the service output", async () => {
    install({ service: () => json({ roofPolygon: { type: "Polygon", coordinates: [[[0, 0]]] }, source: "cv" }) })
    const res = await post({ imageDataUrl: DATA_URL, clicks: [{ x: 5, y: 6, type: "pos" }] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ roofPolygon: { type: "Polygon", coordinates: [[[0, 0]]] }, source: "cv" })
    expect(serviceCalls).toHaveLength(1)
    expect(serviceCalls[0]).toEqual({
      imageDataUrl: DATA_URL,
      mode: "roof",
      clicks: [{ x: 5, y: 6, type: "pos" }],
    })
    expect(String(fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/segment"))![0])).toBe("http://svc.test/segment")
  })

  it("guides the segmenter with a locked OSM footprint and merges OSM candidates", async () => {
    install({
      overpass: () => json({ elements: [building(51, LAT, LNG)] }),
      service: () =>
        json({ roofPolygon: { type: "Polygon", coordinates: [] }, candidates: [{ id: "svc-1" }, { id: "way:51", from: "service" }] }),
    })
    const res = await post({ imageDataUrl: DATA_URL, meta: META })
    const body = await res.json()
    expect(res.status).toBe(200)

    const sent = serviceCalls[0]
    expect(sent.meta.osmBestId).toBe("way:51")
    expect(sent.meta.osmSource).toBe("guided")
    expect(sent.meta.osmFootprint.type).toBe("Polygon")
    expect(sent.clicks).toHaveLength(1)
    expect(sent.clicks[0].type).toBe("pos")
    expect(sent.clicks[0].x).toBeGreaterThan(400)
    expect(sent.clicks[0].x).toBeLessThan(640)
    expect(sent.roi.w).toBeGreaterThan(1)
    expect(sent.roi.x).toBeGreaterThanOrEqual(0)

    // service candidate with same id wins; OSM candidates fill in the rest
    expect(body.candidates).toEqual([{ id: "svc-1" }, { id: "way:51", from: "service" }])
  })

  it("adds OSM candidates and note when the service returns none", async () => {
    install({
      overpass: () =>
        json({ elements: [building(61, LAT, LNG, 0.0001, 0.00012), building(62, LAT, LNG, 0.00011, 0.00013)] }),
      service: () => json({ roofPolygon: { type: "Polygon", coordinates: [] } }),
    })
    const body = await (await post({ imageDataUrl: DATA_URL, meta: META })).json()
    expect(body.candidates.map((c: any) => c.id).sort()).toEqual(["way:61", "way:62"])
    expect(body.note).toBe("Multiple buildings found. Click Edit to choose.")
    // not locked, so no osmFootprint is forwarded
    expect(serviceCalls[0].meta.osmFootprint).toBeUndefined()
  })

  it("does not call OSM when the client already locked a footprint", async () => {
    const footprint = { type: "Polygon", coordinates: [[[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6]]] }
    install({})
    await post({ imageDataUrl: DATA_URL, meta: { ...META, osmFootprint: footprint } })
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("nominatim"))).toBe(false)
    const sent = serviceCalls[0]
    expect(sent.clicks).toEqual([{ x: 520, y: 360, type: "pos" }])
    expect(sent.roi).toEqual({ x: 392, y: 264, w: 256, h: 192 })
  })

  it("retries with imageRef when the first attempt fails", async () => {
    install({
      service: (_init, n) => (n === 1 ? json({ error: "bad" }, 422) : json({ ok: true })),
    })
    const res = await post({ imageDataUrl: DATA_URL, clicks: [{ x: 1, y: 1, type: "pos" }] })
    expect(await res.json()).toEqual({ ok: true })
    expect(serviceCalls[0].imageDataUrl).toBe(DATA_URL)
    expect(serviceCalls[1].imageRef).toBe(DATA_URL)
    expect(serviceCalls[1].imageDataUrl).toBeUndefined()
  })

  it("retries once more with an ROI-centre click when no clicks were supplied", async () => {
    install({
      service: (_init, n) => (n < 3 ? json({}, 500) : json({ ok: "third" })),
    })
    const res = await post({ imageDataUrl: DATA_URL, roi: { x: 10, y: 20, w: 100, h: 60 } })
    expect(await res.json()).toEqual({ ok: "third" })
    expect(serviceCalls).toHaveLength(3)
    expect(serviceCalls[2].clicks).toEqual([{ x: 60, y: 50, type: "pos" }])
  })

  it("falls back to the locked OSM outline when the service keeps failing", async () => {
    const footprint = { type: "Polygon", coordinates: [[[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6]]] }
    install({ service: () => json({ detail: "x" }, 500) })
    const body = await (await post({ imageDataUrl: DATA_URL, meta: { ...META, osmFootprint: footprint } })).json()
    expect(body).toEqual({
      roofPolygon: footprint,
      source: "osm_footprint_after_segmenter_error",
      confidence: 0.45,
      note: "CV failed; using OSM outline.",
      debug: { status: 500 },
    })
  })

  it("falls back to a metadata-sized rectangle when the service fails", async () => {
    install({ service: () => json({}, 500) })
    const body = await (await post({ imageDataUrl: DATA_URL, meta: { widthPx: 800, heightPx: 600, zoom: 19 } })).json()
    expect(body.source).toBe("fallback_rect")
    expect(body.confidence).toBe(0.15)
    expect(body.note).toBe("CV failed; using rectangle.")
    expect(body.debug).toEqual({ status: 500 })
    expect(body.roofPolygon.coordinates[0]).toHaveLength(4)
  })

  it("sends x-segment-secret to the service only when SEGMENT_SHARED_SECRET is set", async () => {
    install({})
    await post({ imageDataUrl: DATA_URL })
    const withoutSecret = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/segment"))![1] as RequestInit
    expect((withoutSecret.headers as Record<string, string>)["x-segment-secret"]).toBeUndefined()

    process.env.SEGMENT_SHARED_SECRET = "s3cret"
    fetchMock.mockClear()
    install({})
    await post({ imageDataUrl: DATA_URL })
    const withSecret = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/segment"))![1] as RequestInit
    expect((withSecret.headers as Record<string, string>)["x-segment-secret"]).toBe("s3cret")
  })

  it("drops non-numeric debug fields from forwarded service output", async () => {
    install({
      service: () =>
        json({
          roofPolygon: { type: "Polygon", coordinates: [] },
          confidence: 0.9,
          debug: { samError: "/models/sam.pth missing", onnxError: "boom", iou: 0.8, usedSam: true },
        }),
    })
    const body = await (await post({ imageDataUrl: DATA_URL })).json()
    expect(body.confidence).toBe(0.9)
    expect(body.debug).toEqual({ iou: 0.8, usedSam: true })

    install({ service: () => json({ roofPolygon: null, debug: { error: "trace /srv/x.py" } }) })
    const body2 = await (await post({ imageDataUrl: DATA_URL })).json()
    expect(body2.debug).toBeUndefined()
  })

  it("falls back to the tiny rectangle when the service fails and there is no metadata", async () => {
    install({ service: () => json({}, 500) })
    const body = await (await post({ imageDataUrl: DATA_URL })).json()
    expect(body.source).toBe("fallback_rect")
    expect(body.confidence).toBe(0.1)
    expect(body.roofPolygon.coordinates[0]).toEqual([[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6]])
  })

  it("returns a user-safe payload when the service throws", async () => {
    install({
      service: () => {
        throw new Error("connection refused")
      },
    })
    const body = await (await post({ imageDataUrl: DATA_URL })).json()
    expect(body.source).toBe("fallback_rect")
    expect(body.confidence).toBe(0.1)
    expect(body.note).toBe("CV failed; using rectangle.")
  })

  it("reports a timeout and prefers the locked footprint when the service aborts", async () => {
    const footprint = { type: "Polygon", coordinates: [[[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6]]] }
    install({
      service: () => {
        const e = new Error("aborted")
        e.name = "AbortError"
        throw e
      },
    })
    const body = await (await post({ imageDataUrl: DATA_URL, meta: { ...META, osmFootprint: footprint } })).json()
    expect(body).toEqual({
      roofPolygon: footprint,
      source: "osm_footprint_after_segmenter_exception",
      confidence: 0.45,
      note: "Timeout; using OSM outline.",
    })

    const rect = await (await post({ imageDataUrl: DATA_URL, meta: { widthPx: 800, heightPx: 600, zoom: 19 } })).json()
    expect(rect.note).toBe("Timeout; using rectangle.")
    expect(rect.confidence).toBe(0.15)
  })

  describe("image validation", () => {
    it("requires an image", async () => {
      install({})
      const res = await post({})
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: "Provide imageDataUrl or imageUrl" })
    })

    it("rejects non-image data URLs", async () => {
      install({})
      const res = await post({ imageDataUrl: "data:text/plain;base64,AAAA" })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: "imageDataUrl must be a base64 data:image/* URL" })
    })

    it("returns 413 for payloads over twice the limit", async () => {
      install({})
      const huge = "data:image/png;base64," + "A".repeat(16 * 1024 * 1024)
      const res = await post({ imageDataUrl: huge })
      expect(res.status).toBe(413)
      expect(await res.json()).toEqual({ error: "Image payload exceeds 8MB limit" })
    })

    it("returns 413 when the decoded image exceeds 8MB", async () => {
      install({})
      const big = "data:image/png;base64," + "A".repeat(12 * 1024 * 1024)
      const res = await post({ imageDataUrl: big })
      expect(res.status).toBe(413)
      expect(await res.json()).toEqual({ error: "Image exceeds 8MB limit" })
    })
  })

  describe("imageUrl SSRF checks", () => {
    it("rejects malformed urls with 400", async () => {
      install({})
      const res = await post({ imageUrl: "ftp-ish" })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: "Invalid imageUrl" })
    })

    it("rejects private hosts", async () => {
      install({})
      for (const u of ["http://10.0.0.5/a.png", "https://192.168.1.1/a.png", "https://169.254.169.254/x", "http://foo.local/a.png"]) {
        const res = await post({ imageUrl: u })
        expect(res.status).toBe(502)
        expect(await res.json()).toEqual({ error: "imageUrl host is not allowed" })
      }
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("169.254"))).toBe(false)
    })

    it("rejects public hosts that are not allowlisted", async () => {
      install({})
      const res = await post({ imageUrl: "https://evil.example.com/a.png" })
      expect(res.status).toBe(502)
      expect(await res.json()).toEqual({
        error: "imageUrl host must match this app host or SEGMENT_IMAGE_FETCH_ALLOWLIST",
      })
    })

    it("rejects non-https remote hosts even when allowlisted", async () => {
      process.env.SEGMENT_IMAGE_FETCH_ALLOWLIST = "cdn.example.com"
      install({})
      const res = await post({ imageUrl: "http://cdn.example.com/a.png" })
      expect(res.status).toBe(502)
      expect(await res.json()).toEqual({ error: "imageUrl must use https for remote hosts" })
    })

    it("rejects non-http protocols", async () => {
      install({})
      const res = await post({ imageUrl: "/\\evil.example.com/a.png" })
      expect(res.status).toBe(502)
    })

    it("fetches allowlisted subdomains and forwards the image as a data URL", async () => {
      process.env.SEGMENT_IMAGE_FETCH_ALLOWLIST = "cdn.example.com"
      install({ image: () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } }) })
      const res = await post({ imageUrl: "https://a.cdn.example.com/a.jpg" })
      expect(res.status).toBe(200)
      expect(serviceCalls[0].imageDataUrl).toBe("data:image/jpeg;base64,AQID")
    })

    it("resolves relative urls against the server-configured origin, not the request Host", async () => {
      process.env.APP_ORIGIN = "https://app.example.com"
      install({ image: () => new Response(new Uint8Array([9]), { status: 200, headers: { "content-type": "image/png" } }) })
      const res = await post({ imageUrl: "/api/static-map?lat=1&lng=2" })
      expect(res.status).toBe(200)
      expect(String(fetchMock.mock.calls.find((c) => String(c[0]).includes("static-map"))![0])).toBe(
        "https://app.example.com/api/static-map?lat=1&lng=2"
      )
    })

    it("falls back to the local dev origin when nothing is configured", async () => {
      process.env.PORT = "4321"
      install({ image: () => new Response(new Uint8Array([9]), { status: 200, headers: { "content-type": "image/png" } }) })
      expect((await post({ imageUrl: "/api/static-map?x=1" })).status).toBe(200)
      expect(String(fetchMock.mock.calls.find((c) => String(c[0]).includes("static-map"))![0])).toBe(
        "http://127.0.0.1:4321/api/static-map?x=1"
      )
    })

    it("does not trust the request host: an absolute URL on the request's own private host is rejected", async () => {
      process.env.APP_ORIGIN = "https://app.example.com"
      install({})
      const res = await POST(
        new Request("http://169.254.169.254/api/segment", {
          method: "POST",
          headers: { "content-type": "application/json", host: "169.254.169.254" },
          body: JSON.stringify({ imageUrl: "http://169.254.169.254/latest/meta-data" }),
        })
      )
      expect(res.status).toBe(502)
      expect(await res.json()).toEqual({ error: "imageUrl host is not allowed" })
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("169.254"))).toBe(false)
    })

    it("re-validates redirect targets and refuses redirects to private hosts", async () => {
      process.env.SEGMENT_IMAGE_FETCH_ALLOWLIST = "cdn.example.com"
      install({
        image: () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }),
      })
      const res = await post({ imageUrl: "https://cdn.example.com/a.png" })
      expect(res.status).toBe(502)
      expect(await res.json()).toEqual({ error: "imageUrl host is not allowed" })
      expect(fetchMock.mock.calls.every((c) => (c[1] as RequestInit | undefined)?.redirect !== "follow")).toBe(true)
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("169.254"))).toBe(false)
    })

    it("follows allowed redirects up to 3 hops", async () => {
      process.env.SEGMENT_IMAGE_FETCH_ALLOWLIST = "cdn.example.com"
      let n = 0
      install({
        image: () =>
          n++ < 3
            ? new Response(null, { status: 301, headers: { location: `/hop${n}.png` } })
            : new Response(new Uint8Array([1]), { status: 200, headers: { "content-type": "image/png" } }),
      })
      expect((await post({ imageUrl: "https://cdn.example.com/a.png" })).status).toBe(200)
    })

    it("fails after more than 3 redirects", async () => {
      process.env.SEGMENT_IMAGE_FETCH_ALLOWLIST = "cdn.example.com"
      install({ image: () => new Response(null, { status: 302, headers: { location: "/again.png" } }) })
      const res = await post({ imageUrl: "https://cdn.example.com/a.png" })
      expect(res.status).toBe(502)
      expect(await res.json()).toEqual({ error: "Image fetch followed too many redirects" })
    })

    it("masks unexpected fetch errors so internal hosts are not leaked", async () => {
      process.env.SEGMENT_IMAGE_FETCH_ALLOWLIST = "cdn.example.com"
      vi.spyOn(console, "warn").mockImplementation(() => {})
      install({
        image: () => {
          throw new Error("connect ECONNREFUSED 10.1.2.3:5432")
        },
      })
      const res = await post({ imageUrl: "https://cdn.example.com/a.png" })
      expect(res.status).toBe(502)
      expect(await res.json()).toEqual({ error: "Failed to fetch image" })
    })

    it("returns 502 when the fetched resource is not an image or fails", async () => {
      process.env.SEGMENT_IMAGE_FETCH_ALLOWLIST = "cdn.example.com"
      install({ image: () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }) })
      let res = await post({ imageUrl: "https://cdn.example.com/a" })
      expect(res.status).toBe(502)
      expect(await res.json()).toEqual({ error: "Fetched URL did not return an image" })

      install({ image: () => new Response("", { status: 404 }) })
      res = await post({ imageUrl: "https://cdn.example.com/a" })
      expect(await res.json()).toEqual({ error: "Image fetch failed (404)" })
    })

    it("rejects remote images that exceed the size limit", async () => {
      process.env.SEGMENT_IMAGE_FETCH_ALLOWLIST = "cdn.example.com"
      install({
        image: () =>
          new Response(new Uint8Array(8), {
            status: 200,
            headers: { "content-type": "image/png", "content-length": String(9 * 1024 * 1024) },
          }),
      })
      const res = await post({ imageUrl: "https://cdn.example.com/big.png" })
      expect(res.status).toBe(502)
      expect(await res.json()).toEqual({ error: "Image exceeds 8MB limit" })
    })
  })
})
