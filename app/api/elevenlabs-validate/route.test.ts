import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { POST } from "./route"

const GOOD_KEY = "sk_example_key_1234567890"

function req(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/elevenlabs-validate", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": "9.9.9.9", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

function resetBuckets() {
  delete (globalThis as unknown as { __sunnyviewRateLimitBuckets?: unknown }).__sunnyviewRateLimitBuckets
}

describe("POST /api/elevenlabs-validate", () => {
  beforeEach(() => {
    resetBuckets()
    vi.stubEnv("ELEVENLABS_API_KEY", "")
    vi.stubEnv("ELEVENLABS_VOICE_ID", "")
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    resetBuckets()
  })

  it("reports missing key with env flags", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "k")
    vi.stubEnv("ELEVENLABS_VOICE_ID", "v")
    const json = await (await POST(req("bad json"))).json()
    expect(json).toEqual({ ok: false, error: "Missing API key", envLoaded: true, voiceEnvLoaded: true })
  })

  it("rejects malformed keys without calling upstream", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    expect((await (await POST(req({ apiKey: "has space in it but is long enough" }))).json()).ok).toBe(false)
    expect((await (await POST(req({ apiKey: "tooshort" }))).json()).ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("validates a good key", async () => {
    const fetchMock = vi.fn(async () => Response.json({ subscription: {} }))
    vi.stubGlobal("fetch", fetchMock)
    expect((await (await POST(req({}, { "x-elevenlabs-api-key": GOOD_KEY }))).json()).ok).toBe(true)
    expect((await (await POST(req({ elevenLabsApiKey: GOOD_KEY }))).json()).ok).toBe(true)
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe(GOOD_KEY)
  })

  it("returns ok:false for upstream failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })))
    expect((await (await POST(req({ apiKey: GOOD_KEY }))).json()).ok).toBe(false)
    vi.stubGlobal("fetch", vi.fn(async () => new Response("null", { status: 200 })))
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
