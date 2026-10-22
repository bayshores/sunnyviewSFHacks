// Accent-driven colours for the hero landing orbit. Takes the Cesium module (or any object with a
// compatible `Color.fromHsl`) as a parameter so it can be unit tested without loading Cesium.

export type AlphaColor<C> = { withAlpha(alpha: number): C }

export type ColorFactory<C extends AlphaColor<C>> = {
  Color: { fromHsl(hue: number, saturation: number, lightness: number): C }
}

export type OrbitAccentColors<C> = {
  headColor: C
  trailCoreColor: C
  trailGlowColor: C
}

export const ORBIT_LIGHTNESS = 0.62
/** Accent saturation is stored as a small fraction; the orbit amplifies it so trails stay vivid. */
export const ORBIT_SATURATION_GAIN = 3.6
export const ORBIT_HEAD_ALPHA = 0.98
export const ORBIT_TRAIL_CORE_ALPHA = 0.46
export const ORBIT_TRAIL_GLOW_ALPHA = 0.16
export const ORBIT_SECONDARY_HEAD_ALPHA = 0.9
export const ORBIT_SECONDARY_TRAIL_CORE_ALPHA = 0.38
export const ORBIT_SECONDARY_TRAIL_GLOW_ALPHA = 0.11

/** Wraps any hue in degrees (including negatives) into [0, 1). */
export function normalizeHue(hue: number): number {
  return (((hue % 360) + 360) % 360) / 360
}

/** Applies the orbit saturation gain and clamps into [0, 1]. */
export function normalizeOrbitSaturation(saturation: number): number {
  return Math.max(0, Math.min(1, saturation * ORBIT_SATURATION_GAIN))
}

export function orbitAccentColors<C extends AlphaColor<C>>(
  Cesium: ColorFactory<C>,
  hue: number,
  saturation: number
): OrbitAccentColors<C> {
  const accent = Cesium.Color.fromHsl(normalizeHue(hue), normalizeOrbitSaturation(saturation), ORBIT_LIGHTNESS)
  return {
    headColor: accent.withAlpha(ORBIT_HEAD_ALPHA),
    trailCoreColor: accent.withAlpha(ORBIT_TRAIL_CORE_ALPHA),
    trailGlowColor: accent.withAlpha(ORBIT_TRAIL_GLOW_ALPHA),
  }
}
