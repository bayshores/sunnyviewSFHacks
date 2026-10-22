import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

import { attachVisitorCookie, type VisitorCookieContext } from "@/lib/history-visitor"
import { isClearlyCrossSite, readCappedJson } from "@/lib/request-guards"
import { requestClientKey, takeRateLimitToken } from "@/lib/rate-limit"

export const PROJECTS_MAX_BODY_BYTES = 250_000
export const PROJECTS_RATE_WINDOW_MS = 60_000

export function rateLimitResponse(req: NextRequest, scope: string, limit: number) {
  const rate = takeRateLimitToken({
    key: `projects:${scope}:${requestClientKey(req.headers)}`,
    limit,
    windowMs: PROJECTS_RATE_WINDOW_MS,
  })
  if (rate.ok) return null
  return NextResponse.json(
    { error: "Too many project requests. Please slow down." },
    { status: 429, headers: { "retry-after": String(rate.retryAfterSec) } }
  )
}

export function withVisitorCookie(payload: unknown, visitor: VisitorCookieContext, init?: ResponseInit) {
  return attachVisitorCookie(NextResponse.json(payload, init), visitor)
}

export const PROJECTS_NOT_CONFIGURED = "Project backend is not configured."

export type JsonBodyResult = { ok: true; body: unknown } | { ok: false; status: 400 | 403 | 413 | 415 }

/**
 * Reads and parses a JSON body for a mutating route. Rejects clearly cross-site
 * browser requests (403), non-JSON content types (415), and streams the body
 * with a running byte count, aborting at the cap (413).
 */
export async function readJsonBody(req: NextRequest): Promise<JsonBodyResult> {
  if (isClearlyCrossSite(req)) return { ok: false, status: 403 }
  return readCappedJson(req, PROJECTS_MAX_BODY_BYTES, { requireJson: true })
}
