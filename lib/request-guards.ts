export type CappedJsonResult =
  | { ok: true; body: unknown }
  | { ok: false; status: 400 | 413 | 415 }

function requestOrigin(req: Request): string | null {
  try {
    return new URL(req.url).origin
  } catch {
    return null
  }
}

/**
 * True only when the browser says the request came from this origin
 * (`Sec-Fetch-Site: same-origin|none`) or its `Origin` matches the request URL.
 * Header-less clients (curl, server-to-server) return false; use
 * isClearlyCrossSite() to reject only browser-originated cross-site calls.
 */
export function isSameOriginRequest(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site")?.trim().toLowerCase()
  if (site === "same-origin" || site === "none") return true
  const origin = req.headers.get("origin")?.trim()
  return !!origin && origin === requestOrigin(req)
}

/**
 * True when the request is clearly a cross-site browser request: Sec-Fetch-Site
 * says cross-site, or an Origin header is present and differs from the request
 * origin. Requests without these headers are not considered cross-site.
 * This is a CSRF / key-abuse mitigation, not authentication (headers can be
 * forged by non-browser clients).
 */
export function isClearlyCrossSite(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site")?.trim().toLowerCase()
  if (site === "same-origin" || site === "none") return false
  if (site === "cross-site") return true
  const origin = req.headers.get("origin")?.trim()
  if (!origin) return false
  return origin !== requestOrigin(req)
}

function declaredLength(req: Request): number {
  const raw = req.headers.get("content-length")
  if (raw === null || raw.trim() === "") return NaN
  return Number(raw)
}

/**
 * Reads a JSON body while counting bytes, aborting as soon as `maxBytes` is
 * exceeded (the body is never fully buffered past the cap).
 */
export async function readCappedJson(
  req: Request,
  maxBytes: number,
  opts: { requireJson?: boolean } = {}
): Promise<CappedJsonResult> {
  if (opts.requireJson) {
    const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()
    if (type !== "application/json") return { ok: false, status: 415 }
  }

  const declared = declaredLength(req)
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, status: 413 }

  let text: string
  try {
    const reader = req.body?.getReader()
    if (!reader) {
      text = ""
    } else {
      const chunks: Uint8Array[] = []
      let total = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        total += value.byteLength
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined)
          return { ok: false, status: 413 }
        }
        chunks.push(value)
      }
      text = new TextDecoder().decode(Buffer.concat(chunks))
    }
  } catch {
    return { ok: false, status: 400 }
  }

  try {
    return { ok: true, body: JSON.parse(text) as unknown }
  } catch {
    return { ok: false, status: 400 }
  }
}
