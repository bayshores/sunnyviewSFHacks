// Camera-relative orbit plane basis for the hero landing orbit.
// Every intermediate vector is validated: Cesium throws "normalized result is not a number" on
// degenerate input, which would break the render loop, so we bail out (return false) instead.

import { isFiniteCartesian3 } from "./math"
import type { CesiumModule, CesiumViewer } from "./types"

type Cartesian3 = import("cesium").Cartesian3

export type OrbitBasisScratch = {
  normal: Cartesian3
  basisU: Cartesian3
  basisV: Cartesian3
  precessionDir: Cartesian3
  axis: Cartesian3
}

export function createOrbitBasisScratch(Cesium: CesiumModule): OrbitBasisScratch {
  return {
    normal: new Cesium.Cartesian3(),
    basisU: new Cesium.Cartesian3(),
    basisV: new Cesium.Cartesian3(),
    precessionDir: new Cesium.Cartesian3(),
    axis: new Cesium.Cartesian3(),
  }
}

/** Normalises `value` in place when its squared magnitude is finite and non-degenerate. */
function normalizeChecked(Cesium: CesiumModule, value: Cartesian3): boolean {
  const magnitudeSq = Cesium.Cartesian3.magnitudeSquared(value)
  if (!Number.isFinite(magnitudeSq) || magnitudeSq <= Cesium.Math.EPSILON12) {
    return false
  }
  Cesium.Cartesian3.normalize(value, value)
  return isFiniteCartesian3(value)
}

/** Initial basis: plane perpendicular to the camera direction. Writes s.normal / s.basisU / s.basisV. */
function computeCameraFacingBasis(Cesium: CesiumModule, cameraPos: Cartesian3, s: OrbitBasisScratch): boolean {
  const C3 = Cesium.Cartesian3
  Cesium.Cartesian3.normalize(cameraPos, s.normal)
  if (!isFiniteCartesian3(s.normal)) {
    return false
  }

  const axis = Math.abs(C3.dot(s.normal, C3.UNIT_Z)) > 0.9 ? C3.UNIT_Y : C3.UNIT_Z
  C3.clone(axis, s.axis)

  C3.cross(s.axis, s.normal, s.basisU)
  let basisUMagnitudeSq = C3.magnitudeSquared(s.basisU)
  if (!Number.isFinite(basisUMagnitudeSq) || basisUMagnitudeSq <= Cesium.Math.EPSILON12) {
    C3.cross(C3.UNIT_X, s.normal, s.basisU)
    basisUMagnitudeSq = C3.magnitudeSquared(s.basisU)
  }
  if (!Number.isFinite(basisUMagnitudeSq) || basisUMagnitudeSq <= Cesium.Math.EPSILON12) {
    return false
  }
  C3.normalize(s.basisU, s.basisU)
  if (!isFiniteCartesian3(s.basisU)) {
    return false
  }

  C3.cross(s.normal, s.basisU, s.basisV)
  return normalizeChecked(Cesium, s.basisV)
}

/** Rotates the camera-facing basis by the precession angle and tilts the plane normal. */
function applyPrecessionAndTilt(
  Cesium: CesiumModule,
  precessionAngleRad: number,
  tiltRad: number,
  s: OrbitBasisScratch
): boolean {
  const C3 = Cesium.Cartesian3
  C3.multiplyByScalar(s.basisU, Math.cos(precessionAngleRad), s.axis)
  C3.multiplyByScalar(s.basisV, Math.sin(precessionAngleRad), s.precessionDir)
  C3.add(s.axis, s.precessionDir, s.precessionDir)
  if (!normalizeChecked(Cesium, s.precessionDir)) {
    return false
  }

  C3.multiplyByScalar(s.normal, Math.cos(tiltRad), s.axis)
  C3.multiplyByScalar(s.precessionDir, Math.sin(tiltRad), s.normal)
  C3.add(s.axis, s.normal, s.normal)
  if (!normalizeChecked(Cesium, s.normal)) {
    return false
  }

  const projectedAmount = C3.dot(s.precessionDir, s.normal)
  C3.multiplyByScalar(s.normal, projectedAmount, s.axis)
  C3.subtract(s.precessionDir, s.axis, s.basisU)
  if (!normalizeChecked(Cesium, s.basisU)) {
    return false
  }

  C3.cross(s.normal, s.basisU, s.basisV)
  return normalizeChecked(Cesium, s.basisV)
}

/**
 * Computes the orbit basis (s.basisU / s.basisV) for the current camera of the live viewer.
 * Returns false (never throws) when the viewer is gone or any vector is degenerate.
 */
export function computeOrbitBasis(
  Cesium: CesiumModule,
  getViewer: () => CesiumViewer | null,
  precessionAngleRad: number,
  tiltRad: number,
  scratch: OrbitBasisScratch
): boolean {
  try {
    const viewer = getViewer()
    if (!viewer) return false

    const cameraPos = viewer.camera.positionWC
    if (!isFiniteCartesian3(cameraPos)) {
      return false
    }

    const cameraMagnitudeSq = Cesium.Cartesian3.magnitudeSquared(cameraPos)
    if (!Number.isFinite(cameraMagnitudeSq) || cameraMagnitudeSq <= Cesium.Math.EPSILON12) {
      return false
    }

    if (!computeCameraFacingBasis(Cesium, cameraPos, scratch)) return false
    return applyPrecessionAndTilt(Cesium, precessionAngleRad, tiltRad, scratch)
  } catch {
    return false
  }
}
