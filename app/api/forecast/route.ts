import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"

import { requestClientKey, takeRateLimitToken } from "@/lib/rate-limit"

export const runtime = "nodejs"

const LOG_PREFIX = "[forecast]"
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 40

const QuerySchema = z.object({
  lat: z.coerce.number().refine((v) => Number.isFinite(v) && Math.abs(v) <= 90),
  lng: z.coerce.number().refine((v) => Number.isFinite(v) && Math.abs(v) <= 180),
  dcKw: z.coerce.number().refine((v) => Number.isFinite(v) && v >= 0),
  lossesPct: z.coerce.number().optional(),
})

type ForecastDay = {
  date: string
  irradianceKwhM2: number | null
  cloudCoverPct: number | null
  estKwh: number
}

type WorthItAssumptions = {
  utilityRateUsdPerKwh: number
  installCostUsdPerW: number
  goodPaybackYears: number
  maybePaybackYears: number
}

const ASSUMPTIONS: Readonly<WorthItAssumptions> = {
  utilityRateUsdPerKwh: 0.25,
  installCostUsdPerW: 2.75,
  goodPaybackYears: 9,
  maybePaybackYears: 14,
}

type CacheEntry = { t: number; payload: unknown }
const MEM_TTL_MS = 20 * 60 * 1000

