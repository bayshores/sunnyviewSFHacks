import { SafeImageError } from "@/lib/segment/errors"

export async function fetchWithTimeout(input: string | URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  const parentSignal = init.signal
  const onParentAbort = () => controller.abort()
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort()
    else parentSignal.addEventListener("abort", onParentAbort, { once: true })
  }

  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeoutId)
    if (parentSignal) parentSignal.removeEventListener("abort", onParentAbort)
  }
}

export const MAX_IMAGE_REDIRECTS = 3

/**
 * Fetches `start` following redirects manually. Every hop (including the first)
 * goes through `validate`, which must throw when the URL may not be fetched.
 */
export async function fetchWithValidatedRedirects(
  start: URL,
  validate: (url: string) => URL,
  init: RequestInit,
  timeoutMs: number,
  maxRedirects: number = MAX_IMAGE_REDIRECTS
): Promise<Response> {
  let current = start
  for (let hop = 0; ; hop++) {
    const res = await fetchWithTimeout(current.toString(), { ...init, redirect: "manual" }, timeoutMs)
    const isRedirect = res.status >= 300 && res.status < 400
    if (!isRedirect) return res

    const location = res.headers.get("location")
    await res.body?.cancel().catch(() => undefined)
    if (!location) throw new SafeImageError("Image fetch failed (redirect without location)")
    if (hop >= maxRedirects) throw new SafeImageError("Image fetch followed too many redirects")
    let next: string
    try {
      next = new URL(location, current).toString()
    } catch {
      throw new SafeImageError("Image fetch failed (invalid redirect)")
    }
    current = validate(next)
  }
}

export async function readBufferWithLimit(res: Response, maxBytes: number): Promise<ArrayBuffer> {
  const limitError = () => new SafeImageError(`Image exceeds ${Math.round(maxBytes / (1024 * 1024))}MB limit`)
  const contentLength = Number(res.headers.get("content-length") ?? "")
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw limitError()

  const reader = res.body?.getReader()
  if (!reader) {
    const fallback = await res.arrayBuffer()
    if (fallback.byteLength > maxBytes) throw limitError()
    return fallback
  }

  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw limitError()
    }
    chunks.push(value)
  }

  const combined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return combined.buffer
}

/** Estimated decoded size of a base64 data:image/* URL, or null when it is not one. */
export function estimateDataUrlBytes(dataUrl: string): number | null {
  const commaIdx = dataUrl.indexOf(",")
  if (commaIdx < 0) return null
  const meta = dataUrl.slice(0, commaIdx).toLowerCase()
  if (!meta.startsWith("data:image/")) return null
  const base64 = dataUrl.slice(commaIdx + 1)
  if (!base64.length) return null
  const pad = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - pad
}
