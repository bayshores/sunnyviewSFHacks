import { NextResponse } from 'next/server'
import { z } from 'zod'

import { readCappedJson } from "@/lib/request-guards"
import { requestClientKey, takeRateLimitToken } from "@/lib/rate-limit"

const ExplainRequestSchema = z.object({
  estimate: z.object({
    annualKwh: z.number(),
    annualCo2Kg: z.number().optional(),
    co2: z.number().optional(),
  }),
  assumptions: z.unknown().optional(),
  userGoal: z.string().optional(),
})

const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 60
const MAX_BODY_BYTES = 16_384

export async function POST(request: Request) {
  const clientKey = requestClientKey(request.headers)
  const rate = takeRateLimitToken({
    key: `explain:${clientKey}`,
    limit: RATE_LIMIT_MAX,
    windowMs: RATE_LIMIT_WINDOW_MS,
  })
  if (!rate.ok) {
    return NextResponse.json(
      { error: "Too many explain requests. Please slow down." },
      {
        status: 429,
        headers: { "retry-after": String(rate.retryAfterSec) },
      }
    )
  }

  const capped = await readCappedJson(request, MAX_BODY_BYTES)
  if (!capped.ok) {
    if (capped.status === 413) return NextResponse.json({ error: 'Request body too large' }, { status: 413 })
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = ExplainRequestSchema.safeParse(capped.body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const annualKwh = parsed.data.estimate.annualKwh
  const annualCo2Kg = parsed.data.estimate.annualCo2Kg ?? parsed.data.estimate.co2 ?? 0

  const bullets = [
    `Estimated annual production is about ${Math.round(annualKwh).toLocaleString()} kWh.`,
    `Estimated annual CO2 avoided is about ${Math.round(annualCo2Kg).toLocaleString()} kg.`,
    'Actual performance can improve or drop based on shading, roof orientation, and local weather.',
  ]

  const caveat =
    'This is an early-stage estimate and should be validated with detailed shading and site analysis.'

  return NextResponse.json({
    bullets,
    caveat,
    caveats: [caveat],
  })
}
