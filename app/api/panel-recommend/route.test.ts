import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { POST } from "./route"

const OPTION = {
  id: "p1",
  label: "Panel 1",
  brand: "Acme",
  model: "A-400",
  sourceUrl: "https://example.com/a400",
  spec: { widthM: 1.1, heightM: 1.8, wattW: 400 },
  fit: { panelCount: 10, dcKw: 4 },
}

function req(body: unknown, headers: Record<string, string> = {}, url = "http://evil.example/api/panel-recommend") {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": "9.9.9.9", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

const VALID = { lat: 37.77, lng: -122.42, roofAreaM2: 50, options: [OPTION] }

function geminiOk(payload: unknown = { selectedId: "p1", brand: "Acme", model: "A-400", sourceUrl: "https://example.com/a400", why: ["a", "b"], caveats: ["c"] }) {
  return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] })
}

type FetchHandlers = { gemini?: (init: RequestInit) => Response | Promise<Response> }

function mockFetch(handlers: FetchHandlers = {}) {
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.includes("generativelanguage.googleapis.com")) return handlers.gemini ? handlers.gemini(init) : geminiOk()
    if (url.includes("api.open-meteo.com")) {
      return Response.json({ daily: { shortwave_radiation_sum: [18, 18], cloudcover_mean: [20, 40] } })
    }
    if (url.includes("services.arcgisonline.com")) {
      return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } })
    }
    throw new Error(`unexpected fetch ${url}`)
  })
  vi.stubGlobal("fetch", fn)
  return fn
}

function resetBuckets() {
  delete (globalThis as unknown as { __sunnyviewRateLimitBuckets?: unknown }).__sunnyviewRateLimitBuckets
  delete (globalThis as unknown as { __sunnyviewSpendBudget?: unknown }).__sunnyviewSpendBudget
}

