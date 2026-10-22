import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { POST } from "./route"

function req(body: unknown, ip = "9.9.9.9") {
  return new Request("http://localhost/api/explain", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

function resetBuckets() {
  delete (globalThis as unknown as { __sunnyviewRateLimitBuckets?: unknown }).__sunnyviewRateLimitBuckets
}

describe("POST /api/explain", () => {
  beforeEach(resetBuckets)
  afterEach(resetBuckets)

  it("400s on bad JSON and bad schema", async () => {
    expect((await POST(req("{x"))).status).toBe(400)
    expect((await POST(req({ estimate: {} }))).status).toBe(400)
  })

  it("413s on an oversized body", async () => {
    const res = await POST(req({ estimate: { annualKwh: 1 }, userGoal: "x".repeat(20_000) }, "8.8.8.3"))
    expect(res.status).toBe(413)
    const declared = new Request("http://localhost/api/explain", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "8.8.8.4", "content-length": "16385" },
      body: "{}",
    })
    expect((await POST(declared)).status).toBe(413)
  })

  it("explains an estimate", async () => {
    const res = await POST(req({ estimate: { annualKwh: 7000.4, annualCo2Kg: 2800 } }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.bullets).toHaveLength(3)
    expect(json.bullets[0]).toContain("7")
    expect(json.caveats).toEqual([json.caveat])
  })

  it("falls back to co2 and then 0", async () => {
    const a = await (await POST(req({ estimate: { annualKwh: 1, co2: 500 } }))).json()
    expect(a.bullets[1]).toContain("500")
    const b = await (await POST(req({ estimate: { annualKwh: 1 } }))).json()
    expect(b.bullets[1]).toContain("about 0 kg")
  })

  it("429s after 60 requests", async () => {
    for (let i = 0; i < 60; i++) expect((await POST(req({ estimate: { annualKwh: 1 } }))).status).toBe(200)
    const res = await POST(req({ estimate: { annualKwh: 1 } }))
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBeTruthy()
  })
})
