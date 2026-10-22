import { afterEach, describe, expect, it, vi } from "vitest"

import { clamp, MERCATOR_MAX_LAT, parseNum, toFiniteNumber } from "@/lib/geo/math"
import {
  mercatorProject,
  mercatorResolutionMetersPerPx,
  mercatorToPixel,
  mercatorUnproject,
  pixelToMercator,
  staticMapTransformFromCenter,
} from "@/lib/geo/mercator"
import {
  fetchEsriCandidates,
  fetchEsriReverseLabel,
  fetchEsriSuggestions,
  fetchNominatimReverse,
  fetchNominatimSearch,
  GeocoderHttpError,
} from "@/lib/geo/providers"
import { norm, normStreet } from "@/lib/geo/street"
import * as segmentMercator from "@/lib/segment/mercator"

describe("geo/math", () => {
  it("clamps", () => {
    expect(clamp(5, 0, 3)).toBe(3)
    expect(clamp(-1, 0, 3)).toBe(0)
    expect(clamp(2, 0, 3)).toBe(2)
  })

  it("parseNum returns finite numbers or null", () => {
    expect(parseNum("1.5")).toBe(1.5)
    expect(parseNum("")).toBeNull()
    expect(parseNum(null)).toBeNull()
    expect(parseNum("abc")).toBeNull()
    expect(parseNum("Infinity")).toBeNull()
  })

  it("toFiniteNumber coerces numbers and numeric strings", () => {
    expect(toFiniteNumber(3)).toBe(3)
    expect(toFiniteNumber("4.5")).toBe(4.5)
    expect(toFiniteNumber(NaN)).toBeNull()
    expect(toFiniteNumber({})).toBeNull()
    expect(toFiniteNumber(undefined)).toBeNull()
  })
})

describe("geo/street", () => {
  it("normalises punctuation, case and whitespace", () => {
    expect(norm("  123  Main-St., Apt #4 ")).toBe("123 main st apt 4")
  })

  it("is unicode aware", () => {
    expect(norm("Calle Ñandú")).toBe("calle ñandú")
  })

  it("expands street abbreviations", () => {
    expect(normStreet("Oak Ave")).toBe("oak avenue")
    expect(normStreet("N 5th St")).toBe("n 5th street")
    expect(normStreet("Sunset Blvd")).toBe("sunset boulevard")
    expect(normStreet("constructor")).toBe("constructor")
  })
})

describe("geo/mercator", () => {
  it("projects and unprojects round-trip", () => {
    const m = mercatorProject(37.5, -122.25)
    const back = mercatorUnproject(m)
    expect(back.lat).toBeCloseTo(37.5, 9)
    expect(back.lng).toBeCloseTo(-122.25, 9)
  })

  it("clamps latitude near the poles", () => {
    expect(mercatorProject(90, 0).y).toBeCloseTo(mercatorProject(MERCATOR_MAX_LAT, 0).y, 6)
  })

  it("computes resolution with rounded and clamped zoom", () => {
    expect(mercatorResolutionMetersPerPx(0)).toBeCloseTo(156543.03392804097, 6)
    expect(mercatorResolutionMetersPerPx(18.4)).toBe(mercatorResolutionMetersPerPx(18))
    expect(mercatorResolutionMetersPerPx(99)).toBe(mercatorResolutionMetersPerPx(22))
  })

  it("maps pixel <-> mercator consistently", () => {
    const tf = staticMapTransformFromCenter({
      lat: 10, lng: 20, zoom: 19, baseW: 520, baseH: 360, scale: 2, widthPx: 1040, heightPx: 720,
    })
    const center = mercatorProject(10, 20)
    const px = mercatorToPixel(center, tf)
    expect(px.x).toBeCloseTo(520, 6)
    expect(px.y).toBeCloseTo(360, 6)
    const m = pixelToMercator(px, tf)
    expect(m.x).toBeCloseTo(center.x, 6)
  })

  it("is re-exported from lib/segment/mercator", () => {
    expect(segmentMercator.mercatorProject).toBe(mercatorProject)
    expect(segmentMercator.clamp).toBe(clamp)
  })
})

describe("geo/providers", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stub(res: Response) {
    const fn = vi.fn().mockResolvedValue(res)
    vi.stubGlobal("fetch", fn)
    return fn
  }
  const signal = new AbortController().signal

  it("fetchEsriCandidates builds the query and tolerates malformed JSON", async () => {
    const fn = stub(Response.json({ candidates: [{ address: "a" }] }))
    const out = await fetchEsriCandidates({ q: "1 Main", limit: 2, biasLat: 1, biasLng: 2, magicKey: "k", signal })
    expect(out).toEqual([{ address: "a" }])
    const url = new URL(fn.mock.calls[0][0])
    expect(url.searchParams.get("location")).toBe("2,1")
    expect(url.searchParams.get("magicKey")).toBe("k")
    expect(url.searchParams.get("countryCode")).toBe("USA")

    stub(new Response("not json", { status: 200 }))
    expect(await fetchEsriCandidates({ q: "x", limit: 1, signal })).toEqual([])
  })

  it("throws GeocoderHttpError on non-2xx", async () => {
    stub(new Response("", { status: 503 }))
    const err = await fetchEsriSuggestions({ q: "x", limit: 1, signal }).catch((e) => e)
    expect(err).toBeInstanceOf(GeocoderHttpError)
    expect(err.status).toBe(503)
    expect(err.message).toBe("Geocoder error (503)")
  })

  it("fetchEsriReverseLabel prefers LongLabel and returns null on errors", async () => {
    stub(Response.json({ address: { LongLabel: " L ", Match_addr: "M" } }))
    expect(await fetchEsriReverseLabel(1, 2, signal)).toBe("L")
    stub(new Response("", { status: 500 }))
    expect(await fetchEsriReverseLabel(1, 2, signal)).toBeNull()
  })

  it("fetchNominatimSearch applies bias, format options and user agent", async () => {
    const fn = stub(Response.json([{ lat: "1", lon: "2" }]))
    const hits = await fetchNominatimSearch({
      q: "x", limit: 3, signal, userAgent: "ua", biasLat: 89.9, biasLng: 179.9, format: "json", dedupe: false, acceptLanguage: null,
    })
    expect(hits).toHaveLength(1)
    const [u, init] = fn.mock.calls[0]
    const url = new URL(u)
    expect(url.searchParams.get("format")).toBe("json")
    expect(url.searchParams.get("dedupe")).toBeNull()
    expect(url.searchParams.get("viewbox")).toBe("179.4,90,180,89.4")
    expect(init.headers).toEqual({ accept: "application/json", "user-agent": "ua" })
  })

  it("fetchNominatimReverse sets extratags only on request", async () => {
    const fn = stub(Response.json({ display_name: "d" }))
    expect(await fetchNominatimReverse({ lat: 1, lng: 2, userAgent: "ua" })).toEqual({ display_name: "d" })
    expect(new URL(fn.mock.calls[0][0]).searchParams.get("extratags")).toBeNull()
    stub(Response.json({}))
    const fn2 = stub(Response.json({}))
    await fetchNominatimReverse({ lat: 1, lng: 2, userAgent: "ua", extratags: true })
    expect(new URL(fn2.mock.calls[0][0]).searchParams.get("extratags")).toBe("1")
  })
})
