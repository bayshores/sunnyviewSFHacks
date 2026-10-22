// Pure math helpers for the globe (no Cesium / DOM imports so they run in node tests).

export type Vec3Like = { x: number; y: number; z: number }

/** Max per-frame step (seconds) used by every animation loop to avoid jumps after tab switches. */
export const MAX_FRAME_DT_SECONDS = 0.05

export function isFiniteCartesian3(value: Vec3Like): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z)
}

/** Seconds elapsed since `lastNow` (ms), clamped to MAX_FRAME_DT_SECONDS. */
export function frameDeltaSeconds(now: number, lastNow: number): number {
  return Math.min(MAX_FRAME_DT_SECONDS, (now - lastNow) / 1000)
}

/** True when a throttled loop should skip this frame (not enough time since the last drawn frame). */
export function shouldSkipFrame(now: number, lastNow: number | null, frameIntervalMs: number): boolean {
  return lastNow !== null && now - lastNow < frameIntervalMs
}

/** Point on a circle of `radius` spanned by orthonormal basis vectors u/v at angle `a`. */
export function orbitPointComponents(u: Vec3Like, v: Vec3Like, a: number, radius: number): Vec3Like {
  const cosA = Math.cos(a)
  const sinA = Math.sin(a)
  return {
    x: u.x * cosA * radius + v.x * sinA * radius,
    y: u.y * cosA * radius + v.y * sinA * radius,
    z: u.z * cosA * radius + v.z * sinA * radius,
  }
}

/**
 * Builds the next trail: newest head first, followed by up to `maxPoints - 1` previous points.
 * A trail always has at least two points (Cesium polylines need two). Returns null when a
 * carried-over point is not finite (the caller tears the orbit down in that case).
 */
export function advanceTrail<T extends Vec3Like>(
  prevTrail: readonly T[],
  head: T,
  maxPoints: number
): T[] | null {
  const nextTrail: T[] = [head]
  const carryCount = Math.min(maxPoints - 1, prevTrail.length)
  for (let i = 0; i < carryCount; i += 1) {
    const point = prevTrail[i]
    if (!isFiniteCartesian3(point)) return null
    nextTrail.push(point)
  }
  if (nextTrail.length < 2) {
    nextTrail.push(head)
  }
  return nextTrail
}

/** Pulsing billboard scale for the primary orbit head. */
export function orbitHeadScale(now: number): number {
  return 0.76 + Math.sin(now * 0.0044) * 0.08
}

/** Pulsing billboard scale for the secondary orbit head. */
export function orbitSecondaryHeadScale(now: number): number {
  return 0.68 + Math.sin(now * 0.0038 + 1.4) * 0.06
}

export const CENTER_SPIN = {
  delayMs: 90,
  durationMs: 1220,
  maxRadPerSec: 0.95,
} as const

/** Normalised progress [0, 1] of the click spin once its start delay has passed. */
export function centerSpinProgress(elapsedMs: number): number {
  return Math.min(1, (elapsedMs - CENTER_SPIN.delayMs) / CENTER_SPIN.durationMs)
}

/** Sine ease-in/out angular velocity (rad/s) for the click spin at progress `t`. */
export function centerSpinVelocity(t: number): number {
  return CENTER_SPIN.maxRadPerSec * Math.sin(Math.PI * t)
}

export function hasFiniteLocation(lat: number | null, lng: number | null): boolean {
  return Number.isFinite(lat ?? NaN) && Number.isFinite(lng ?? NaN)
}

export function formatLocationLabel(lat: number | null, lng: number | null): string {
  if (lat === null || lng === null || !hasFiniteLocation(lat, lng)) return "No location yet"
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`
}
