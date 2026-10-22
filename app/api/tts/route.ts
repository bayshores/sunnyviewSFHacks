import { NextResponse } from "next/server"
import { z } from "zod"

import { requestClientKey, takeRateLimitToken } from "@/lib/rate-limit"
import { isClearlyCrossSite, readCappedJson } from "@/lib/request-guards"
import { spendBudgetResponse, takeSpendBudget } from "@/lib/spend-budget"

export const runtime = "nodejs"

const TtsRequestSchema = z.object({
  text: z.string().min(1).max(2500),
  voiceId: z.string().optional(),
})

const ELEVEN_DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM" // Rachel (commonly available)
const ELEVEN_DEFAULT_MODEL_ID = "eleven_multilingual_v2"
const MAX_BODY_BYTES = 16 * 1024
const VOICE_ID_PATTERN = /^[A-Za-z0-9]{10,40}$/
const TTS_TIMEOUT_MS = 18_000
const MAX_AUDIO_BYTES = 6 * 1024 * 1024
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 8

export async function POST(request: Request) {
  const clientKey = requestClientKey(request.headers)
  const rate = takeRateLimitToken({
    key: `tts:${clientKey}`,
    limit: RATE_LIMIT_MAX,
    windowMs: RATE_LIMIT_WINDOW_MS,
  })
  if (!rate.ok) {
    return NextResponse.json(
      { error: "Too many text-to-speech requests. Please slow down." },
      {
        status: 429,
        headers: { "retry-after": String(rate.retryAfterSec) },
      }
    )
  }

  const headerKey = request.headers.get("x-elevenlabs-api-key")?.trim() || ""
  const envKey = process.env.ELEVENLABS_API_KEY?.trim() || ""
  const apiKey = (envKey || headerKey).trim()
  const usingServerKey = envKey.length > 0

  // The server's paid key must not be usable from other sites' pages.
  if (usingServerKey && isClearlyCrossSite(request)) {
    return NextResponse.json({ error: "Cross-site requests are not allowed." }, { status: 403 })
  }

  const raw = await readCappedJson(request, MAX_BODY_BYTES)
  if (!raw.ok) {
    return raw.status === 413
      ? NextResponse.json({ error: "Request body is too large" }, { status: 413 })
      : NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const parsed = TtsRequestSchema.safeParse(raw.body)
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }

  if (!apiKey) {
    return NextResponse.json(
      {
        audioUrl: null,
        note: "Text-to-speech is disabled. Add an ElevenLabs API key on the landing page (stored locally) or set ELEVENLABS_API_KEY on the backend.",
      },
      { status: 200 }
    )
  }

  const headerVoiceId = request.headers.get("x-elevenlabs-voice-id")?.trim() || ""
  const envVoiceId = process.env.ELEVENLABS_VOICE_ID?.trim() || ""
  const clientVoiceId = parsed.data.voiceId?.trim() || headerVoiceId
  // A client-supplied id ends up in the upstream URL path, so it must look like a real voice id.
  if (!envVoiceId && clientVoiceId && !VOICE_ID_PATTERN.test(clientVoiceId)) {
    return NextResponse.json({ error: "Invalid voiceId" }, { status: 400 })
  }
  const voiceId = envVoiceId || clientVoiceId || ELEVEN_DEFAULT_VOICE_ID
  // Clients cannot pick the (billed) model; it is pinned server-side.
  const modelId = process.env.ELEVENLABS_MODEL_ID?.trim() || ELEVEN_DEFAULT_MODEL_ID

  if (usingServerKey) {
    const budget = takeSpendBudget("tts")
    if (!budget.ok) {
      return spendBudgetResponse(budget.retryAfterSec, "Text-to-speech is temporarily unavailable (daily limit reached).")
    }
  }

  const ac = new AbortController()
  const timeoutId = setTimeout(() => ac.abort(), TTS_TIMEOUT_MS)

  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
      method: "POST",
      signal: ac.signal,
      headers: {
        accept: "audio/mpeg",
        "content-type": "application/json",
        "xi-api-key": apiKey,
      },
      body: JSON.stringify({
        text: parsed.data.text,
        model_id: modelId,
        voice_settings: {
          stability: 0.4,
          similarity_boost: 0.8,
        },
      }),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => "")
      const msg = text.slice(0, 240)
      const code = res.status
      const error = msg ? `ElevenLabs error (${code}): ${msg}` : `ElevenLabs error (${code}).`
      return NextResponse.json({ error }, { status: code === 401 || code === 403 ? 401 : 502 })
    }

    const contentLength = Number(res.headers.get("content-length") ?? "")
    if (Number.isFinite(contentLength) && contentLength > MAX_AUDIO_BYTES) {
      return NextResponse.json({ error: "Audio payload too large" }, { status: 502 })
    }

    const ab = await res.arrayBuffer()
    if (ab.byteLength > MAX_AUDIO_BYTES) {
      return NextResponse.json({ error: "Audio payload too large" }, { status: 502 })
    }

    const ct = (res.headers.get("content-type") ?? "audio/mpeg").split(";")[0] || "audio/mpeg"
    const base64 = Buffer.from(ab).toString("base64")
    const audioUrl = `data:${ct};base64,${base64}`
    return NextResponse.json({ audioUrl }, { status: 200 })
  } catch (e) {
    const message = ac.signal.aborted
      ? `Text-to-speech timed out after ${TTS_TIMEOUT_MS}ms.`
      : e instanceof Error
        ? e.message
        : "Text-to-speech failed."
    return NextResponse.json({ error: message }, { status: 502 })
  } finally {
    clearTimeout(timeoutId)
    ac.abort()
  }
}
