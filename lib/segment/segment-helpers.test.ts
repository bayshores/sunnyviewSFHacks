import { afterEach, describe, expect, it, vi } from "vitest"

import { extractGeojsonRingNorm, fallbackRectRoofPolygon, roiFromPixelPoints } from "@/lib/segment/geometry"
import { mergeOsmCandidates, osmCandidateExtras, readMetaValues, hasMapMeta } from "@/lib/segment/guidance"
import { estimateDataUrlBytes, readBufferWithLimit } from "@/lib/segment/image"
import { getAppOrigin, hostAllowed, isPrivateHostname, readHostAllowlist, resolveAllowedImageUrl } from "@/lib/segment/ssrf"

describe("segment/ssrf", () => {
  const original = process.env.SEGMENT_IMAGE_FETCH_ALLOWLIST
  afterEach(() => {
    if (original === undefined) delete process.env.SEGMENT_IMAGE_FETCH_ALLOWLIST
    else process.env.SEGMENT_IMAGE_FETCH_ALLOWLIST = original
  })

  it("parses the allowlist", () => {
    process.env.SEGMENT_IMAGE_FETCH_ALLOWLIST = " A.com, ,b.org "
    expect(readHostAllowlist()).toEqual(["a.com", "b.org"])
  })

  it("flags private hostnames", () => {
    for (const h of ["", "localhost", "a.localhost", "x.local", "10.1.2.3", "127.0.0.1", "169.254.1.1", "172.16.0.1", "172.31.9.9", "192.168.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1"]) {
      expect(isPrivateHostname(h), h).toBe(true)
    }
    for (const h of ["example.com", "172.32.0.1", "8.8.8.8"]) expect(isPrivateHostname(h), h).toBe(false)
  })

  it("handles bracketed, mapped and special-range IP literals", () => {
    for (const h of [
      "[::1]", "[::]", "[::ffff:127.0.0.1]", "::ffff:127.0.0.1", "[::ffff:7f00:1]", "::ffff:10.0.0.1", "::ffff:a9fe:a9fe",
      "[fd12:3456::1]", "[fe80::1%25eth0]", "[fc00::1]", "0.1.2.3", "100.64.0.1", "100.127.255.255", "[64:ff9b::7f00:1]",
      "localhost.", "metadata.internal", "255.255.255.255", "[ff02::1]", "[not:an:ip::zz]",
    ]) {
      expect(isPrivateHostname(h), h).toBe(true)
    }
    for (const h of ["100.63.255.255", "100.128.0.1", "[2606:4700:4700::1111]", "::ffff:8.8.8.8", "fda.gov", "fc.example.com", "fd.org", "fe80.example.com", "1.1.1.1"]) {
      expect(isPrivateHostname(h), h).toBe(false)
    }
  })

  it("derives the app origin from server config only", () => {
    expect(getAppOrigin({ APP_ORIGIN: "https://app.example.com/path" })).toBe("https://app.example.com")
    expect(getAppOrigin({ VERCEL_URL: "my-app.vercel.app" })).toBe("https://my-app.vercel.app")
    expect(getAppOrigin({ PORT: "4000" })).toBe("http://127.0.0.1:4000")
    expect(getAppOrigin({})).toBe("http://127.0.0.1:3000")
    expect(getAppOrigin({ APP_ORIGIN: "not a url", PORT: "x" })).toBe("http://127.0.0.1:3000")
    expect(getAppOrigin({ NODE_ENV: "development" })).toBe("http://127.0.0.1:3000")
  })

  it("in production, keeps configured origins but has no loopback fallback", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(getAppOrigin({ NODE_ENV: "production", APP_ORIGIN: "https://app.example.com" })).toBe("https://app.example.com")
    expect(getAppOrigin({ NODE_ENV: "production", VERCEL_URL: "my-app.vercel.app" })).toBe("https://my-app.vercel.app")
    expect(getAppOrigin({ NODE_ENV: "production", PORT: "4000" })).toBeNull()
    expect(getAppOrigin({ NODE_ENV: "production", APP_ORIGIN: "not a url" })).toBeNull()
    vi.restoreAllMocks()
  })

  it("warns only once when the app origin is unavailable in production", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.resetModules()
    const fresh = await import("@/lib/segment/ssrf")
    fresh.getAppOrigin({ NODE_ENV: "production" })
    fresh.getAppOrigin({ NODE_ENV: "production" })
    expect(warn).toHaveBeenCalledTimes(1)
    vi.restoreAllMocks()
  })

  it("without an app origin, rejects relative and loopback URLs but allows allowlisted https", () => {
    const msg = /SEGMENT_IMAGE_FETCH_ALLOWLIST/
    expect(() => resolveAllowedImageUrl("/api/static-map?x=1", ["cdn.com"], null)).toThrow(msg)
    expect(() => resolveAllowedImageUrl("//evil.com/x", ["evil.com"], null)).toThrow(msg)
    expect(() => resolveAllowedImageUrl("http://127.0.0.1:3000/api/anything", ["127.0.0.1"], null)).toThrow("imageUrl host is not allowed")
    expect(() => resolveAllowedImageUrl("https://other.com/x", ["cdn.com"], null)).toThrow(msg)
    expect(resolveAllowedImageUrl("https://cdn.com/x.png", ["cdn.com"], null).hostname).toBe("cdn.com")
  })

  it("matches allowlisted hosts and their subdomains only", () => {
    expect(hostAllowed("a.com", ["a.com"])).toBe(true)
    expect(hostAllowed("x.a.com", ["a.com"])).toBe(true)
    expect(hostAllowed("evila.com", ["a.com"])).toBe(false)
    expect(hostAllowed("me.com", [])).toBe(false)
  })

  it("enforces the full policy", () => {
    const app = "https://app.example.com"
    expect(resolveAllowedImageUrl("/img.png", [], app).toString()).toBe("https://app.example.com/img.png")
    expect(resolveAllowedImageUrl("https://app.example.com/x", [], app).hostname).toBe("app.example.com")
    expect(() => resolveAllowedImageUrl("ftp://app.example.com/x", [], app)).toThrow("imageUrl must use http(s)")
    expect(() => resolveAllowedImageUrl("http://10.0.0.1/x", [], app)).toThrow("imageUrl host is not allowed")
    expect(() => resolveAllowedImageUrl("http://[::ffff:127.0.0.1]/x", [], app)).toThrow("imageUrl host is not allowed")
    expect(() => resolveAllowedImageUrl("https://user:pw@cdn.com/x", ["cdn.com"], app)).toThrow("imageUrl host is not allowed")
    expect(() => resolveAllowedImageUrl("//evil.com/x", [], app)).toThrow(/SEGMENT_IMAGE_FETCH_ALLOWLIST/)
    expect(() => resolveAllowedImageUrl("/\\evil.com/x", [], app)).toThrow(/SEGMENT_IMAGE_FETCH_ALLOWLIST/)
    expect(() => resolveAllowedImageUrl("https://other.com/x", [], app)).toThrow(/SEGMENT_IMAGE_FETCH_ALLOWLIST/)
    expect(() => resolveAllowedImageUrl("http://cdn.com/x", ["cdn.com"], app)).toThrow("imageUrl must use https for remote hosts")
    expect(resolveAllowedImageUrl("https://cdn.com/x", ["cdn.com"], app).hostname).toBe("cdn.com")
  })

  it("never treats a private host as allowed just because it is allowlisted or matches the request", () => {
    const app = "https://app.example.com"
    expect(() => resolveAllowedImageUrl("http://127.0.0.1/x", ["127.0.0.1"], app)).toThrow("imageUrl host is not allowed")
    expect(() => resolveAllowedImageUrl("http://localhost:3000/x", [], app)).toThrow("imageUrl host is not allowed")
    // local dev: the configured origin itself is the only private host allowed
    expect(resolveAllowedImageUrl("/api/static-map", [], "http://127.0.0.1:3000").hostname).toBe("127.0.0.1")
  })
})

