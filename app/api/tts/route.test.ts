import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { POST } from "./route"

function req(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/tts", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": "9.9.9.9", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

function resetBuckets() {
  delete (globalThis as unknown as { __sunnyviewRateLimitBuckets?: unknown }).__sunnyviewRateLimitBuckets
  delete (globalThis as unknown as { __sunnyviewSpendBudget?: unknown }).__sunnyviewSpendBudget
}

describe("POST /api/tts", () => {
  beforeEach(() => {
    resetBuckets()
    vi.stubEnv("TRUSTED_PROXY_HEADER", "x-real-ip")
    vi.stubEnv("ELEVENLABS_API_KEY", "")
    vi.stubEnv("ELEVENLABS_VOICE_ID", "")
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    resetBuckets()
  })

  it("400s on invalid JSON and invalid schema", async () => {
    expect((await POST(req("{nope"))).status).toBe(400)
    expect((await POST(req({ text: "" }))).status).toBe(400)
  })

  it("returns disabled note when no key", async () => {
    const res = await POST(req({ text: "hi" }))
    expect(res.status).toBe(200)
    expect((await res.json()).audioUrl).toBeNull()
  })

  it("returns a data URL on success, preferring env key and voice", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "envkey")
    vi.stubEnv("ELEVENLABS_VOICE_ID", "envvoice")
    const fetchMock = vi.fn(
      async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } })
    )
    vi.stubGlobal("fetch", fetchMock)
    const res = await POST(req({ text: "hi", voiceId: "bodyvoice" }, { "x-elevenlabs-api-key": "headerkey" }))
    expect(res.status).toBe(200)
    expect((await res.json()).audioUrl).toBe(`data:audio/mpeg;base64,${Buffer.from([1, 2, 3]).toString("base64")}`)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain("/text-to-speech/envvoice")
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("envkey")
  })

  it("rejects a malformed client voiceId with 400 before calling upstream", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1])))
    vi.stubGlobal("fetch", fetchMock)
    for (const voiceId of ["..", "../../v1/user", "short", "abc/defghijklmn", "a".repeat(41)]) {
      const res = await POST(req({ text: "hi", voiceId }, { "x-elevenlabs-api-key": "hk" }))
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: "Invalid voiceId" })
    }
    const viaHeader = await POST(req({ text: "hi" }, { "x-elevenlabs-api-key": "hk", "x-elevenlabs-voice-id": ".." }))
    expect(viaHeader.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("accepts a well-formed client voiceId", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1])))
    vi.stubGlobal("fetch", fetchMock)
    const res = await POST(req({ text: "hi", voiceId: "21m00Tcm4TlvDq8ikWAM" }, { "x-elevenlabs-api-key": "hk" }))
    expect(res.status).toBe(200)
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toContain("/text-to-speech/21m00Tcm4TlvDq8ikWAM")
  })

  it("uses header key and voice when env missing", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1])))
    vi.stubGlobal("fetch", fetchMock)
    const res = await POST(req({ text: "hi" }, { "x-elevenlabs-api-key": "hk", "x-elevenlabs-voice-id": "headerVoice1234" }))
    expect(res.status).toBe(200)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain("/headerVoice1234")
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("hk")
  })

  it("maps upstream errors", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "k")
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad key", { status: 401 })))
    expect((await POST(req({ text: "hi" }))).status).toBe(401)
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })))
    const r500 = await POST(req({ text: "hi" }))
    expect(r500.status).toBe(502)
    expect((await r500.json()).error).toContain("500")
  })

  it("rejects oversized audio by header and by body", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "k")
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array(1), { headers: { "content-length": String(7 * 1024 * 1024) } }))
    )
    expect((await POST(req({ text: "hi" }))).status).toBe(502)
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(6 * 1024 * 1024 + 1))))
    expect((await POST(req({ text: "hi" }))).status).toBe(502)
  })

  it("502s on network error", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "k")
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("boom"))))
    const res = await POST(req({ text: "hi" }))
    expect(res.status).toBe(502)
    expect((await res.json()).error).toBe("boom")
  })

  it("reports a timeout when the request is aborted", async () => {
    vi.useFakeTimers()
    vi.stubEnv("ELEVENLABS_API_KEY", "k")
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_u: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")))
          })
      )
    )
    const p = POST(req({ text: "hi" }))
    await vi.advanceTimersByTimeAsync(18_001)
    const res = await p
    expect(res.status).toBe(502)
    expect((await res.json()).error).toContain("timed out")
  })

  it("429s after the limit with retry-after", async () => {
    for (let i = 0; i < 8; i++) expect((await POST(req({ text: "hi" }))).status).toBe(200)
    const res = await POST(req({ text: "hi" }))
    expect(res.status).toBe(429)
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1)
    expect((await POST(req({ text: "hi" }, { "x-real-ip": "8.8.8.8" }))).status).toBe(200)
  })

  it("pins the model server-side and ignores a client modelId", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "k")
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1]), { headers: { "content-type": "audio/mpeg" } }))
    vi.stubGlobal("fetch", fetchMock)
    await POST(req({ text: "hi", modelId: "eleven_expensive_model" }))
    let sent = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    expect(sent.model_id).toBe("eleven_multilingual_v2")

    vi.stubEnv("ELEVENLABS_MODEL_ID", "eleven_flash_v2_5")
    await POST(req({ text: "hi", modelId: "eleven_expensive_model" }))
    sent = JSON.parse(String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body))
    expect(sent.model_id).toBe("eleven_flash_v2_5")
  })

  it("403s cross-site requests when the server env key would be used, but not with a client key", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1]), { headers: { "content-type": "audio/mpeg" } }))
    vi.stubGlobal("fetch", fetchMock)
    vi.stubEnv("ELEVENLABS_API_KEY", "envkey")
    const res = await POST(req({ text: "hi" }, { "sec-fetch-site": "cross-site" }))
    expect(res.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
    expect((await POST(req({ text: "hi" }, { origin: "https://evil.example" }))).status).toBe(403)
    expect((await POST(req({ text: "hi" }, { "sec-fetch-site": "same-origin" }))).status).toBe(200)

    vi.stubEnv("ELEVENLABS_API_KEY", "")
    const own = await POST(req({ text: "hi" }, { "sec-fetch-site": "cross-site", "x-elevenlabs-api-key": "mine" }))
    expect(own.status).toBe(200)
  })

  it("429s when the global daily budget is exhausted (env key only)", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "envkey")
    vi.stubEnv("TTS_DAILY_BUDGET", "2")
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1]), { headers: { "content-type": "audio/mpeg" } })))
    expect((await POST(req({ text: "hi" }, { "x-real-ip": "1.1.1.1" }))).status).toBe(200)
    expect((await POST(req({ text: "hi" }, { "x-real-ip": "2.2.2.2" }))).status).toBe(200)
    const res = await POST(req({ text: "hi" }, { "x-real-ip": "3.3.3.3" }))
    expect(res.status).toBe(429)
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1)

    vi.stubEnv("ELEVENLABS_API_KEY", "")
    expect((await POST(req({ text: "hi" }, { "x-elevenlabs-api-key": "mine", "x-real-ip": "4.4.4.4" }))).status).toBe(200)
  })

  it("413s oversized bodies", async () => {
    const res = await POST(req({ text: "x", pad: "y".repeat(20_000) }))
    expect(res.status).toBe(413)
  })
})
