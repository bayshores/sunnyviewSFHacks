import { NextResponse } from "next/server"

import { requestClientKey, takeRateLimitToken } from "@/lib/rate-limit"
import { readCappedJson } from "@/lib/request-guards"

export const runtime = "nodejs"

const TIMEOUT_MS = 3500
const MAX_BODY_BYTES = 4 * 1024
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 20

function looksLikeElevenLabsKey(value: string) {
  const raw = value.trim()
  if (raw.length === 0) return false
  if (raw.length < 20) return false
  return !/\s/.test(raw)
}

export async function POST(req: Request) {
  const clientKey = requestClientKey(req.headers)
  const rate = takeRateLimitToken({
    key: `elevenlabs-validate:${clientKey}`,
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
  const envKey = process.env.ELEVENLABS_API_KEY?.trim() || ""
  const envVoiceId = process.env.ELEVENLABS_VOICE_ID?.trim() || ""
  const envLoaded = envKey.length > 0
  const voiceEnvLoaded = envVoiceId.length > 0

  const headerKey = req.headers.get("x-elevenlabs-api-key") ?? ""
  const raw = await readCappedJson(req, MAX_BODY_BYTES)
  if (!raw.ok && raw.status === 413) {
    return NextResponse.json({ error: "Request body is too large" }, { status: 413 })
  }
  const body = raw.ok ? raw.body : {}
  const bodyKeyRaw = (body as any)?.elevenLabsApiKey ?? (body as any)?.apiKey
  const bodyKey = typeof bodyKeyRaw === "string" ? bodyKeyRaw : ""
  const key = (headerKey || bodyKey).trim()

  if (!key) {
    return NextResponse.json({ ok: false, error: "Missing API key", envLoaded, voiceEnvLoaded }, { status: 200 })
  }

  if (!looksLikeElevenLabsKey(key)) {
    return NextResponse.json({ ok: false, envLoaded, voiceEnvLoaded }, { status: 200 })
  }

  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS)
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/user", {
      method: "GET",
      signal: ac.signal,
      headers: {
        accept: "application/json",
        "xi-api-key": key,
      },
      cache: "no-store",
    })

    if (!res.ok) {
      return NextResponse.json({ ok: false, envLoaded, voiceEnvLoaded }, { status: 200 })
    }

    const json = (await res.json().catch(() => null)) as any
    if (!json || typeof json !== "object") {
      return NextResponse.json({ ok: false, envLoaded, voiceEnvLoaded }, { status: 200 })
    }

    return NextResponse.json({ ok: true, envLoaded, voiceEnvLoaded }, { status: 200 })
  } catch {
    return NextResponse.json({ ok: false, envLoaded, voiceEnvLoaded }, { status: 200 })
  } finally {
    clearTimeout(t)
    ac.abort()
  }
}
