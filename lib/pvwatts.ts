export type PVWattsResult = {
  annualKwh: number
  monthlyKwh: number[]
  inputs: Record<string, unknown>
}

const PVWATTS_TIMEOUT_MS = 12_000

/**
 * PVWatts v8 JSON endpoint. NREL was renamed NLR (National Laboratory of the Rockies)
 * in Dec 2025 and developer.nrel.gov no longer resolves. Override with PVWATTS_BASE_URL.
 */
export const PVWATTS_DEFAULT_URL = "https://developer.nlr.gov/api/pvwatts/v8.json"

function pvwattsBaseUrl(): URL {
  const raw = process.env.PVWATTS_BASE_URL?.trim()
  if (!raw) return new URL(PVWATTS_DEFAULT_URL)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error("Invalid PVWATTS_BASE_URL")
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Invalid PVWATTS_BASE_URL")
  }
  return url
}

function num(x: unknown) {
  return typeof x === "number" && Number.isFinite(x) ? x : null
}

export async function callPVWatts(params: {
  lat: number
  lon: number
  dcKw: number
  tilt: number
  azimuth: number
  losses: number
  moduleType?: number
  arrayType?: number
}): Promise<PVWattsResult> {
  const key = process.env.PVWATTS_API_KEY?.trim()
  if (!key) throw new Error("Missing PVWATTS_API_KEY")

  const url = pvwattsBaseUrl()
  url.searchParams.set("api_key", key)
  url.searchParams.set("lat", String(params.lat))
  url.searchParams.set("lon", String(params.lon))
  url.searchParams.set("system_capacity", String(params.dcKw))
  url.searchParams.set("tilt", String(params.tilt))
  url.searchParams.set("azimuth", String(params.azimuth))
  url.searchParams.set("losses", String(params.losses))
  url.searchParams.set("module_type", String(params.moduleType ?? 1))
  url.searchParams.set("array_type", String(params.arrayType ?? 1))

  const ac = new AbortController()
  const timeoutId = setTimeout(() => ac.abort(), PVWATTS_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(url.toString(), { cache: "no-store", signal: ac.signal })
  } catch (e) {
    if (ac.signal.aborted) {
      throw new Error(`PVWatts request timed out after ${PVWATTS_TIMEOUT_MS}ms`)
    }
    throw e
  } finally {
    clearTimeout(timeoutId)
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`PVWatts error ${res.status}: ${text.slice(0, 240)}`)
  }

  const json = (await res.json().catch(() => null)) as any
  const acMonthlyRaw = Array.isArray(json?.outputs?.ac_monthly) ? (json.outputs.ac_monthly as unknown[]) : []
  const monthlyKwh = acMonthlyRaw.map((v) => num(v) ?? 0)
  const annualKwh = num(json?.outputs?.ac_annual) ?? monthlyKwh.reduce((a, b) => a + b, 0)

  return {
    annualKwh,
    monthlyKwh: monthlyKwh.length === 12 ? monthlyKwh : Array.from({ length: 12 }, () => annualKwh / 12),
    inputs: (json?.inputs ?? {}) as Record<string, unknown>,
  }
}
