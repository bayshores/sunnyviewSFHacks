import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  MAX_FOOTPRINT_AREA_M2,
  MAX_FOOTPRINT_VERTICES,
  MIN_FOOTPRINT_AREA_M2,
  nominatimFootprintElement,
  nominatimReverse,
  parseFootprintRings,
  type NominatimReverseResult,
} from "@/lib/segment/nominatim"

// Closed GeoJSON ring ([lon, lat]) of a rectangle about (2*dLat*111km) x (2*dLng*88km) at lat 37.
function rectRing(lat: number, lng: number, dLat: number, dLng: number) {
  return [
    [lng - dLng, lat - dLat],
    [lng + dLng, lat - dLat],
    [lng + dLng, lat + dLat],
    [lng - dLng, lat + dLat],
    [lng - dLng, lat - dLat],
  ]
}

function hit(over: Partial<NominatimReverseResult> = {}): NominatimReverseResult {
  return {
    osmType: "way",
    osmId: 41,
    category: "building",
    type: "house",
    address: { house_number: "12", road: "Main Street" },
    footprintRings: parseFootprintRings({ type: "Polygon", coordinates: [rectRing(37, -122, 0.0001, 0.00012)] }),
    ...over,
  }
}

describe("nominatimReverse", () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it("asks for the footprint geometry in the same single reverse request", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        osm_type: "way",
        osm_id: 231853457,
        category: "building",
        type: "yes",
        address: { house_number: "2310", road: "Webster Street" },
        geojson: { type: "Polygon", coordinates: [rectRing(37.43516, -122.13565, 0.0001, 0.0001)] },
      })
    )
    const res = await nominatimReverse({ lat: 37.43516, lng: -122.13565 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [u, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const url = new URL(u)
    expect(url.hostname).toBe("nominatim.openstreetmap.org")
    expect(url.pathname).toBe("/reverse")
    expect(url.searchParams.get("polygon_geojson")).toBe("1")
    expect(url.searchParams.get("extratags")).toBe("1")
    expect((init.headers as Record<string, string>)["user-agent"]).toMatch(/^sunnyviewSFHacks\/1\.0/)
    expect(res.osmType).toBe("way")
    expect(res.osmId).toBe(231853457)
    expect(res.footprintRings).toHaveLength(1)
    // closing point is dropped
    expect(res.footprintRings[0]).toHaveLength(4)
    expect(res.footprintRings[0][0]).toEqual({ lat: 37.43516 - 0.0001, lon: -122.13565 - 0.0001 })
  })

  it("returns no footprint when the hit has no polygon geometry", async () => {
    fetchMock.mockResolvedValue(Response.json({ osm_type: "node", osm_id: 5, geojson: { type: "Point", coordinates: [1, 2] } }))
    expect((await nominatimReverse({ lat: 1, lng: 2 })).footprintRings).toEqual([])
  })
})

describe("parseFootprintRings", () => {
  it("takes the outer ring of each MultiPolygon part", () => {
    const rings = parseFootprintRings({
      type: "MultiPolygon",
      coordinates: [[rectRing(37, -122, 0.0001, 0.0001), rectRing(37, -122, 0.00005, 0.00005)], [rectRing(37.001, -122, 0.0001, 0.0001)]],
    })
    expect(rings).toHaveLength(2)
    expect(rings[1][0].lat).toBeCloseTo(37.0009, 8)
  })

  it("rejects malformed geometry", () => {
    expect(parseFootprintRings(null)).toEqual([])
    expect(parseFootprintRings({ type: "Polygon", coordinates: [[["x", 1], [2, 3], [4, 5]]] })).toEqual([])
    expect(parseFootprintRings({ type: "Polygon", coordinates: [[[1, 2], [3, 4]]] })).toEqual([])
    expect(parseFootprintRings({ type: "LineString", coordinates: [[1, 2], [3, 4]] })).toEqual([])
  })
})

describe("nominatimFootprintElement", () => {
  it("builds a rankable building element with a nominatim id prefix and address tags", () => {
    const el = nominatimFootprintElement(hit())
    expect(el).not.toBeNull()
    expect(el!.type).toBe("nominatim:way")
    expect(el!.id).toBe(41)
    expect(el!.tags).toEqual({ building: "house", "addr:housenumber": "12", "addr:street": "Main Street" })
    expect(el!.geometry).toHaveLength(4)
    expect(el!.members).toBeUndefined()
  })

  it("uses outer members for multipolygon footprints", () => {
    const rings = parseFootprintRings({
      type: "MultiPolygon",
      coordinates: [[rectRing(37, -122, 0.0001, 0.0001)], [rectRing(37.0005, -122, 0.0001, 0.0001)]],
    })
    const el = nominatimFootprintElement(hit({ osmType: "relation", osmId: 9, footprintRings: rings }))
    expect(el!.type).toBe("nominatim:relation")
    expect(el!.geometry).toBeUndefined()
    expect(el!.members?.map((m) => m.role)).toEqual(["outer", "outer"])
  })

  it("ignores hits that are not buildings", () => {
    expect(nominatimFootprintElement(hit({ category: "landuse", type: "residential" }))).toBeNull()
    expect(nominatimFootprintElement(hit({ category: "leisure", type: "park" }))).toBeNull()
    expect(nominatimFootprintElement(hit({ osmType: "node" }))).toBeNull()
    expect(nominatimFootprintElement(hit({ footprintRings: [] }))).toBeNull()
  })

  it("ignores absurdly large or tiny footprints", () => {
    // ~ 222m x 176m = ~39,000 m2 (campus / landuse sized)
    const huge = parseFootprintRings({ type: "Polygon", coordinates: [rectRing(37, -122, 0.001, 0.001)] })
    expect(nominatimFootprintElement(hit({ footprintRings: huge }))).toBeNull()
    // ~ 2.2m x 1.8m = ~4 m2
    const tiny = parseFootprintRings({ type: "Polygon", coordinates: [rectRing(37, -122, 0.00001, 0.00001)] })
    expect(nominatimFootprintElement(hit({ footprintRings: tiny }))).toBeNull()
    expect(MIN_FOOTPRINT_AREA_M2).toBeLessThan(MAX_FOOTPRINT_AREA_M2)
  })

  it("ignores footprints with too many vertices", () => {
    const n = MAX_FOOTPRINT_VERTICES + 1
    const ring = Array.from({ length: n }, (_, i) => {
      const a = (i / n) * 2 * Math.PI
      return { lat: 37 + 0.0002 * Math.sin(a), lon: -122 + 0.0002 * Math.cos(a) }
    })
    expect(nominatimFootprintElement(hit({ footprintRings: [ring] }))).toBeNull()
  })
})
