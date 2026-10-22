import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { createFakeDb } from "@/test/projects-fake-db"

const mongo = vi.hoisted(() => ({ db: null as unknown }))
vi.mock("@/lib/mongo", () => ({ getMongoDb: async () => mongo.db }))

import { GET as getProject, PATCH } from "@/app/api/projects/[id]/route"
import { POST } from "@/app/api/projects/route"
import { GET as getShare } from "@/app/api/share/[slug]/route"

const OWNER = "v_ownerownerownerowner"
const OTHER = "v_otherotherotherother1"

const site = { lat: 37.77, lng: -122.41, tiltDeg: 20, azimuthDeg: 180, lossesPct: 14 }
const panel = { widthM: 1.1, heightM: 1.7, wattW: 400, gapM: 0.02 }
const geometry = {
  vertices: [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ],
  closed: true,
  mPerPx: 0.1,
  background: "address",
  zoom: 19,
}
const estimate = {
  annualKwh: 5000,
  monthlyKwh: Array.from({ length: 12 }, () => 400),
  annualCo2Kg: 2000,
  source: "pvwatts",
}

function req(
  url: string,
  init: { method?: string; body?: unknown; raw?: string; visitor?: string; ip?: string; headers?: Record<string, string> } = {}
) {
  const headers: Record<string, string> = { "x-forwarded-for": init.ip ?? "1.1.1.1", "content-type": "application/json", ...init.headers }
  if (init.visitor) headers.cookie = `sv_vid=${init.visitor}`
  const body = init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body))
  return new NextRequest(`http://localhost${url}`, { method: init.method ?? "GET", headers, body })
}

const idCtx = (id: string) => ({ params: Promise.resolve({ id }) })
const slugCtx = (slug: string) => ({ params: Promise.resolve({ slug }) })

async function createAs(visitor: string, body: unknown = { name: "Untitled", siteSpec: site, panelSpec: panel }) {
  const res = await POST(req("/api/projects", { method: "POST", body, visitor }))
  return { res, data: (await res.json()) as { projectId: string; shareSlug: string } }
}

