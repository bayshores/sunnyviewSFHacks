// Server-side helper that fetches Esri World_Imagery directly (no self-HTTP hop).

const ARCGIS_EXPORT_URL = "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export"
const EARTH_RADIUS_M = 6378137
export const ARCGIS_MAX_IMAGE_BYTES = 8 * 1024 * 1024

export type ArcgisImagery = {
  mimeType: string
  dataBase64: string
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

export function buildArcgisImageryUrl(opts: {
  lat: number
  lng: number
  zoom: number
  w: number
  h: number
  scale: number
}): URL {
  const lat = clamp(opts.lat, -85.05112878, 85.05112878)
  const lng = clamp(opts.lng, -180, 180)
  const w = clamp(Math.round(opts.w), 64, 2048)
  const h = clamp(Math.round(opts.h), 64, 2048)
  const scale = clamp(Math.round(opts.scale), 1, 2)

  const x = (lng * Math.PI * EARTH_RADIUS_M) / 180
  const y = EARTH_RADIUS_M * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))
  const z = Math.round(clamp(opts.zoom, 0, 22))
  const resMPerPx = (2 * Math.PI * EARTH_RADIUS_M) / (256 * Math.pow(2, z))
  const halfWm = (resMPerPx * w) / 2
  const halfHm = (resMPerPx * h) / 2
  const bbox = `${(x - halfWm).toFixed(6)},${(y - halfHm).toFixed(6)},${(x + halfWm).toFixed(6)},${(y + halfHm).toFixed(6)}`

  const url = new URL(ARCGIS_EXPORT_URL)
  url.searchParams.set("bbox", bbox)
  url.searchParams.set("bboxSR", "3857")
  url.searchParams.set("imageSR", "3857")
  url.searchParams.set("size", `${clamp(w * scale, 64, 2048)},${clamp(h * scale, 64, 2048)}`)
  url.searchParams.set("format", "png32")
  url.searchParams.set("f", "image")
  return url
}

/** Returns null on any non-image / oversized / empty / failed response. */
export async function fetchArcgisImageryBase64(opts: {
  lat: number
  lng: number
  zoom?: number
  w?: number
  h?: number
  scale?: number
  signal: AbortSignal
  maxBytes?: number
}): Promise<ArcgisImagery | null> {
  const maxBytes = opts.maxBytes ?? ARCGIS_MAX_IMAGE_BYTES
  const url = buildArcgisImageryUrl({
    lat: opts.lat,
    lng: opts.lng,
    zoom: opts.zoom ?? 20,
    w: opts.w ?? 520,
    h: opts.h ?? 360,
    scale: opts.scale ?? 2,
  })

  const res = await fetch(url.toString(), {
    signal: opts.signal,
    headers: { accept: "image/*" },
    cache: "no-store",
  })
  if (!res.ok) return null

  const mimeType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()
  if (!mimeType.startsWith("image/")) return null

  const declared = Number(res.headers.get("content-length") ?? "")
  if (Number.isFinite(declared) && declared > maxBytes) return null

  const buf = Buffer.from(await res.arrayBuffer())
  if (!buf.byteLength || buf.byteLength > maxBytes) return null
  return { mimeType, dataBase64: buf.toString("base64") }
}