describe("segment/image", () => {
  it("estimates data URL sizes", () => {
    expect(estimateDataUrlBytes("data:image/png;base64,AAAA")).toBe(3)
    expect(estimateDataUrlBytes("data:image/png;base64,AA==")).toBe(1)
    expect(estimateDataUrlBytes("data:text/plain;base64,AAAA")).toBeNull()
    expect(estimateDataUrlBytes("nope")).toBeNull()
    expect(estimateDataUrlBytes("data:image/png;base64,")).toBeNull()
  })

  it("reads bodies up to the limit and rejects beyond it", async () => {
    const small = new Response(new Uint8Array([1, 2, 3]))
    expect(new Uint8Array(await readBufferWithLimit(small, 10))).toEqual(new Uint8Array([1, 2, 3]))
    await expect(readBufferWithLimit(new Response(new Uint8Array(20)), 10)).rejects.toThrow("exceeds")
    const declared = new Response("x", { headers: { "content-length": String(99 * 1024 * 1024) } })
    await expect(readBufferWithLimit(declared, 8 * 1024 * 1024)).rejects.toThrow("Image exceeds 8MB limit")
  })

  it("cancels the stream when the limit is exceeded", async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(6))
      },
      cancel,
    })
    await expect(readBufferWithLimit(new Response(body), 10)).rejects.toThrow("exceeds")
    expect(cancel).toHaveBeenCalledTimes(1)
  })
})

