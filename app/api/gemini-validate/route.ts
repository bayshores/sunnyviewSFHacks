import { NextResponse } from "next/server"

import { requestClientKey, takeRateLimitToken } from "@/lib/rate-limit"
import { readCappedJson } from "@/lib/request-guards"

export const runtime = "nodejs"

const TIMEOUT_MS = 3500
const MAX_BODY_BYTES = 4 * 1024
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 20

function looksLikeGeminiKey(value: string) {
  const raw = value.trim()
  if (raw.length === 0) return false
  return /^[A-Za-z0-9._-]{20,}$/.test(raw)
}

export async function POST(req: Request) {
  const clientKey = requestClientKey(req.headers)
  const rate = takeRateLimitToken({
    key: `gemini-validate:${clientKey}`,
    limit: RATE_LIMIT_MAX,
    windowMs: RATE_LIMIT_WINDOW_MS,
  })
  if (!rate.ok) {
    return NextResponse.json(
      { error: "Too many key validation requests. Please slow down." },
      {
        status: 429,
        headers: { "retry-after": String(rate.retryAfterSec) },
      }
    )
  }

  // Quick online validation (small, cheap request).
  const envKey = process.env.GEMINI_API_KEY?.trim() || ""
  const envLoaded = envKey.length > 0
  const headerKey = req.headers.get("x-gemini-api-key") ?? ""
  const raw = await readCappedJson(req, MAX_BODY_BYTES)
  if (!raw.ok && raw.status === 413) {
    return NextResponse.json({ error: "Request body is too large" }, { status: 413 })
  }
  const body = raw.ok ? raw.body : {}
  const bodyKeyRaw = (body as any)?.geminiApiKey ?? (body as any)?.apiKey
  const bodyKey = typeof bodyKeyRaw === "string" ? bodyKeyRaw : ""
  const key = (headerKey || bodyKey).trim()

  if (!key) {
    return NextResponse.json({ ok: false, error: "Missing API key", envLoaded }, { status: 200 })
  }

  if (!looksLikeGeminiKey(key)) {
    return NextResponse.json({ ok: false, envLoaded }, { status: 200 })
  }

  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS)
  try {
    // List models is the fastest way to confirm the key is accepted.
    const url = new URL("https://generativelanguage.googleapis.com/v1beta/models")
    url.searchParams.set("key", key.trim())
    url.searchParams.set("pageSize", "1")

    const res = await fetch(url.toString(), {
      method: "GET",
      signal: ac.signal,
      headers: {
        accept: "application/json",
      },
      cache: "no-store",
    })

    if (!res.ok) {
      return NextResponse.json({ ok: false, envLoaded }, { status: 200 })
    }

    const json = (await res.json().catch(() => null)) as any
    const models = Array.isArray(json?.models) ? json.models : null
    if (!models) {
      return NextResponse.json({ ok: false, envLoaded }, { status: 200 })
    }

    return NextResponse.json({ ok: true, envLoaded }, { status: 200 })
  } catch {
    return NextResponse.json({ ok: false, envLoaded }, { status: 200 })
  } finally {
    clearTimeout(t)
    ac.abort()
  }
}
