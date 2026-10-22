import { describe, expect, it } from "vitest"

import { isClearlyCrossSite, isSameOriginRequest, readCappedJson } from "@/lib/request-guards"

function req(headers: Record<string, string> = {}, body?: BodyInit) {
  return new Request("https://app.example.com/api/x", { method: "POST", headers, body })
}

describe("isSameOriginRequest", () => {
  it("accepts same-origin / none and matching Origin only", () => {
    expect(isSameOriginRequest(req({ "sec-fetch-site": "same-origin" }))).toBe(true)
    expect(isSameOriginRequest(req({ "sec-fetch-site": "none" }))).toBe(true)
    expect(isSameOriginRequest(req({ origin: "https://app.example.com" }))).toBe(true)
    expect(isSameOriginRequest(req({ origin: "https://evil.example" }))).toBe(false)
    expect(isSameOriginRequest(req({ "sec-fetch-site": "same-site" }))).toBe(false)
    expect(isSameOriginRequest(req())).toBe(false)
  })
})

describe("isClearlyCrossSite", () => {
  it("flags cross-site and mismatched Origin; allows header-less and same-origin", () => {
    expect(isClearlyCrossSite(req({ "sec-fetch-site": "cross-site" }))).toBe(true)
    expect(isClearlyCrossSite(req({ origin: "https://evil.example" }))).toBe(true)
    expect(isClearlyCrossSite(req({ origin: "null" }))).toBe(true)
    expect(isClearlyCrossSite(req({ "sec-fetch-site": "same-site", origin: "https://sub.example.com" }))).toBe(true)
    expect(isClearlyCrossSite(req())).toBe(false)
    expect(isClearlyCrossSite(req({ "sec-fetch-site": "same-origin" }))).toBe(false)
    expect(isClearlyCrossSite(req({ origin: "https://app.example.com" }))).toBe(false)
  })
})

describe("readCappedJson", () => {
  it("parses JSON within the cap", async () => {
    expect(await readCappedJson(req({}, JSON.stringify({ a: 1 })), 100)).toEqual({ ok: true, body: { a: 1 } })
  })

  it("rejects bad JSON with 400 and empty bodies with 400", async () => {
    expect(await readCappedJson(req({}, "{nope"), 100)).toEqual({ ok: false, status: 400 })
    expect(await readCappedJson(req({}), 100)).toEqual({ ok: false, status: 400 })
  })

  it("413s by declared content-length without reading the body", async () => {
    const r = req({ "content-length": "999" }, "{}")
    expect(await readCappedJson(r, 100)).toEqual({ ok: false, status: 413 })
  })

  it("aborts a stream once the running count passes the cap", async () => {
    let pulled = 0
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1
        controller.enqueue(new TextEncoder().encode("x".repeat(40)))
      },
      cancel() {
        cancelled = true
      },
    })
    const r = new Request("https://app.example.com/x", { method: "POST", body: stream, duplex: "half" } as RequestInit)
    expect(await readCappedJson(r, 100)).toEqual({ ok: false, status: 413 })
    expect(cancelled).toBe(true)
    expect(pulled).toBeLessThan(10)
  })

  it("requires application/json when asked (415), ignoring charset params", async () => {
    expect(await readCappedJson(req({ "content-type": "text/plain" }, "{}"), 100, { requireJson: true })).toEqual({ ok: false, status: 415 })
    expect(await readCappedJson(req({}, "{}"), 100, { requireJson: true })).toEqual({ ok: false, status: 415 })
    const ok = await readCappedJson(req({ "content-type": "application/json; charset=utf-8" }, "{}"), 100, { requireJson: true })
    expect(ok).toEqual({ ok: true, body: {} })
  })
})
