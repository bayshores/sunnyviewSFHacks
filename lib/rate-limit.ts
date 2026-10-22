// NOTE: This limiter is per-instance and in-memory (state lives on globalThis).
// On multi-instance / serverless deployments each instance keeps its own buckets,
// so limits are best-effort. Distributed (Upstash) limiting is out of scope.
//
// Client identity (see requestClientKey) is only as trustworthy as the proxy in
// front of the app: forwarding headers are client-controlled unless a trusted
// proxy overwrites them. We therefore honour one explicitly configured header.

type RateBucket = {
  count: number
  resetAt: number
}

type RateLimitResult = {
  ok: boolean
  retryAfterSec: number
}

const MAX_BUCKETS = 4000
const SWEEP_INTERVAL_MS = 30_000
const MAX_KEY_LENGTH = 64

let lastSweepAt = 0

function bucketMap() {
  const g = globalThis as unknown as { __sunnyviewRateLimitBuckets?: Map<string, RateBucket> }
  if (!g.__sunnyviewRateLimitBuckets) g.__sunnyviewRateLimitBuckets = new Map()
  return g.__sunnyviewRateLimitBuckets
}

/** Drops expired buckets, at most once per SWEEP_INTERVAL_MS (not on every call). */
function sweepExpired(now: number) {
  if (now >= lastSweepAt && now - lastSweepAt < SWEEP_INTERVAL_MS) return
  lastSweepAt = now
  const buckets = bucketMap()
  for (const [key, value] of buckets.entries()) {
    if (value.resetAt <= now) buckets.delete(key)
  }
}

/** Map iteration order is insertion order and touched keys are re-inserted, so the head is least recently used. */
function evictLeastRecentlyUsed() {
  const buckets = bucketMap()
  while (buckets.size > MAX_BUCKETS) {
    const oldestKey = buckets.keys().next().value
    if (oldestKey === undefined) break
    buckets.delete(oldestKey)
  }
}

export function takeRateLimitToken(opts: { key: string; limit: number; windowMs: number }): RateLimitResult {
  const now = Date.now()
  sweepExpired(now)

  const buckets = bucketMap()
  const existing = buckets.get(opts.key)
  const active = !existing || existing.resetAt <= now ? { count: 0, resetAt: now + opts.windowMs } : existing

  const blocked = active.count >= opts.limit
  if (!blocked) active.count += 1

  buckets.delete(opts.key)
  buckets.set(opts.key, active) // re-insert so recently used keys are evicted last
  evictLeastRecentlyUsed()

  if (blocked) {
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((active.resetAt - now) / 1000)) }
  }
  return { ok: true, retryAfterSec: 0 }
}

/**
 * Derive a client identifier from ONE trusted header.
 * - On Vercel (VERCEL=1) the default is `x-vercel-forwarded-for`, which the
 *   platform overwrites.
 * - Elsewhere only the header named by TRUSTED_PROXY_HEADER is read (for example
 *   `x-real-ip`, or `x-forwarded-for` where the right-most entry, appended by the
 *   nearest proxy, is used).
 * - With nothing configured we return "unknown": every client shares one bucket.
 *   That is deliberately conservative (a spoofable per-IP key would let anyone
 *   bypass limits by rotating header values), at the cost of a shared limit.
 */
export function requestClientKey(headers: Headers, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.TRUSTED_PROXY_HEADER?.trim().toLowerCase()
  const headerName = configured || (env.VERCEL === "1" ? "x-vercel-forwarded-for" : "")
  if (!headerName) return "unknown"

  const parts = (headers.get(headerName) ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
  const picked = headerName === "x-forwarded-for" ? parts[parts.length - 1] : parts[0]
  return picked ? picked.slice(0, MAX_KEY_LENGTH) : "unknown"
}
