import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { SNAPSHOT, SUMMARY, createHistoryFakeDb } from "@/test/history-fake-db"

const mongo = vi.hoisted(() => ({ db: null as unknown }))
vi.mock("@/lib/mongo", () => ({ getMongoDb: async () => mongo.db }))

import { GET as getDetail, PATCH, DELETE } from "@/app/api/history/[id]/route"
import { GET, POST } from "@/app/api/history/route"

const VID = "v_abcdefghijklmnopqrstuvwx"
const cookie: Record<string, string> = { cookie: `sv_vid=${VID}` }

function req(url: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  return new NextRequest(`http://localhost${url}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", ...init.headers },
    body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
  })
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
const HEX = "0123456789abcdef01234567"
const good = { snapshot: SNAPSHOT, summary: SUMMARY }

let fake: ReturnType<typeof createHistoryFakeDb>

beforeEach(() => {
  delete (globalThis as any).__sunnyviewRateLimitBuckets
  vi.restoreAllMocks()
  vi.spyOn(console, "error").mockImplementation(() => {})
  fake = createHistoryFakeDb()
  mongo.db = fake.db
})

describe("GET /api/history", () => {
  it("returns 503 when unconfigured, still setting the visitor cookie", async () => {
    mongo.db = null
    const res = await GET(req("/api/history"))
    expect(res.status).toBe(503)
    expect(res.cookies.get("sv_vid")?.value).toMatch(/^v_/)
  })

  it("rejects an invalid limit with 400", async () => {
    for (const q of ["limit=0", "limit=101", "limit=abc"]) {
      const res = await GET(req(`/api/history?${q}`, { headers: cookie }))
      expect(res.status).toBe(400)
      expect((await res.json()).issues).toBeDefined()
    }
  })

  it("lists items without re-setting an existing cookie", async () => {
    const saved = await POST(req("/api/history", { method: "POST", body: good, headers: cookie }))
    expect(saved.status).toBe(200)
    const res = await GET(req("/api/history?limit=5", { headers: cookie }))
    expect(res.status).toBe(200)
    expect((await res.json()).items).toHaveLength(1)
    expect(res.cookies.get("sv_vid")).toBeUndefined()
  })

  it("maps database errors", async () => {
    fake.collection.find.mockImplementationOnce(() => {
      throw new Error("Server selection timed out")
    })
    expect((await GET(req("/api/history", { headers: cookie }))).status).toBe(503)
    fake.collection.find.mockImplementationOnce(() => {
      throw new Error("kaput")
    })
    const res = await GET(req("/api/history", { headers: cookie }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("Failed to list history.")
  })

  it("rate limits after 90 requests", async () => {
    let last = 200
    for (let i = 0; i < 91; i++) {
      const r = await GET(req("/api/history", { headers: { ...cookie, "x-forwarded-for": "9.9.9.9" } }))
      last = r.status
    }
    expect(last).toBe(429)
  })
})

describe("POST /api/history", () => {
  const post = (body: unknown, headers: Record<string, string> = cookie) =>
    POST(req("/api/history", { method: "POST", body, headers }))

  it("saves and returns the item", async () => {
    const res = await post(good)
    expect(res.status).toBe(200)
    expect((await res.json()).item.title).toBe("1 Market St")
  })

  it("sets a visitor cookie on first request", async () => {
    const res = await post(good, {})
    expect(res.cookies.get("sv_vid")?.httpOnly).toBe(true)
  })

  it("rejects malformed JSON and invalid bodies", async () => {
    expect((await post("{not json")).status).toBe(400)
    expect((await post({})).status).toBe(400)
    expect((await post({ ...good, snapshot: { ...SNAPSHOT, lat: 999 } })).status).toBe(400)
    expect((await post({ ...good, snapshot: { ...SNAPSHOT, geometry: { ...SNAPSHOT.geometry, vertices: [] } } })).status).toBe(400)
  })

  it("rejects oversized payloads by content-length with 413", async () => {
    const res = await post(good, { ...cookie, "content-length": "250001" })
    expect(res.status).toBe(413)
  })

  it("rejects a streamed body over the cap with 413, and an oversized PATCH body too", async () => {
    const big = await POST(req("/api/history", { method: "POST", body: { ...good, pad: "x".repeat(251_000) }, headers: cookie }))
    expect(big.status).toBe(413)
    const patch = await PATCH(
      req(`/api/history/${HEX}`, { method: "PATCH", body: { title: "a", pad: "x".repeat(9_000) }, headers: cookie }),
      ctx(HEX)
    )
    expect(patch.status).toBe(413)
    const declared = await PATCH(
      req(`/api/history/${HEX}`, { method: "PATCH", body: { title: "a" }, headers: { ...cookie, "content-length": "8193" } }),
      ctx(HEX)
    )
    expect(declared.status).toBe(413)
  })

  it("rejects snapshot/summary location mismatch", async () => {
    const res = await post({ ...good, summary: { ...SUMMARY, lat: SUMMARY.lat + 0.01 } })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/mismatch/)
    const res2 = await post({ ...good, summary: { ...SUMMARY, lng: SUMMARY.lng + 0.01 } })
    expect(res2.status).toBe(400)
  })

  it("returns 503 when unconfigured", async () => {
    mongo.db = null
    expect((await post(good)).status).toBe(503)
  })

  it("maps database errors (auth to 503, unknown to 500)", async () => {
    fake.collection.findOne.mockRejectedValueOnce(new Error("bad auth"))
    const res = await post(good)
    expect(res.status).toBe(503)
    expect((await res.json()).error).toMatch(/authentication/)
  })

  it("rate limits after 40 saves", async () => {
    let last = 0
    for (let i = 0; i < 41; i++) last = (await post(good, { ...cookie, "x-forwarded-for": "8.8.8.8" })).status
    expect(last).toBe(429)
  })
})

describe("/api/history/[id]", () => {
  async function seed() {
    const res = await POST(req("/api/history", { method: "POST", body: good, headers: cookie }))
    return (await res.json()).item.id as string
  }
  const call = (fn: typeof PATCH, id: string, body?: unknown, headers = cookie) =>
    fn(req(`/api/history/${id}`, { method: "PATCH", body, headers }), ctx(id))

  it("GET returns the entry, 404 for unknown/foreign/bad id", async () => {
    const id = await seed()
    const ok = await getDetail(req(`/api/history/${id}`, { headers: cookie }), ctx(id))
    expect(ok.status).toBe(200)
    expect((await ok.json()).item.snapshot).toEqual(SNAPSHOT)
    const foreign = await getDetail(
      req(`/api/history/${id}`, { headers: { cookie: "sv_vid=v_someoneelsesomeoneelse" } }),
      ctx(id)
    )
    expect(foreign.status).toBe(404)
    expect((await getDetail(req("/api/history/zzz", { headers: cookie }), ctx("zzz"))).status).toBe(404)
  })

  it("GET: 503 unconfigured, mapped db error, 429", async () => {
    mongo.db = null
    expect((await getDetail(req(`/api/history/${HEX}`, { headers: cookie }), ctx(HEX))).status).toBe(503)
    mongo.db = fake.db
    fake.collection.findOne.mockRejectedValueOnce(new Error("ECONNREFUSED"))
    const mod = { GET: getDetail }
    expect((await mod.GET(req(`/api/history/${HEX}`, { headers: cookie }), ctx(HEX))).status).toBe(503)
    let last = 0
    for (let i = 0; i < 121; i++) {
      last = (await mod.GET(req(`/api/history/${HEX}`, { headers: { ...cookie, "x-forwarded-for": "7.7.7.7" } }), ctx(HEX))).status
    }
    expect(last).toBe(429)
  })

  it("PATCH updates metadata", async () => {
    const id = await seed()
    const res = await call(PATCH, id, { title: "Renamed", pinned: true })
    expect(res.status).toBe(200)
    expect((await res.json()).item).toMatchObject({ title: "Renamed", pinned: true })
  })

  it("PATCH validates body, 404s, 503s, and maps errors", async () => {
    const id = await seed()
    expect((await call(PATCH, id, {})).status).toBe(400)
    expect((await call(PATCH, id, "{bad")).status).toBe(400)
    expect((await call(PATCH, id, { title: "x".repeat(81) })).status).toBe(400)
    expect((await call(PATCH, "nope", { pinned: true })).status).toBe(404)
    fake.collection.findOne.mockRejectedValueOnce(new Error("network blip"))
    expect((await call(PATCH, id, { pinned: true })).status).toBe(503)
    mongo.db = null
    expect((await call(PATCH, id, { pinned: true })).status).toBe(503)
  })

  it("PATCH rate limits after 45", async () => {
    let last = 0
    for (let i = 0; i < 46; i++) last = (await call(PATCH, "nope", { pinned: true }, { ...cookie, "x-forwarded-for": "6.6.6.6" })).status
    expect(last).toBe(429)
  })

  it("DELETE removes, 404s on repeat, 503s, maps errors, rate limits", async () => {
    const id = await seed()
    const del = (i: string, headers = cookie) =>
      DELETE(req(`/api/history/${i}`, { method: "DELETE", headers }), ctx(i))
    expect((await del(id)).status).toBe(200)
    expect((await del(id)).status).toBe(404)
    fake.collection.deleteOne.mockRejectedValueOnce(new Error("weird"))
    const id2 = await seed()
    const failed = await del(id2)
    expect(failed.status).toBe(500)
    mongo.db = null
    expect((await del(id2)).status).toBe(503)
    mongo.db = fake.db
    let last = 0
    for (let i = 0; i < 31; i++) last = (await del("nope", { ...cookie, "x-forwarded-for": "5.5.5.5" })).status
    expect(last).toBe(429)
  })
})
