import { clamp, MERCATOR_MAX_LAT } from "@/lib/geo/math"

export { clamp }

export const EARTH_RADIUS_M = 6378137

export type MercatorMeters = { x: number; y: number }

export function mercatorProject(lat: number, lng: number): MercatorMeters {
  const R = EARTH_RADIUS_M
  const clampedLat = clamp(lat, -MERCATOR_MAX_LAT, MERCATOR_MAX_LAT)
  const x = (lng * Math.PI * R) / 180
  const y = R * Math.log(Math.tan(Math.PI / 4 + (clampedLat * Math.PI) / 360))
  return { x, y }
}

export function mercatorUnproject(m: MercatorMeters) {
  const R = EARTH_RADIUS_M
  const lng = (m.x / (Math.PI * R)) * 180
  const lat = (2 * Math.atan(Math.exp(m.y / R)) - Math.PI / 2) * (180 / Math.PI)
  return { lat: clamp(lat, -MERCATOR_MAX_LAT, MERCATOR_MAX_LAT), lng: clamp(lng, -180, 180) }
}

export function mercatorResolutionMetersPerPx(zoom: number) {
  const R = EARTH_RADIUS_M
  const z = Math.round(clamp(zoom, 0, 22))
  return (2 * Math.PI * R) / (256 * Math.pow(2, z))
}

export type StaticMapTransform = {
  center: MercatorMeters
  zoom: number
  baseW: number
  baseH: number
  scale: number
  widthPx: number
  heightPx: number
  resMPerPx: number
  xMin: number
  yMax: number
}

export function staticMapTransformFromCenter(opts: {
  lat: number
  lng: number
  zoom: number
  baseW: number
  baseH: number
  scale: number
  widthPx: number
  heightPx: number
}): StaticMapTransform {
  const center = mercatorProject(opts.lat, opts.lng)
  const resMPerPx = mercatorResolutionMetersPerPx(opts.zoom)
  const halfWm = (resMPerPx * opts.baseW) / 2
  const halfHm = (resMPerPx * opts.baseH) / 2
  const xMin = center.x - halfWm
  const yMax = center.y + halfHm
  return {
    center,
    zoom: opts.zoom,
    baseW: opts.baseW,
    baseH: opts.baseH,
    scale: opts.scale,
    widthPx: opts.widthPx,
    heightPx: opts.heightPx,
    resMPerPx,
    xMin,
    yMax,
  }
}

export function pixelToMercator(px: { x: number; y: number }, tf: StaticMapTransform): MercatorMeters {
  const x = tf.xMin + (px.x / tf.scale) * tf.resMPerPx
  const y = tf.yMax - (px.y / tf.scale) * tf.resMPerPx
  return { x, y }
}

export function mercatorToPixel(m: MercatorMeters, tf: StaticMapTransform) {
  const x = ((m.x - tf.xMin) / tf.resMPerPx) * tf.scale
  const y = ((tf.yMax - m.y) / tf.resMPerPx) * tf.scale
  return { x, y }
}

export function mercatorToNormalized(m: MercatorMeters, tf: StaticMapTransform) {
  const p = mercatorToPixel(m, tf)
  return { x: clamp(p.x / tf.widthPx, 0, 1), y: clamp(p.y / tf.heightPx, 0, 1) }
}
