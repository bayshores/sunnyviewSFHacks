import { NextResponse } from "next/server"
import { z } from "zod"

import { fetchArcgisImageryBase64 } from "@/lib/arcgis-imagery"
import { requestClientKey, takeRateLimitToken } from "@/lib/rate-limit"
import { isClearlyCrossSite, readCappedJson } from "@/lib/request-guards"
import { spendBudgetResponse, takeSpendBudget } from "@/lib/spend-budget"

export const runtime = "nodejs"

const LOG_PREFIX = "[panel-recommend]"
const MODEL_NOT_FOUND_RE = /not found|not supported|not available|unsupported model/i
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 8
const MAX_BODY_BYTES = 64 * 1024
const ENRICHMENT_TIMEOUT_MS = 6500
const GEMINI_TIMEOUT_MS = 25_000

/** Returns the URL string only when it parses and uses https (blocks javascript:, data:, http:). */
function httpsUrlOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null
  try {
    const url = new URL(value.trim())
    return url.protocol === "https:" ? url.toString() : null
  } catch {
    return null
  }
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

async function fetchClimateSummary(opts: { lat: number; lng: number; signal: AbortSignal }) {
  const url = new URL("https://api.open-meteo.com/v1/forecast")
  url.searchParams.set("latitude", String(opts.lat))
  url.searchParams.set("longitude", String(opts.lng))
  url.searchParams.set("timezone", "auto")
  url.searchParams.set("forecast_days", "7")
  url.searchParams.set("daily", "shortwave_radiation_sum,cloudcover_mean")

  const res = await fetch(url.toString(), {
    signal: opts.signal,
    headers: { accept: "application/json" },
    cache: "no-store",
  })
  if (!res.ok) throw new Error(`Climate fetch failed (${res.status})`)
  const json = (await res.json().catch(() => null)) as any

  const sw: Array<number | null> = Array.isArray(json?.daily?.shortwave_radiation_sum)
    ? json.daily.shortwave_radiation_sum.map((v: any) => (Number.isFinite(Number(v)) ? Number(v) : null))
    : []
  const cc: Array<number | null> = Array.isArray(json?.daily?.cloudcover_mean)
    ? json.daily.cloudcover_mean.map((v: any) => (Number.isFinite(Number(v)) ? Number(v) : null))
    : []

  const irrKwhM2 = sw
    .slice(0, 7)
    .map((mj) => (mj === null ? null : mj * 0.2777777778))
    .filter((v): v is number => v !== null)
  const clouds = cc.slice(0, 7).filter((v): v is number => v !== null)

  const avgIrr = irrKwhM2.length ? irrKwhM2.reduce((a, b) => a + b, 0) / irrKwhM2.length : null
  const avgCloud = clouds.length ? clouds.reduce((a, b) => a + b, 0) / clouds.length : null

  return {
    source: "open-meteo",
    avgDailyIrradianceKwhM2: avgIrr !== null ? Number(avgIrr.toFixed(2)) : null,
    avgCloudCoverPct: avgCloud !== null ? Math.round(clamp(avgCloud, 0, 100)) : null,
  }
}

function uniqueModels(models: Array<string | null | undefined>) {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of models) {
    const model = String(raw ?? "").trim()
    if (!model || seen.has(model)) continue
    seen.add(model)
    out.push(model)
  }
  return out
}

const BodySchema = z.object({
  lat: z.number().optional(),
  lng: z.number().optional(),
  roofAreaM2: z.number().positive(),
  currentId: z.string().optional(),
  options: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        brand: z.string(),
        model: z.string(),
        sourceUrl: z.string().url().optional(),
        spec: z.object({
          widthM: z.number().positive(),
          heightM: z.number().positive(),
          wattW: z.number().positive(),
          gapM: z.number().positive().optional(),
        }),
        fit: z
          .object({
            panelCount: z.number().int().nonnegative(),
            dcKw: z.number().nonnegative(),
            orientationDeg: z.number().optional(),
          })
          .optional(),
      })
    )
    .min(1),
  notes: z.string().optional(),
})

function extractText(resp: any): string {
  const parts = resp?.candidates?.[0]?.content?.parts
  if (Array.isArray(parts)) {
    return parts.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("\n").trim()
  }
  return ""
}

function tryParseJson(s: string) {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

function extractFirstJsonObject(s: string): any {
  const raw = String(s ?? "")
    .replace(/```json\s*/gi, "")
    .replace(/```/g, "")
    .trim()

  const direct = tryParseJson(raw)
  if (direct) return direct

  const start = raw.indexOf("{")
  if (start < 0) return null

  let depth = 0
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]
    if (ch === "{") depth += 1
    else if (ch === "}") depth -= 1
    if (depth === 0) {
      const slice = raw.slice(start, i + 1)
      return tryParseJson(slice)
    }
  }

  return null
}