describe("POST /api/panel-recommend", () => {
  beforeEach(() => {
    resetBuckets()
    vi.stubEnv("GEMINI_API_KEY", "envkey")
    vi.spyOn(console, "info").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
    resetBuckets()
  })

  it("400s with issues on invalid body", async () => {
    mockFetch()
    const res = await POST(req({ roofAreaM2: -1, options: [] }))
    expect(res.status).toBe(400)
    expect(Array.isArray((await res.json()).issues)).toBe(true)
    expect((await POST(req("not json"))).status).toBe(400)
  })

  it("401s without any API key", async () => {
    vi.stubEnv("GEMINI_API_KEY", "")
    mockFetch()
    expect((await POST(req(VALID))).status).toBe(401)
  })

  it("returns a recommendation and never fetches a URL derived from the request host", async () => {
    const f = mockFetch()
    const res = await POST(req(VALID))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.selectedId).toBe("p1")
    expect(json.why).toEqual(["a", "b"])
    expect(json.usedModel).toBe("gemini-2.5-flash")

    const urls = f.mock.calls.map((c) => c[0])
    expect(urls.some((u) => u.includes("evil.example"))).toBe(false)
    expect(urls.some((u) => u.includes("/api/static-map"))).toBe(false)
    const arcgis = urls.find((u) => u.startsWith("https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export"))
    expect(arcgis).toBeTruthy()
    const parsed = new URL(arcgis as string)
    expect(parsed.searchParams.get("bboxSR")).toBe("3857")
    expect(parsed.searchParams.get("imageSR")).toBe("3857")
    expect(parsed.searchParams.get("format")).toBe("png32")
    expect(parsed.searchParams.get("f")).toBe("image")
    expect(parsed.searchParams.get("size")).toBe("1040,720")

    const geminiCall = f.mock.calls.find((c) => c[0].includes("generativelanguage"))
    const sent = JSON.parse(String(geminiCall?.[1]?.body))
    expect(sent.contents[0].parts[1].inline_data.mime_type).toBe("image/png")
    expect(geminiCall?.[1]?.signal).toBeInstanceOf(AbortSignal)
    expect(geminiCall?.[0]).toContain("key=envkey")
  })

  it("prefers env key over header and body keys", async () => {
    const f = mockFetch()
    await POST(req({ ...VALID, apiKey: "bodykey" }, { "x-gemini-api-key": "headerkey" }))
    const geminiCall = f.mock.calls.find((c) => c[0].includes("generativelanguage"))
    expect(geminiCall?.[0]).toContain("key=envkey")
  })

  it("uses header key when env missing and skips enrichment without coordinates", async () => {
    vi.stubEnv("GEMINI_API_KEY", "")
    const f = mockFetch()
    const res = await POST(req({ roofAreaM2: 30, options: [OPTION], notes: "n", currentId: "p1" }, { "x-gemini-api-key": "headerkey" }))
    expect(res.status).toBe(200)
    expect(f.mock.calls.every((c) => c[0]!.includes("generativelanguage"))).toBe(true)
    expect(f.mock.calls[0]![0]).toContain("key=headerkey")
  })

  it("still answers when imagery and climate fetches fail", async () => {
    const f = vi.fn(async (url: string) => {
      if (url.includes("generativelanguage")) return geminiOk()
      return new Response("", { status: 500 })
    })
    vi.stubGlobal("fetch", f)
    const res = await POST(req(VALID))
    expect(res.status).toBe(200)
  })

  it("ignores non-image and oversized imagery", async () => {
    const f = vi.fn(async (url: string) => {
      if (url.includes("generativelanguage")) return geminiOk()
      if (url.includes("arcgisonline")) {
        return new Response("x", { headers: { "content-type": "text/html" } })
      }
      return Response.json({})
    })
    vi.stubGlobal("fetch", f)
    expect((await POST(req(VALID))).status).toBe(200)
    const geminiCall = f.mock.calls.find((c) => (c[0] as string).includes("generativelanguage")) as unknown as [string, RequestInit]
    expect(JSON.parse(String(geminiCall[1].body)).contents[0].parts).toHaveLength(1)
  })

  it("passes through non-retryable Gemini errors and 502s on unparsable output", async () => {
    mockFetch({ gemini: () => Response.json({ error: { message: "API key not valid" } }, { status: 400 }) })
    const bad = await POST(req(VALID))
    expect(bad.status).toBe(400)

    mockFetch({ gemini: () => geminiOk({ selectedId: "unknown" }) })
    const parse = await POST(req(VALID))
    expect(parse.status).toBe(502)
    expect((await parse.json()).error).toBe("Failed to parse Gemini JSON")
  })

  it("502s when Gemini is rate limited (retryable) or the network fails", async () => {
    mockFetch({ gemini: () => Response.json({ error: { message: "quota" } }, { status: 429 }) })
    const limited = await POST(req(VALID))
    expect(limited.status).toBe(502)
    expect((await limited.json()).error).toBe("quota")

    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("generativelanguage")) throw new Error("net down")
      return Response.json({})
    }))
    const net = await POST(req({ roofAreaM2: 10, options: [OPTION] }))
    expect(net.status).toBe(502)
    expect((await net.json()).error).toBe("net down")
  })

  it("times out the Gemini call", async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_r, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))))
      )
    )
    const p = POST(req({ roofAreaM2: 10, options: [OPTION] }))
    await vi.advanceTimersByTimeAsync(25_100)
    const res = await p
    expect(res.status).toBe(502)
    expect((await res.json()).error).toContain("timed out")
  })

  it("429s after 8 requests with retry-after", async () => {
    mockFetch()
    for (let i = 0; i < 8; i++) expect((await POST(req({ roofAreaM2: 10, options: [OPTION] }))).status).toBe(200)
    const res = await POST(req({ roofAreaM2: 10, options: [OPTION] }))
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBeTruthy()
  })

  it("403s cross-site requests when the server env key would be used", async () => {
    const fetchMock = mockFetch()
    expect((await POST(req(VALID, { "sec-fetch-site": "cross-site" }))).status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
    expect((await POST(req(VALID, { "sec-fetch-site": "same-origin" }))).status).toBe(200)
    // a client-supplied key is the client's own spend
    vi.stubEnv("GEMINI_API_KEY", "")
    expect((await POST(req(VALID, { "sec-fetch-site": "cross-site", "x-gemini-api-key": "clientkey" }))).status).toBe(200)
  })

  it("429s when the global daily Gemini budget is exhausted (env key only)", async () => {
    mockFetch()
    vi.stubEnv("GEMINI_API_KEY", "envkey")
    vi.stubEnv("GEMINI_DAILY_BUDGET", "1")
    vi.stubEnv("TRUSTED_PROXY_HEADER", "x-real-ip")
    expect((await POST(req(VALID, { "x-real-ip": "1.1.1.1" }))).status).toBe(200)
    expect((await POST(req(VALID, { "x-real-ip": "2.2.2.2" }))).status).toBe(429)
    vi.stubEnv("GEMINI_API_KEY", "")
    expect((await POST(req(VALID, { "x-real-ip": "3.3.3.3", "x-gemini-api-key": "clientkey" }))).status).toBe(200)
  })

  it("only returns https sourceUrl values", async () => {
    mockFetch({ gemini: () => geminiOk({ selectedId: "p1", brand: "Acme", model: "A-400", sourceUrl: "javascript:alert(1)", why: [], caveats: [] }) })
    const res = await POST(req(VALID))
    expect(res.status).toBe(200)
    expect((await res.json()).sourceUrl).toBe("https://example.com/a400")

    mockFetch({ gemini: () => geminiOk({ selectedId: "p1", brand: "Acme", model: "A-400", sourceUrl: "http://evil.example/x", why: [], caveats: [] }) })
    expect((await (await POST(req(VALID))).json()).sourceUrl).toBe("https://example.com/a400")
  })

  it("fails to parse when neither the model nor the option has an https sourceUrl", async () => {
    mockFetch({ gemini: () => geminiOk({ selectedId: "p1", brand: "Acme", model: "A-400", sourceUrl: "data:text/html,x", why: [], caveats: [] }) })
    const body = { ...VALID, options: [{ ...OPTION, sourceUrl: "http://example.com/insecure" }] }
    expect((await POST(req(body))).status).toBe(502)
  })

  it("413s oversized bodies", async () => {
    mockFetch()
    expect((await POST(req({ ...VALID, notes: "n".repeat(70_000) }))).status).toBe(413)
  })
})
