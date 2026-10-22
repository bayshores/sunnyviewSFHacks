import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { POST } from "./route"

const GOOD_KEY = "test-gemini-key-not-real-0000000000"

function req(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/gemini-validate", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": "9.9.9.9", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

function resetBuckets() {
  delete (globalThis as unknown as { __sunnyviewRateLimitBuckets?: unknown }).__sunnyviewRateLimitBuckets
}

describe("POST /api/gemini-validate", () => {
  beforeEach(() => {
    resetBuckets()
    vi.stubEnv("GEMINI_API_KEY", "")
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    resetBuckets()
  })

  it("reports missing key and envLoaded", async () => {
    vi.stubEnv("GEMINI_API_KEY", "x")
    const json = await (await POST(req("not json"))).json()
    expect(json).toEqual({ ok: false, error: "Missing API key", envLoaded: true })
  })

  it("rejects malformed keys without calling upstream", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const json = await (await POST(req({ apiKey: "short key" }))).json()
    expect(json.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("validates a good key from header or body", async () => {
    const fetchMock = vi.fn(async () => Response.json({ models: [] }))
    vi.stubGlobal("fetch", fetchMock)
    expect((await (await POST(req({}, { "x-gemini-api-key": GOOD_KEY }))).json()).ok).toBe(true)
    expect((await (await POST(req({ geminiApiKey: GOOD_KEY }))).json()).ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("returns ok:false for upstream non-200, bad payload and network errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 403 })))
    expect((await (await POST(req({ apiKey: GOOD_KEY }))).json()).ok).toBe(false)
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ nothing: true })))
    expect((await (await POST(req({ apiKey: GOOD_KEY }))).json()).ok).toBe(false)
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("down"))))
    expect((await (await POST(req({ apiKey: GOOD_KEY }))).json()).ok).toBe(false)
  })

  it("times out slow upstreams", async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_u: string, init: RequestInit) =>
          new Promise((_r, reject) => init.signal?.addEventListener("abort", () => reject(new Error("abort"))))
      )
    )
    const p = POST(req({ apiKey: GOOD_KEY }))
    await vi.advanceTimersByTimeAsync(3600)
    expect((await (await p).json()).ok).toBe(false)
  })

  it("429s after 20 requests", async () => {
    for (let i = 0; i < 20; i++) expect((await POST(req({}))).status).toBe(200)
    const res = await POST(req({}))
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBeTruthy()
  })

  it("413s oversized bodies without calling upstream", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const res = await POST(req({ apiKey: "k".repeat(5000) }))
    expect(res.status).toBe(413)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
