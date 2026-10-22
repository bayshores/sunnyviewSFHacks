import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"

import { attachVisitorCookie, getOrCreateVisitorContext } from "@/lib/history-visitor"
import { logHistoryDbError, mapHistoryDbError } from "@/lib/history-db-errors"
import { deleteHistoryEntry, getHistoryEntry, patchHistoryMetadata } from "@/lib/history-store"
import { connectMongo, mongoConnectMessage } from "@/lib/mongo-connect"
import { readCappedJson } from "@/lib/request-guards"
import { requestClientKey, takeRateLimitToken } from "@/lib/rate-limit"

export const runtime = "nodejs"

type RouteContext = {
  params: Promise<{ id: string }>
}

const RATE_LIMIT_WINDOW_MS = 60_000
const DETAIL_RATE_LIMIT_MAX = 120
const PATCH_RATE_LIMIT_MAX = 45
const DELETE_RATE_LIMIT_MAX = 30
const MAX_PATCH_BODY_BYTES = 8_192

const PatchBodySchema = z
  .object({
    title: z.string().trim().max(80).optional(),
    note: z.string().trim().max(500).optional(),
    pinned: z.boolean().optional(),
  })
  .refine((v) => v.title !== undefined || v.note !== undefined || v.pinned !== undefined, {
    message: "At least one field must be provided.",
  })

async function routeId(ctx: RouteContext) {
  const { id } = await ctx.params
  return id
}

function withVisitorCookie(payload: unknown, visitor: ReturnType<typeof getOrCreateVisitorContext>, init?: ResponseInit) {
  const res = NextResponse.json(payload, init)
  return attachVisitorCookie(res, visitor)
}

export async function GET(req: NextRequest, ctx: RouteContext) {
  const clientKey = requestClientKey(req.headers)
  const rate = takeRateLimitToken({
    key: `history:detail:${clientKey}`,
    limit: DETAIL_RATE_LIMIT_MAX,
    windowMs: RATE_LIMIT_WINDOW_MS,
  })
  if (!rate.ok) {
    return NextResponse.json(
      { error: "Too many history requests. Please slow down." },
      { status: 429, headers: { "retry-after": String(rate.retryAfterSec) } }
    )
  }

  const visitor = getOrCreateVisitorContext(req)
  const id = await routeId(ctx)
  const conn = await connectMongo()
  if (!conn.ok) {
    if (conn.reason === "unavailable") logHistoryDbError("connect", conn.error)
    return withVisitorCookie({ error: mongoConnectMessage("History", conn.reason) }, visitor, { status: 503 })
  }
  const db = conn.db

  try {
    const item = await getHistoryEntry({ db, visitorId: visitor.visitorId, id })
    if (!item) {
      return withVisitorCookie({ error: "History entry not found." }, visitor, { status: 404 })
    }
    return withVisitorCookie({ item }, visitor, { status: 200 })
  } catch (err) {
    logHistoryDbError("detail", err)
    const mapped = mapHistoryDbError(err, "Failed to load history entry.")
    return withVisitorCookie({ error: mapped.message }, visitor, { status: mapped.status })
  }
}

export async function PATCH(req: NextRequest, ctx: RouteContext) {
  const clientKey = requestClientKey(req.headers)
  const rate = takeRateLimitToken({
    key: `history:patch:${clientKey}`,
    limit: PATCH_RATE_LIMIT_MAX,
    windowMs: RATE_LIMIT_WINDOW_MS,
  })
  if (!rate.ok) {
    return NextResponse.json(
      { error: "Too many history edits. Please slow down." },
      { status: 429, headers: { "retry-after": String(rate.retryAfterSec) } }
    )
  }

  const visitor = getOrCreateVisitorContext(req)
  const id = await routeId(ctx)
  const capped = await readCappedJson(req, MAX_PATCH_BODY_BYTES)
  if (!capped.ok && capped.status === 413) {
    return withVisitorCookie({ error: "History payload is too large." }, visitor, { status: 413 })
  }
  const parsed = PatchBodySchema.safeParse(capped.ok ? capped.body : null)
  if (!parsed.success) {
    return withVisitorCookie({ error: "Invalid body", issues: parsed.error.issues }, visitor, { status: 400 })
  }

  const conn = await connectMongo()
  if (!conn.ok) {
    if (conn.reason === "unavailable") logHistoryDbError("connect", conn.error)
    return withVisitorCookie({ error: mongoConnectMessage("History", conn.reason) }, visitor, { status: 503 })
  }
  const db = conn.db

  try {
    const item = await patchHistoryMetadata({ db, visitorId: visitor.visitorId, id, patch: parsed.data })
    if (!item) {
      return withVisitorCookie({ error: "History entry not found." }, visitor, { status: 404 })
    }

    return withVisitorCookie({ item }, visitor, { status: 200 })
  } catch (err) {
    logHistoryDbError("patch", err)
    const mapped = mapHistoryDbError(err, "Failed to update history entry.")
    return withVisitorCookie({ error: mapped.message }, visitor, { status: mapped.status })
  }
}

export async function DELETE(req: NextRequest, ctx: RouteContext) {
  const clientKey = requestClientKey(req.headers)
  const rate = takeRateLimitToken({
    key: `history:delete:${clientKey}`,
    limit: DELETE_RATE_LIMIT_MAX,
    windowMs: RATE_LIMIT_WINDOW_MS,
  })
  if (!rate.ok) {
    return NextResponse.json(
      { error: "Too many history deletes. Please slow down." },
      { status: 429, headers: { "retry-after": String(rate.retryAfterSec) } }
    )
  }

  const visitor = getOrCreateVisitorContext(req)
  const id = await routeId(ctx)
  const conn = await connectMongo()
  if (!conn.ok) {
    if (conn.reason === "unavailable") logHistoryDbError("connect", conn.error)
    return withVisitorCookie({ error: mongoConnectMessage("History", conn.reason) }, visitor, { status: 503 })
  }
  const db = conn.db

  try {
    const ok = await deleteHistoryEntry({ db, visitorId: visitor.visitorId, id })
    if (!ok) {
      return withVisitorCookie({ error: "History entry not found." }, visitor, { status: 404 })
    }
    return withVisitorCookie({ ok: true }, visitor, { status: 200 })
  } catch (err) {
    logHistoryDbError("delete", err)
    const mapped = mapHistoryDbError(err, "Failed to delete history entry.")
    return withVisitorCookie({ error: mapped.message }, visitor, { status: mapped.status })
  }
}