export async function POST(req: Request) {
  const clientKey = requestClientKey(req.headers)
  const rate = takeRateLimitToken({
    key: `panel-recommend:${clientKey}`,
    limit: RATE_LIMIT_MAX,
    windowMs: RATE_LIMIT_WINDOW_MS,
  })
  if (!rate.ok) {
    return NextResponse.json(
      { error: "Too many panel recommendation requests. Please slow down." },
      {
        status: 429,
        headers: { "retry-after": String(rate.retryAfterSec) },
      }
    )
  }

  const raw = await readCappedJson(req, MAX_BODY_BYTES)
  if (!raw.ok && raw.status === 413) {
    return NextResponse.json({ error: "Request body is too large" }, { status: 413 })
  }
  const body = raw.ok ? raw.body : {}
  const headerKey = req.headers.get("x-gemini-api-key")?.trim() || ""
  const bodyKeyRaw = (body as any)?.geminiApiKey ?? (body as any)?.apiKey
  const bodyKey = typeof bodyKeyRaw === "string" ? bodyKeyRaw.trim() : ""
  const envKey = process.env.GEMINI_API_KEY?.trim() || ""
  const key = (envKey || headerKey || bodyKey || "").trim()
  const usingServerKey = envKey.length > 0 && key === envKey
  const modelsToTry = ["gemini-2.5-flash"]

  const parsed = BodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", issues: parsed.error.issues }, { status: 400 })
  }

  const { lat, lng, roofAreaM2, options, currentId, notes } = parsed.data
  const loc = lat !== undefined && lng !== undefined ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : "unknown"

  if (!key) {
    return NextResponse.json({ error: "Missing Gemini API key" }, { status: 401 })
  }

  if (usingServerKey) {
    // The server's paid key must not be usable from other sites' pages, nor unbounded.
    if (isClearlyCrossSite(req)) {
      return NextResponse.json({ error: "Cross-site requests are not allowed." }, { status: 403 })
    }
    const budget = takeSpendBudget("gemini")
    if (!budget.ok) {
      return spendBudgetResponse(budget.retryAfterSec, "Panel recommendations are temporarily unavailable (daily limit reached).")
    }
  }

  console.info(`${LOG_PREFIX} request`, {
    location: loc,
    roofAreaM2: Number(roofAreaM2.toFixed(1)),
    options: options.length,
    currentId: currentId ?? null,
    modelsToTry,
  })

  const optionLines = options
    .map((o) => {
      const fit = o.fit
      const fitText = fit
        ? `fits ${fit.panelCount} panels (${fit.dcKw.toFixed(1)} kW DC) at orient ${fit.orientationDeg ?? "?"}°`
        : "fit unknown"
      const src = o.sourceUrl ? ` | source=${o.sourceUrl}` : ""
      return `- id=${o.id} | ${o.brand} ${o.model} | ${o.spec.widthM.toFixed(3)}m x ${o.spec.heightM.toFixed(3)}m | ${Math.round(o.spec.wattW)}W | ${fitText}${src}`
    })
    .join("\n")

  let climateSummaryText = "unknown"
  let imagePart: any = null

  if (lat !== undefined && lng !== undefined) {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), ENRICHMENT_TIMEOUT_MS)
    try {
      const [climateRes, mapRes] = await Promise.allSettled([
        fetchClimateSummary({ lat, lng, signal: ac.signal }),
        fetchArcgisImageryBase64({ lat, lng, zoom: 20, w: 520, h: 360, scale: 2, signal: ac.signal }),
      ])

      if (climateRes.status === "fulfilled") {
        const c = climateRes.value
        const irr = c.avgDailyIrradianceKwhM2
        const cc = c.avgCloudCoverPct
        climateSummaryText =
          irr !== null || cc !== null
            ? `Open-Meteo 7-day avg irradiance ${irr ?? "?"} kWh/m^2/day, avg cloud cover ${cc ?? "?"}%`
            : "Open-Meteo unavailable"
      }

      if (mapRes.status === "fulfilled" && mapRes.value) {
        imagePart = {
          inline_data: {
            mime_type: mapRes.value.mimeType,
            data: mapRes.value.dataBase64,
          },
        }
      }
    } catch {
      // ignore enrichment failures
    } finally {
      clearTimeout(t)
      ac.abort()
    }
  }

  const prompt = `You are helping pick the best solar panel option for a specific roof.

Inputs:
- Location: ${loc}
- Usable roof plane area: ${roofAreaM2.toFixed(1)} m^2
 - Climate snapshot: ${climateSummaryText}
 - Satellite context: ${imagePart ? "Attached image (centered on the roof location)." : "No image available."}
${currentId ? `- Current selection id: ${currentId}` : ""}
${notes ? `- Notes: ${notes}` : ""}

Candidate panel options (choose exactly ONE id):
${optionLines}

Task:
- Choose the best option id for this roof.
- Use the satellite image (if attached) to infer shading risk (trees/nearby tall buildings) and roof complexity.
- Use the climate snapshot as a rough solar resource indicator.
- Explain briefly why it is best given fit counts (panelCount/dcKw) and general reliability.
- Include 2 caveats (availability/pricing, permitting/shading).

Return STRICT JSON with keys:
{ "selectedId": string, "brand": string, "model": string, "sourceUrl": string, "why": string[], "caveats": string[] }
No extra keys, no markdown.`

  const allowedIds = new Set(options.map((o) => o.id))
  const requestBody = {
    contents: [{ role: "user", parts: [{ text: prompt }, ...(imagePart ? [imagePart] : [])] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 300,
      responseMimeType: "application/json",
    },
  }

  const attemptedModels: string[] = []
  let lastUpstreamError = "Gemini unavailable"

  for (const modelName of modelsToTry) {
    attemptedModels.push(modelName)
    const url = new URL(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent`
    )
    url.searchParams.set("key", key)

    console.info(`${LOG_PREFIX} trying model`, { model: modelName })

    let res: Response
    let json: any = null
    const geminiAc = new AbortController()
    const geminiTimeout = setTimeout(() => geminiAc.abort(), GEMINI_TIMEOUT_MS)
    try {
      res = await fetch(url.toString(), {
        method: "POST",
        signal: geminiAc.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      })
      json = (await res.json().catch(() => null)) as any
    } catch (e) {
      const message = geminiAc.signal.aborted
        ? `Gemini request timed out after ${GEMINI_TIMEOUT_MS}ms`
        : e instanceof Error
          ? e.message
          : "Network error"
      lastUpstreamError = message
      console.error(`${LOG_PREFIX} request failed`, { model: modelName, message })
      continue
    } finally {
      clearTimeout(geminiTimeout)
    }

    if (!res.ok) {
      const msg =
        typeof json?.error?.message === "string"
          ? json.error.message
          : `Gemini error (${res.status})`
      lastUpstreamError = msg
      console.warn(`${LOG_PREFIX} model failed`, {
        model: modelName,
        status: res.status,
        message: msg.slice(0, 240),
      })
      const canRetryModel = res.status === 404 || res.status === 429 || MODEL_NOT_FOUND_RE.test(msg)
      if (canRetryModel) continue
      return NextResponse.json(
        { error: msg, attemptedModels },
        { status: res.status >= 400 && res.status < 600 ? res.status : 502 }
      )
    }

    const text = extractText(json)
    const parsedJson = extractFirstJsonObject(text)
    const out = parsedJson && typeof parsedJson === "object" ? parsedJson : null

    const selectedId = typeof out?.selectedId === "string" ? out.selectedId : null
    const brand = typeof out?.brand === "string" ? out.brand : null
    const model = typeof out?.model === "string" ? out.model : null
    const outSourceUrl = httpsUrlOrNull(out?.sourceUrl)
    const why = Array.isArray(out?.why) ? out.why.map((v: any) => String(v)).filter(Boolean) : []
    const caveats = Array.isArray(out?.caveats) ? out.caveats.map((v: any) => String(v)).filter(Boolean) : []

    const optionSourceUrl = selectedId ? httpsUrlOrNull(options.find((o) => o.id === selectedId)?.sourceUrl) : null
    const sourceUrl = outSourceUrl || optionSourceUrl

    if (!selectedId || !allowedIds.has(selectedId) || !brand || !model || !sourceUrl) {
      lastUpstreamError = "Failed to parse Gemini JSON"
      console.warn(`${LOG_PREFIX} parse failed`, {
        model: modelName,
        selectedId,
        hasBrand: !!brand,
        hasModel: !!model,
        hasSourceUrl: !!sourceUrl,
      })
      return NextResponse.json(
        { error: "Failed to parse Gemini JSON", attemptedModels },
        { status: 502 }
      )
    }

    console.info(`${LOG_PREFIX} success`, {
      model: modelName,
      selectedId,
      brand,
      panelModel: model,
    })

    return NextResponse.json(
      {
        selectedId,
        brand,
        model,
        sourceUrl,
        why: why.slice(0, 4),
        caveats: caveats.slice(0, 3),
        usedModel: modelName,
      },
      { status: 200 }
    )
  }

  return NextResponse.json({ error: lastUpstreamError, attemptedModels }, { status: 502 })
}
