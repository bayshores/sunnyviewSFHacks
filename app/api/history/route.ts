import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"

import { getOrCreateVisitorContext, attachVisitorCookie } from "@/lib/history-visitor"
import { logHistoryDbError, mapHistoryDbError } from "@/lib/history-db-errors"
import { upsertHistoryEntry, listHistoryEntries } from "@/lib/history-store"
import { connectMongo, mongoConnectMessage } from "@/lib/mongo-connect"
import { readCappedJson } from "@/lib/request-guards"
import { requestClientKey, takeRateLimitToken } from "@/lib/rate-limit"

export const runtime = "nodejs"

const RATE_LIMIT_WINDOW_MS = 60_000
const LIST_RATE_LIMIT_MAX = 90
const SAVE_RATE_LIMIT_MAX = 40
const MAX_SAVE_BODY_BYTES = 250_000

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(100),
})

const PointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
})

const SnapshotSchema = z.object({
  mode: z.literal("address"),
  address: z.string().trim().max(220).nullable(),
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
  zoom: z.number().finite().min(0).max(24),
  mPerPx: z.number().finite().positive().nullable(),
  siteSpec: z.object({
    tiltDeg: z.number().finite().min(0).max(90),
    azimuthDeg: z.number().finite().min(0).max(360),
    lossesPct: z.number().finite().min(0).max(40),
  }),
  panelSpec: z.object({
    widthM: z.number().finite().positive().max(4),
    heightM: z.number().finite().positive().max(4),
    wattW: z.number().finite().positive().max(1500),
    gapM: z.number().finite().min(0).max(1),
  }),
  layoutSummary: z.object({
    orientationDeg: z.number().finite().min(-90).max(90),
    panelCount: z.number().int().nonnegative().max(20_000),
    dcKw: z.number().finite().nonnegative().max(20_000),
  }),
  geometry: z.object({
    vertices: z.array(PointSchema).min(3).max(160),
    closed: z.boolean(),
    mPerPx: z.number().finite().positive().nullable(),
    zoom: z.number().finite().min(0).max(24),
  }),
  estimate: z
    .object({
      annualKwh: z.number().finite().nonnegative().max(2_000_000),
      monthlyKwh: z.array(z.number().finite().nonnegative().max(400_000)).length(12),
      annualCo2Kg: z.number().finite().nonnegative().max(2_000_000),
      assumptions: z.unknown().optional(),
    })
    .nullable(),
})

const SummarySchema = z.object({
  address: z.string().trim().max(220).nullable(),
  panelCount: z.number().int().nonnegative().max(20_000),
  dcKw: z.number().finite().nonnegative().max(20_000),
  annualKwh: z.number().finite().nonnegative().max(2_000_000).nullable(),
  annualCo2Kg: z.number().finite().nonnegative().max(2_000_000).nullable(),
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
})

const SaveBodySchema = z.object({
  snapshot: SnapshotSchema,
  summary: SummarySchema,
  title: z.string().trim().max(80).optional(),
  note: z.string().trim().max(500).optional(),
  pinned: z.boolean().optional(),
})

function withVisitorCookie(payload: unknown, visitor: ReturnType<typeof getOrCreateVisitorContext>, init?: ResponseInit) {
  const res = NextResponse.json(payload, init)
  return attachVisitorCookie(res, visitor)
}

export async function GET(req: NextRequest) {
  const clientKey = requestClientKey(req.headers)
  const rate = takeRateLimitToken({
    key: `history:list:${clientKey}`,
    limit: LIST_RATE_LIMIT_MAX,
    windowMs: RATE_LIMIT_WINDOW_MS,
  })
  if (!rate.ok) {
    return NextResponse.json(
      { error: "Too many history requests. Please slow down." },
      { status: 429, headers: { "retry-after": String(rate.retryAfterSec) } }
    )
  }

  const visitor = getOrCreateVisitorContext(req)
  const parsed = ListQuerySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams.entries()))
  if (!parsed.success) {
    return withVisitorCookie({ error: "Invalid query", issues: parsed.error.issues }, visitor, { status: 400 })
  }

  const conn = await connectMongo()
  if (!conn.ok) {
    if (conn.reason === "unavailable") logHistoryDbError("connect", conn.error)
    return withVisitorCookie({ error: mongoConnectMessage("History", conn.reason) }, visitor, { status: 503 })
  }
  const db = conn.db

  try {
    const items = await listHistoryEntries({ db, visitorId: visitor.visitorId, limit: parsed.data.limit })
    return withVisitorCookie({ items }, visitor, { status: 200 })
  } catch (err) {
    logHistoryDbError("list", err)
    const mapped = mapHistoryDbError(err, "Failed to list history.")
    return withVisitorCookie({ error: mapped.message }, visitor, { status: mapped.status })
  }
}

export async function POST(req: NextRequest) {
  const clientKey = requestClientKey(req.headers)
  const rate = takeRateLimitToken({
    key: `history:save:${clientKey}`,
    limit: SAVE_RATE_LIMIT_MAX,
    windowMs: RATE_LIMIT_WINDOW_MS,
  })
  if (!rate.ok) {
    return NextResponse.json(
      { error: "Too many history saves. Please slow down." },
      { status: 429, headers: { "retry-after": String(rate.retryAfterSec) } }
    )
  }

  const visitor = getOrCreateVisitorContext(req)
  const capped = await readCappedJson(req, MAX_SAVE_BODY_BYTES)
  if (!capped.ok && capped.status === 413) {
    return withVisitorCookie({ error: "History payload is too large." }, visitor, { status: 413 })
  }
  const parsed = SaveBodySchema.safeParse(capped.ok ? capped.body : null)
  if (!parsed.success) {
    return withVisitorCookie({ error: "Invalid body", issues: parsed.error.issues }, visitor, { status: 400 })
  }

  const { snapshot, summary } = parsed.data
  if (Math.abs(snapshot.lat - summary.lat) > 0.00001 || Math.abs(snapshot.lng - summary.lng) > 0.00001) {
    return withVisitorCookie({ error: "Snapshot and summary location mismatch." }, visitor, { status: 400 })
  }

  const conn = await connectMongo()
  if (!conn.ok) {
    if (conn.reason === "unavailable") logHistoryDbError("connect", conn.error)
    return withVisitorCookie({ error: mongoConnectMessage("History", conn.reason) }, visitor, { status: 503 })
  }
  const db = conn.db

  try {
    const entry = await upsertHistoryEntry({
      db,
      visitorId: visitor.visitorId,
      input: parsed.data,
    })

    return withVisitorCookie({ item: entry }, visitor, { status: 200 })
  } catch (err) {
    logHistoryDbError("save", err)
    const mapped = mapHistoryDbError(err, "Failed to save history.")
    return withVisitorCookie({ error: mapped.message }, visitor, { status: mapped.status })
  }
}