beforeEach(() => {
  vi.stubEnv("TRUSTED_PROXY_HEADER", "x-forwarded-for")
  ;(globalThis as { __sunnyviewRateLimitBuckets?: Map<string, unknown> }).__sunnyviewRateLimitBuckets?.clear()
  mongo.db = createFakeDb().db
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("POST /api/projects", () => {
  it("creates a project and returns id + slug, setting a visitor cookie when absent", async () => {
    const res = await POST(req("/api/projects", { method: "POST", body: { name: "Untitled", siteSpec: site, panelSpec: panel } }))
    expect(res.status).toBe(201)
    const data = await res.json()
    expect(data.projectId).toMatch(/^[a-f0-9]{24}$/)
    expect(data.shareSlug.length).toBeGreaterThanOrEqual(10)
    expect(res.headers.get("set-cookie")).toContain("sv_vid=")
  })

  it("accepts an empty-ish body", async () => {
    const { res } = await createAs(OWNER, {})
    expect(res.status).toBe(201)
  })

  it("rejects invalid input with 400 and issues", async () => {
    const res = await POST(req("/api/projects", { method: "POST", body: { siteSpec: { ...site, lat: 999 } } }))
    expect(res.status).toBe(400)
    expect((await res.json()).issues).toBeDefined()
  })

  it("rejects malformed JSON with 400 and oversized with 413", async () => {
    expect((await POST(req("/api/projects", { method: "POST", raw: "{nope" }))).status).toBe(400)
    const big = JSON.stringify({ name: "x".repeat(260_000) })
    expect((await POST(req("/api/projects", { method: "POST", raw: big }))).status).toBe(413)
  })

  it("415s non-JSON content types and 403s clearly cross-site mutations", async () => {
    const text = await POST(req("/api/projects", { method: "POST", body: {}, headers: { "content-type": "text/plain" } }))
    expect(text.status).toBe(415)
    const cross = await POST(req("/api/projects", { method: "POST", body: {}, headers: { "sec-fetch-site": "cross-site" } }))
    expect(cross.status).toBe(403)
    const badOrigin = await POST(req("/api/projects", { method: "POST", body: {}, headers: { origin: "https://evil.example" } }))
    expect(badOrigin.status).toBe(403)
    const sameOrigin = await POST(
      req("/api/projects", { method: "POST", body: {}, headers: { origin: "http://localhost", "sec-fetch-site": "same-origin" } })
    )
    expect(sameOrigin.status).toBe(201)
  })

  it("returns 503 when mongo is not configured", async () => {
    mongo.db = null
    const res = await POST(req("/api/projects", { method: "POST", body: {} }))
    expect(res.status).toBe(503)
    expect((await res.json()).error).toMatch(/not configured/i)
  })

  it("maps db failures to 503/500 without leaking details", async () => {
    const { db, collection } = createFakeDb()
    collection.createIndex.mockRejectedValue(new Error("ECONNREFUSED secret-host"))
    mongo.db = db
    const res = await POST(req("/api/projects", { method: "POST", body: {} }))
    expect(res.status).toBe(503)
    expect(JSON.stringify(await res.json())).not.toContain("secret-host")
  })

  it("does not reveal credential problems to callers", async () => {
    const { db, collection } = createFakeDb()
    collection.createIndex.mockRejectedValue(new Error("Authentication failed."))
    mongo.db = db
    const res = await POST(req("/api/projects", { method: "POST", body: {} }))
    expect(res.status).toBe(503)
    const text = JSON.stringify(await res.json())
    expect(text).not.toMatch(/authentication|credential/i)
    expect(text).toMatch(/temporarily unavailable/)
  })

  it("returns 429 once the rate limit is exceeded", async () => {
    let last = 0
    for (let i = 0; i < 25; i++) {
      last = (await POST(req("/api/projects", { method: "POST", body: {}, ip: "9.9.9.9" }))).status
    }
    expect(last).toBe(429)
  })
})

describe("GET /api/projects/[id]", () => {
  it("returns the project to its owner only", async () => {
    const { data } = await createAs(OWNER)
    const ok = await getProject(req(`/api/projects/${data.projectId}`, { visitor: OWNER }), idCtx(data.projectId))
    expect(ok.status).toBe(200)
    const body = await ok.json()
    expect(body.project.shareSlug).toBe(data.shareSlug)
    expect(body.project.siteSpec).toEqual(site)
    expect(JSON.stringify(body)).not.toContain(OWNER)

    const foreign = await getProject(req(`/api/projects/${data.projectId}`, { visitor: OTHER }), idCtx(data.projectId))
    expect(foreign.status).toBe(404)
    const anon = await getProject(req(`/api/projects/${data.projectId}`), idCtx(data.projectId))
    expect(anon.status).toBe(404)
  })

  it("404s on bad ObjectId and 503s when unconfigured", async () => {
    expect((await getProject(req("/api/projects/xyz", { visitor: OWNER }), idCtx("xyz"))).status).toBe(404)
    mongo.db = null
    expect((await getProject(req("/api/projects/abc"), idCtx("abc"))).status).toBe(503)
  })
})

describe("PATCH /api/projects/[id]", () => {
  const full = { siteSpec: site, panelSpec: panel, layoutSummary: { dcKw: 4, panelCount: 10, orientationDeg: 0 }, geometry, estimate }

  it("lets the owner update the full client payload", async () => {
    const { data } = await createAs(OWNER)
    const res = await PATCH(
      req(`/api/projects/${data.projectId}`, { method: "PATCH", body: full, visitor: OWNER }),
      idCtx(data.projectId)
    )
    expect(res.status).toBe(200)
    const { project } = await res.json()
    expect(project.estimate.annualKwh).toBe(5000)
    expect(project.geometry.vertices).toHaveLength(3)
  })

  it("accepts a null mPerPx and a null estimate", async () => {
    const { data } = await createAs(OWNER)
    const res = await PATCH(
      req(`/api/projects/${data.projectId}`, {
        method: "PATCH",
        body: { geometry: { ...geometry, mPerPx: null }, estimate: null },
        visitor: OWNER,
      }),
      idCtx(data.projectId)
    )
    expect(res.status).toBe(200)
  })

  it("404s for non-owners and bad ids", async () => {
    const { data } = await createAs(OWNER)
    const foreign = await PATCH(
      req(`/api/projects/${data.projectId}`, { method: "PATCH", body: full, visitor: OTHER }),
      idCtx(data.projectId)
    )
    expect(foreign.status).toBe(404)
    const bad = await PATCH(req("/api/projects/nope", { method: "PATCH", body: full, visitor: OWNER }), idCtx("nope"))
    expect(bad.status).toBe(404)
  })

  it.each([
    ["empty object", {}],
    ["unknown key", { visitorId: "evil" }],
    ["bad lat", { siteSpec: { ...site, lat: 123 } }],
    ["NaN-ish string", { siteSpec: { ...site, tiltDeg: "20" } }],
    ["monthlyKwh length", { estimate: { ...estimate, monthlyKwh: [1, 2, 3] } }],
    ["too many vertices", { geometry: { ...geometry, vertices: Array.from({ length: 161 }, () => ({ x: 1, y: 1 })) } }],
    ["bad background", { geometry: { ...geometry, background: "data:image/png;base64,AAAA" } }],
  ])("rejects %s with 400", async (_label, body) => {
    const { data } = await createAs(OWNER)
    const res = await PATCH(
      req(`/api/projects/${data.projectId}`, { method: "PATCH", body, visitor: OWNER }),
      idCtx(data.projectId)
    )
    expect(res.status).toBe(400)
  })

  it("403s cross-site and 415s non-JSON PATCH requests", async () => {
    const { data } = await createAs(OWNER)
    const cross = await PATCH(
      req(`/api/projects/${data.projectId}`, { method: "PATCH", body: { name: "a" }, visitor: OWNER, headers: { "sec-fetch-site": "cross-site" } }),
      idCtx(data.projectId)
    )
    expect(cross.status).toBe(403)
    const text = await PATCH(
      req(`/api/projects/${data.projectId}`, { method: "PATCH", body: { name: "a" }, visitor: OWNER, headers: { "content-type": "text/plain" } }),
      idCtx(data.projectId)
    )
    expect(text.status).toBe(415)
  })

  it("rejects oversized payloads with 413", async () => {
    const { data } = await createAs(OWNER)
    const raw = JSON.stringify({ name: "y".repeat(300_000) })
    const res = await PATCH(
      req(`/api/projects/${data.projectId}`, { method: "PATCH", raw, visitor: OWNER }),
      idCtx(data.projectId)
    )
    expect(res.status).toBe(413)
  })

  it("503s when unconfigured and 429s when rate limited", async () => {
    mongo.db = null
    const res = await PATCH(req("/api/projects/abc", { method: "PATCH", body: { name: "a" } }), idCtx("abc"))
    expect(res.status).toBe(503)

    let last = 0
    for (let i = 0; i < 95; i++) {
      last = (await PATCH(req("/api/projects/abc", { method: "PATCH", body: { name: "a" }, ip: "8.8.8.8" }), idCtx("abc"))).status
    }
    expect(last).toBe(429)
  })
})

describe("GET /api/share/[slug]", () => {
  it("serves a public projection without owner info and with cache headers", async () => {
    const { data } = await createAs(OWNER)
    await PATCH(
      req(`/api/projects/${data.projectId}`, { method: "PATCH", body: { geometry, estimate }, visitor: OWNER }),
      idCtx(data.projectId)
    )

    const res = await getShare(req(`/api/share/${data.shareSlug}`), slugCtx(data.shareSlug))
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toContain("public")
    expect(res.headers.get("set-cookie")).toBeNull()
    const text = JSON.stringify(await res.json())
    expect(text).not.toContain(OWNER)
    expect(text).not.toContain("visitorId")
    expect(text).not.toContain(data.projectId)
    expect(text).toContain("annualKwh")
  })

  it("404s for unknown or malformed slugs, 503 unconfigured, 429 limited", async () => {
    expect((await getShare(req("/api/share/unknownslug123"), slugCtx("unknownslug123"))).status).toBe(404)
    expect((await getShare(req("/api/share/x"), slugCtx("x"))).status).toBe(404)

    mongo.db = null
    expect((await getShare(req("/api/share/unknownslug123"), slugCtx("unknownslug123"))).status).toBe(503)

    let last = 0
    for (let i = 0; i < 125; i++) {
      last = (await getShare(req("/api/share/unknownslug123", { ip: "7.7.7.7" }), slugCtx("unknownslug123"))).status
    }
    expect(last).toBe(429)
  })
})