describe("segment/geometry", () => {
  it("extracts rings from polygons, features and bare coordinates", () => {
    const ring = [[0, 0], [1, 0], [1, 1], [0, 0]]
    expect(extractGeojsonRingNorm({ type: "Polygon", coordinates: [ring] })).toEqual([[0, 0], [1, 0], [1, 1]])
    expect(extractGeojsonRingNorm({ type: "Feature", geometry: { type: "MultiPolygon", coordinates: [[ring]] } })).toHaveLength(3)
    expect(extractGeojsonRingNorm({ coordinates: [[0, 0], [1, 0], [1, 1]] })).toHaveLength(3)
    expect(extractGeojsonRingNorm({ type: "Polygon", coordinates: [[[0, 0], [1, 1]]] })).toBeNull()
    expect(extractGeojsonRingNorm({ type: "Polygon", coordinates: [[[0, "x"], [1, 0], [1, 1]]] })).toBeNull()
    expect(extractGeojsonRingNorm(null)).toBeNull()
  })

  it("builds a centred fallback rectangle", () => {
    const poly = fallbackRectRoofPolygon({ widthPx: 1040, heightPx: 720, zoom: 19, scale: 2 })
    const ring = poly.coordinates[0]
    expect(ring).toHaveLength(4)
    const xs = ring.map((p) => p[0])
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(0.5, 9)
    // deterministic
    expect(fallbackRectRoofPolygon({ widthPx: 1040, heightPx: 720, zoom: 19, scale: 2 })).toEqual(poly)
  })

  it("pads and clamps ROIs", () => {
    expect(roiFromPixelPoints([{ x: 10, y: 10 }, { x: 50, y: 30 }], 100, 100)).toEqual({ x: 0, y: 0, w: 88, h: 68 })
    const r = roiFromPixelPoints([{ x: 200, y: 200 }, { x: 300, y: 260 }], 1000, 1000)
    expect(r).toEqual({ x: 176, y: 176, w: 148, h: 108 })
  })
})

describe("segment/guidance helpers", () => {
  it("reads metadata values defensively", () => {
    const v = readMetaValues({ lat: "1", lng: 2, zoom: 3, widthPx: 4, heightPx: 5, address: "a", staticMap: { scale: "2" } })
    expect(v).toMatchObject({ lat: 1, lng: 2, zoom: 3, widthPx: 4, heightPx: 5, address: "a", staticScale: 2 })
    expect(hasMapMeta(v)).toBe(true)
    const empty = readMetaValues(undefined)
    expect(empty.lat).toBeNull()
    expect(hasMapMeta(empty)).toBe(false)
  })

  it("merges candidates without mutating the service output", () => {
    const out = { candidates: [{ id: "a", from: "svc" }] }
    const merged = mergeOsmCandidates(out, [{ id: "a" }, { id: "b" }], "note")
    expect(merged).toEqual({ candidates: [{ id: "a", from: "svc" }, { id: "b" }], note: "note" })
    expect(out).toEqual({ candidates: [{ id: "a", from: "svc" }] })
    expect(mergeOsmCandidates({ note: "keep" }, [{ id: "b" }], "n").note).toBe("keep")
    expect(mergeOsmCandidates(out, null, "n")).toBe(out)
    expect(mergeOsmCandidates(out, [], "n")).toBe(out)
  })

  it("builds fallback extras", () => {
    expect(osmCandidateExtras(null, "n")).toEqual({})
    expect(osmCandidateExtras([{ id: "a" }], null)).toEqual({ candidates: [{ id: "a" }] })
    expect(osmCandidateExtras([{ id: "a" }], "n")).toEqual({ candidates: [{ id: "a" }], note: "n" })
  })
})
