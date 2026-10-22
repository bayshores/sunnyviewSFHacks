import { NextResponse } from "next/server"
import { z } from "zod"

import { co2KgPerKwh } from "@/lib/co2"
import { callPVWatts } from "@/lib/pvwatts"
import { readCappedJson } from "@/lib/request-guards"
import { requestClientKey, takeRateLimitToken } from "@/lib/rate-limit"
import { getRedis } from "@/lib/redis"
import { FALLBACK_KWH_PER_KW_YEAR, fallbackAnnualEstimate } from "@/lib/solar-defaults"

export const runtime = "nodejs"

const EstimateSchema = z.object({
  siteSpec: z.object({
    lat: z.number().optional(),
    lng: z.number().optional(),
    tiltDeg: z.number().default(20),
    azimuthDeg: z.number().default(180),
    lossesPct: z.number().default(14),
  }),
  layoutSummary: z.object({
    dcKw: z.number(),
    panelCount: z.number().optional(),
    orientationDeg: z.number().optional(),
  }),
  panelSpec: z
    .object({
      widthM: z.number().optional(),
      heightM: z.number().optional(),
      wattW: z.number().optional(),
      gapM: z.number().optional(),
    })
    .optional(),
})

type EstimateOut = {
  annualKwh: number
  monthlyKwh: number[]
  annualCo2Kg: number
  assumptions: Record<string, unknown>
}

type CacheEntry = { t: number; payload: EstimateOut }
const MEM_TTL_MS = 24 * 60 * 60 * 1000
const MEM_CACHE_MAX_ENTRIES = 400
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 40

function memCache() {
  const g = globalThis as unknown as { __sunnyviewEstimateCache?: Map<string, CacheEntry> }
  if (!g.__sunnyviewEstimateCache) g.__sunnyviewEstimateCache = new Map()
  return g.__sunnyviewEstimateCache
}

function setMemCache(key: string, payload: EstimateOut, t = Date.now()) {
  const mem = memCache()
  mem.set(key, { t, payload })
  if (mem.size > MEM_CACHE_MAX_ENTRIES) {
    const oldestKey = mem.keys().next().value
    if (oldestKey) mem.delete(oldestKey)
  }
}

function cacheKey(p: { lat: number; lng: number; tilt: number; az: number; dcKw: number; losses: number }) {
  return `pvwatts:${p.lat.toFixed(5)}:${p.lng.toFixed(5)}:${Math.round(p.tilt)}:${Math.round(p.az)}:${p.dcKw.toFixed(3)}:${Math.round(p.losses * 10) / 10}`
}

function fallbackEstimate(params: { dcKw: number; lat?: number; lng?: number; reason: string }): EstimateOut {
  const est = fallbackAnnualEstimate(params.dcKw, co2KgPerKwh(params.lat, params.lng))
  return {
    ...est,
    assumptions: { source: params.reason, localKwhPerKwYear: FALLBACK_KWH_PER_KW_YEAR },
  }
}

const MAX_BODY_BYTES = 16_384

export async function POST(req: Request) {
  const clientKey = requestClientKey(req.headers)
  const rate = takeRateLimitToken({
    key: `estimate:${clientKey}`,
    limit: RATE_LIMIT_MAX,
    windowMs: RATE_LIMIT_WINDOW_MS,
  })
  if (!rate.ok) {
    return NextResponse.json(
      { error: "Too many estimate requests. Please slow down." },
      {
        status: 429,
        headers: { "retry-after": String(rate.retryAfterSec) },
      }
    )
  }

  const capped = await readCappedJson(req, MAX_BODY_BYTES)
  if (!capped.ok && capped.status === 413) {
    return NextResponse.json({ error: "Request body too large" }, { status: 413 })
  }
  const parsed = EstimateSchema.safeParse(capped.ok ? capped.body : {})
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", issues: parsed.error.issues }, { status: 400 })
  }

  const { siteSpec, layoutSummary } = parsed.data
  const dcKw = layoutSummary.dcKw
  if (!Number.isFinite(dcKw) || dcKw <= 0) {
    return NextResponse.json(fallbackEstimate({ dcKw: 0, reason: "fallback_bad_dc_kw" }), { status: 200 })
  }

  const lat = siteSpec.lat
  const lng = siteSpec.lng
  const tilt = siteSpec.tiltDeg
  const az = siteSpec.azimuthDeg
  const losses = siteSpec.lossesPct

  if (lat === undefined || lng === undefined) {
    return NextResponse.json(fallbackEstimate({ dcKw, reason: "fallback_no_location" }), { status: 200 })
  }

  const key = cacheKey({ lat, lng, tilt, az, dcKw, losses })
  const now = Date.now()

  // Memory cache (always available)
  const mem = memCache()
  const memHit = mem.get(key)
  if (memHit && now - memHit.t < MEM_TTL_MS) {
    return NextResponse.json(
      { ...memHit.payload, assumptions: { ...(memHit.payload.assumptions ?? {}), source: "mem_cache" } },
      { status: 200 }
    )
  }

  // Redis cache (optional)
  const redis = await getRedis()
  if (redis) {
    try {
      const cached = await redis.get<EstimateOut>(key)
      if (cached) {
        setMemCache(key, cached, now)
        return NextResponse.json({ ...cached, assumptions: { ...(cached.assumptions ?? {}), source: "redis_cache" } }, { status: 200 })
      }
    } catch {
      // ignore cache failures
    }
  }

  // PVWatts call
  try {
    const pv = await callPVWatts({
      lat,
      lon: lng,
      dcKw,
      tilt,
      azimuth: az,
      losses,
    })

    const annualCo2Kg = pv.annualKwh * co2KgPerKwh(lat, lng)
    const out: EstimateOut = {
      annualKwh: pv.annualKwh,
      monthlyKwh: pv.monthlyKwh,
      annualCo2Kg,
      assumptions: { source: "pvwatts", pvwattsInputs: pv.inputs },
    }

    setMemCache(key, out, now)
    if (redis) {
      try {
        await redis.set(key, out, { ex: 60 * 60 * 24 })
      } catch {
        // ignore
      }
    }

    return NextResponse.json(out, { status: 200 })
  } catch (e) {
    console.warn("[estimate] pvwatts failed, using fallback", {
      message: e instanceof Error ? e.message : String(e),
    })
    const out = fallbackEstimate({ dcKw, lat, lng, reason: "fallback_after_pvwatts_error" })
    setMemCache(key, out, now)
    return NextResponse.json(out, { status: 200 })
  }
}