function memCache() {
  const g = globalThis as unknown as { __sunnyviewForecastCache?: Map<string, CacheEntry> }
  if (!g.__sunnyviewForecastCache) g.__sunnyviewForecastCache = new Map()
  return g.__sunnyviewForecastCache
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isoDateUTC(d: Date) {
  return d.toISOString().slice(0, 10)
}

function subDays(d: Date, days: number) {
  const out = new Date(d)
  out.setUTCDate(out.getUTCDate() - days)
  return out
}

type Archive365Summary = {
  source: "open-meteo-archive"
  startDate: string
  endDate: string
  days: number
  sumIrradianceKwhM2: number | null
  avgCloudCoverPct: number | null
}

async function fetchArchive365Summary(opts: { lat: number; lng: number; signal: AbortSignal }): Promise<Archive365Summary> {
  const end = subDays(new Date(), 1)
  const start = subDays(end, 364)
  const startDate = isoDateUTC(start)
  const endDate = isoDateUTC(end)

  const url = new URL("https://archive-api.open-meteo.com/v1/archive")
  url.searchParams.set("latitude", String(opts.lat))
  url.searchParams.set("longitude", String(opts.lng))
  url.searchParams.set("timezone", "auto")
  url.searchParams.set("start_date", startDate)
  url.searchParams.set("end_date", endDate)
  url.searchParams.set("daily", "shortwave_radiation_sum,cloudcover_mean")

  const res = await fetch(url.toString(), {
    signal: opts.signal,
    headers: { accept: "application/json" },
    cache: "no-store",
  })
  if (!res.ok) throw new Error(`Archive failed (${res.status})`)
  const json = (await res.json().catch(() => null)) as any

  const sw: Array<number | null> = Array.isArray(json?.daily?.shortwave_radiation_sum)
    ? json.daily.shortwave_radiation_sum.map((v: any) => (Number.isFinite(Number(v)) ? Number(v) : null))
    : []
  const cc: Array<number | null> = Array.isArray(json?.daily?.cloudcover_mean)
    ? json.daily.cloudcover_mean.map((v: any) => (Number.isFinite(Number(v)) ? Number(v) : null))
    : []

  const irrKwhM2 = sw.map((mj) => (mj === null ? null : mj * 0.2777777778)).filter((v): v is number => v !== null)
  const clouds = cc.filter((v): v is number => v !== null)

  const sumIrr = irrKwhM2.length ? irrKwhM2.reduce((a, b) => a + b, 0) : null
  const avgCloud = clouds.length ? clouds.reduce((a, b) => a + b, 0) / clouds.length : null

  return {
    source: "open-meteo-archive",
    startDate,
    endDate,
    days: Math.max(sw.length, cc.length, irrKwhM2.length, clouds.length),
    sumIrradianceKwhM2: sumIrr !== null ? Number(sumIrr.toFixed(2)) : null,
    avgCloudCoverPct: avgCloud !== null ? Math.round(clamp(avgCloud, 0, 100)) : null,
  }
}

function computeWorthIt(days: ForecastDay[], dcKw: number, lossesPct: number) {
  const sum7 = days.reduce((s, d) => s + (Number.isFinite(d.estKwh) ? d.estKwh : 0), 0)
  const avgDaily = sum7 / Math.max(1, days.length)
  const annualFromForecast = avgDaily * 365

  const assumptions: WorthItAssumptions = ASSUMPTIONS

  const installCost = dcKw * 1000 * assumptions.installCostUsdPerW
  const annualSavings = annualFromForecast * assumptions.utilityRateUsdPerKwh
  const paybackYears = annualSavings > 0 ? installCost / annualSavings : Infinity

  const verdict =
    paybackYears < assumptions.goodPaybackYears
      ? "good"
      : paybackYears < assumptions.maybePaybackYears
        ? "maybe"
        : "unlikely"
  const reasons = [
    `Forecast average: ${avgDaily.toFixed(1)} kWh/day for your current layout.`,
    `Assumes losses ${lossesPct}% and utility rate $${assumptions.utilityRateUsdPerKwh.toFixed(2)}/kWh.`,
    verdict === "good"
      ? `Estimated simple payback ~${paybackYears.toFixed(1)} years (typical install cost assumption).`
      : verdict === "maybe"
        ? `Estimated simple payback ~${paybackYears.toFixed(1)} years; economics depend on incentives and your rate plan.`
        : "Estimated payback is long; incentives, shading, or higher rates could change this.",
  ]

  return {
    verdict,
    paybackYears: Number.isFinite(paybackYears) ? paybackYears : null,
    annualKwhEst: annualFromForecast,
    annualSavingsUsd: annualSavings,
    installCostUsd: installCost,
    reasons,
    assumptions,
    basis: {
      kind: "forecast-7d" as const,
      source: "open-meteo",
      days: days.length,
    },
  }
}

function computeWorthItAnnual(opts: {
  annualKwh: number
  avgDailyKwh: number
  dcKw: number
  lossesPct: number
  basis:
    | { kind: "archive-365d"; source: "open-meteo-archive"; startDate: string; endDate: string; days: number }
    | { kind: "fallback"; source: "fallback"; days: number }
    | { kind: "unavailable"; source: "unavailable"; reason: string }
}) {
  if (opts.basis.kind === "unavailable") {
    return {
      verdict: undefined,
      paybackYears: null,
      annualKwhEst: null,
      annualSavingsUsd: null,
      installCostUsd: null,
      reasons: [
        `Annual baseline unavailable (${opts.basis.reason}). We can't estimate payback without a 365-day weather baseline.`,
      ],
      assumptions: ASSUMPTIONS,
      basis: opts.basis,
    }
  }

  const assumptions: WorthItAssumptions = ASSUMPTIONS

  const annualKwh = Number.isFinite(opts.annualKwh) ? opts.annualKwh : 0
  const installCostUsd = opts.dcKw * 1000 * assumptions.installCostUsdPerW
  const annualSavingsUsd = annualKwh * assumptions.utilityRateUsdPerKwh
  const paybackYears = annualSavingsUsd > 0 ? installCostUsd / annualSavingsUsd : Infinity

  const verdict =
    paybackYears < assumptions.goodPaybackYears
      ? "good"
      : paybackYears < assumptions.maybePaybackYears
        ? "maybe"
        : "unlikely"

  const basisText =
    opts.basis.kind === "archive-365d"
      ? `Annualized from Open-Meteo archive (${opts.basis.startDate} to ${opts.basis.endDate}).`
      : "Annualized from a fallback profile (rough)."

  const reasons = [
    `${basisText} Estimated ~${opts.annualKwh.toFixed(0)} kWh/year (~${opts.avgDailyKwh.toFixed(1)} kWh/day) for your current layout.`,
    `Assumes losses ${opts.lossesPct}% and utility rate $${assumptions.utilityRateUsdPerKwh.toFixed(2)}/kWh.`,
    verdict === "good"
      ? `Estimated simple payback ~${paybackYears.toFixed(1)} years (typical install cost assumption).`
      : verdict === "maybe"
        ? `Estimated simple payback ~${paybackYears.toFixed(1)} years; economics depend on incentives and your rate plan.`
        : "Estimated payback is long; incentives, shading, or higher rates could change this.",
  ]

  return {
    verdict,
    paybackYears: Number.isFinite(paybackYears) ? paybackYears : null,
    annualKwhEst: annualKwh,
    annualSavingsUsd,
    installCostUsd,
    reasons,
    assumptions,
    basis: opts.basis,
  }
}

function worthItFromArchive(archive: Archive365Summary | null, dcKw: number, pr: number, lossesPct: number) {
  if (archive?.sumIrradianceKwhM2 && archive.sumIrradianceKwhM2 > 0) {
    const annualKwh = dcKw * pr * archive.sumIrradianceKwhM2
    return computeWorthItAnnual({
      annualKwh,
      avgDailyKwh: annualKwh / 365,
      dcKw,
      lossesPct,
      basis: {
        kind: "archive-365d",
        source: "open-meteo-archive",
        startDate: archive.startDate,
        endDate: archive.endDate,
        days: archive.days,
      },
    })
  }
  return computeWorthItAnnual({
    annualKwh: 0,
    avgDailyKwh: 0,
    dcKw,
    lossesPct,
    basis: { kind: "unavailable", source: "unavailable", reason: "archive unavailable" },
  })
}

function buildFallbackDays(opts: { dcKw: number; pr: number }) {
  const baseIrr = 4.2
  const dayFactors = [0.92, 1.04, 1.08, 0.96, 1.01, 0.93, 1.05]
  const cloudByDay = [42, 35, 28, 48, 39, 46, 31]
  const start = new Date()

  const days: ForecastDay[] = dayFactors.map((factor, idx) => {
    const d = new Date(start)
    d.setDate(start.getDate() + idx)
    const date = d.toISOString().slice(0, 10)
    const irradianceKwhM2 = Number((baseIrr * factor).toFixed(3))
    const estKwh = opts.dcKw * irradianceKwhM2 * opts.pr
    return {
      date,
      irradianceKwhM2,
      cloudCoverPct: cloudByDay[idx] ?? null,
      estKwh,
    }
  })

  return days
}

export async function GET(req: NextRequest) {
  const clientKey = requestClientKey(req.headers)
  const rate = takeRateLimitToken({
    key: `forecast:${clientKey}`,
    limit: RATE_LIMIT_MAX,
    windowMs: RATE_LIMIT_WINDOW_MS,
  })
  if (!rate.ok) {
    return NextResponse.json(
      { error: "Too many forecast requests. Please slow down." },
      {
        status: 429,
        headers: { "retry-after": String(rate.retryAfterSec) },
      }
    )
  }

  const parsed = QuerySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams.entries()))
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid query", issues: parsed.error.issues }, { status: 400 })
  }

  const { lat, lng, dcKw } = parsed.data
  const lossesPct = clamp(parsed.data.lossesPct ?? 14, 0, 35)
  const pr = clamp(1 - lossesPct / 100, 0.5, 0.95)

  console.info(`${LOG_PREFIX} request`, {
    lat: Number(lat.toFixed(5)),
    lng: Number(lng.toFixed(5)),
    dcKw: Number(dcKw.toFixed(3)),
    lossesPct,
  })

  const key = `f:${lat.toFixed(4)}:${lng.toFixed(4)}`
  const now = Date.now()
  const mem = memCache()
  const hit = mem.get(key)
  if (hit && now - hit.t < MEM_TTL_MS) {
    const cached = hit.payload as {
      days: Array<Omit<ForecastDay, "estKwh">>
      meta: Record<string, unknown>
      archive365?: Archive365Summary | null
    }
    const days = cached.days.map((d) => {
      const irr = d.irradianceKwhM2
      const estKwh = irr ? dcKw * irr * pr : 0
      return { ...d, estKwh }
    })
    const archive = cached.archive365 ?? null
    const worthIt = worthItFromArchive(archive, dcKw, pr, lossesPct)
    console.info(`${LOG_PREFIX} cache hit`, { key, days: days.length })
    return NextResponse.json({ ...cached, days, worthIt }, { status: 200 })
  }

  const url = new URL("https://api.open-meteo.com/v1/forecast")
  url.searchParams.set("latitude", String(lat))
  url.searchParams.set("longitude", String(lng))
  url.searchParams.set("timezone", "auto")
  url.searchParams.set("forecast_days", "7")
  url.searchParams.set("daily", "shortwave_radiation_sum,cloudcover_mean")

  // Try to prefetch a 365-day archive summary for economics.
  let archive365: Archive365Summary | null = null
  {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), 6500)
    try {
      archive365 = await fetchArchive365Summary({ lat, lng, signal: ac.signal })
      console.info(`${LOG_PREFIX} archive summary`, {
        startDate: archive365.startDate,
        endDate: archive365.endDate,
        days: archive365.days,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Archive failed"
      console.warn(`${LOG_PREFIX} archive failed`, { message: msg })
      archive365 = null
    } finally {
      clearTimeout(t)
      ac.abort()
    }
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), 5500)
    const startedAt = Date.now()

    try {
      const res = await fetch(url.toString(), {
        signal: ac.signal,
        headers: { accept: "application/json" },
        cache: "no-store",
      })

      const durationMs = Date.now() - startedAt
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        console.warn(`${LOG_PREFIX} upstream non-200`, {
          attempt,
          status: res.status,
          durationMs,
          details: text.slice(0, 220),
        })
        if (attempt < 2 && (res.status >= 500 || res.status === 429)) {
          await wait(220)
          continue
        }
        throw new Error(`Forecast failed (${res.status})`)
      }

      const json = (await res.json().catch(() => null)) as any

      const times: string[] = Array.isArray(json?.daily?.time) ? json.daily.time : []
      const sw: Array<number | null> = Array.isArray(json?.daily?.shortwave_radiation_sum)
        ? json.daily.shortwave_radiation_sum.map((v: any) => (Number.isFinite(Number(v)) ? Number(v) : null))
        : []
      const cc: Array<number | null> = Array.isArray(json?.daily?.cloudcover_mean)
        ? json.daily.cloudcover_mean.map((v: any) => (Number.isFinite(Number(v)) ? Number(v) : null))
        : []

      const days: ForecastDay[] = times.slice(0, 7).map((date, i) => {
        const swMj = sw[i] ?? null
        const irrKwh = swMj !== null ? swMj * 0.2777777778 : null
        const estKwh = irrKwh ? dcKw * irrKwh * pr : 0
        return {
          date,
          irradianceKwhM2: irrKwh,
          cloudCoverPct: cc[i] ?? null,
          estKwh,
        }
      })

      if (!days.length) {
        throw new Error("Forecast payload missing daily data")
      }

      const worthIt = computeWorthIt(days, dcKw, lossesPct)
      const annualWorthIt = worthItFromArchive(archive365, dcKw, pr, lossesPct)

       const payload = {
         days: days.map((d) => ({ date: d.date, irradianceKwhM2: d.irradianceKwhM2, cloudCoverPct: d.cloudCoverPct })),
         meta: {
           source: "open-meteo",
           units: { shortwave_radiation_sum: "MJ/m^2", irradianceKwhM2: "kWh/m^2" },
           pr,
         },
         archive365,
       }

       mem.set(key, { t: now, payload })
       const outDays = days

      console.info(`${LOG_PREFIX} success`, {
        attempt,
        durationMs,
        days: outDays.length,
      })
       return NextResponse.json({ ...payload, days: outDays, worthIt: annualWorthIt }, { status: 200 })
    } catch (e) {
      const durationMs = Date.now() - startedAt
      const message = e instanceof Error ? e.message : "Forecast failed"
      console.warn(`${LOG_PREFIX} upstream error`, {
        attempt,
        durationMs,
        aborted: ac.signal.aborted,
        message,
      })
      if (attempt < 2) {
        await wait(220)
        continue
      }
    } finally {
      clearTimeout(t)
      ac.abort()
    }
  }

  const fallbackDays = buildFallbackDays({ dcKw, pr })
  const worthIt = worthItFromArchive(archive365, dcKw, pr, lossesPct)
  const fallbackPayload = {
    days: fallbackDays,
    meta: {
      source: "fallback",
      warning: "Live forecast provider is temporarily unavailable. Showing a rough fallback estimate.",
      pr,
    },
    worthIt,
    archive365,
  }

  console.warn(`${LOG_PREFIX} returning fallback`, {
    days: fallbackDays.length,
    lat: Number(lat.toFixed(5)),
    lng: Number(lng.toFixed(5)),
  })
  return NextResponse.json(fallbackPayload, { status: 200 })
}
