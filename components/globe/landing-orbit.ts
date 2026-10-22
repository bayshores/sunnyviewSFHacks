// Imperative Cesium controller for the hero landing orbit: two glowing particle heads with
// core + glow polyline trails circling the globe on a slowly precessing, camera-relative plane.
// All mutable animation state lives here (not in React state) so animating never re-renders.

import {
  advanceTrail,
  frameDeltaSeconds,
  isFiniteCartesian3,
  orbitHeadScale,
  orbitPointComponents,
  orbitSecondaryHeadScale,
  shouldSkipFrame,
} from "./math"
import { computeOrbitBasis, createOrbitBasisScratch } from "./orbit-basis"
import {
  ORBIT_SECONDARY_HEAD_ALPHA,
  ORBIT_SECONDARY_TRAIL_CORE_ALPHA,
  ORBIT_SECONDARY_TRAIL_GLOW_ALPHA,
  orbitAccentColors,
} from "./orbit-colors"
import { createOrbitParticleSprite } from "./orbit-sprite"
import type { CesiumModule, CesiumViewer } from "./types"

type Cesium = CesiumModule
type Cartesian3 = import("cesium").Cartesian3
type Billboard = import("cesium").Billboard
type BillboardCollection = import("cesium").BillboardCollection
type Entity = import("cesium").Entity
type PolylineGlowMaterialProperty = import("cesium").PolylineGlowMaterialProperty

const ORBIT = {
  radiusFactor: 1.06,
  secondaryRadiusFactor: 1.115,
  planeTiltDeg: 82,
  planePrecessionDegPerSec: 28,
  trailPointCount: 36,
  speedDegPerSec: 96,
  frameIntervalMs: 1000 / 26,
  initialAngleDeg: 18,
  initialPrecessionDeg: 20,
  headScale: 0.8,
  secondaryHeadScale: 0.72,
} as const

const PRIMARY_GLOW = { glowPower: 0.22, taperPower: 0.78 } as const
const SECONDARY_GLOW = { glowPower: 0.2, taperPower: 0.72 } as const

export type LandingOrbitOptions = {
  Cesium: Cesium
  viewer: CesiumViewer
  /** Live viewer accessor (null once the viewer is torn down). */
  getViewer: () => CesiumViewer | null
  hue: number
  saturation: number
}

export type LandingOrbit = {
  /** Draws a single frame (reduced motion). Returns false when the orbit could not be drawn. */
  drawStatic(): boolean
  /** Starts the throttled rAF loop; `onFail` is called once if a frame cannot be drawn. */
  startLoop(isCancelled: () => boolean, onFail: () => void): void
  /** Recolours heads and trails from the accent hue/saturation. */
  applyAccent(Cesium: Cesium, hue: number, saturation: number): void
  /** Stops the loop and removes every primitive/entity from `viewer` (if given). */
  dispose(viewer: CesiumViewer | null): void
}

type OrbitParts = {
  billboards: BillboardCollection | null
  head: Billboard | null
  secondaryHead: Billboard | null
  trailCore: Entity | null
  secondaryTrailCore: Entity | null
  trailGlow: Entity | null
  secondaryTrailGlow: Entity | null
  trailGlowMaterial: PolylineGlowMaterialProperty | null
  secondaryTrailGlowMaterial: PolylineGlowMaterialProperty | null
}

function emptyParts(): OrbitParts {
  return {
    billboards: null,
    head: null,
    secondaryHead: null,
    trailCore: null,
    secondaryTrailCore: null,
    trailGlow: null,
    secondaryTrailGlow: null,
    trailGlowMaterial: null,
    secondaryTrailGlowMaterial: null,
  }
}

function removeParts(viewer: CesiumViewer, parts: OrbitParts) {
  if (parts.billboards) {
    try {
      viewer.scene.primitives.remove(parts.billboards)
    } catch {
      // ignore
    }
  }
  const entities = [parts.trailCore, parts.secondaryTrailCore, parts.trailGlow, parts.secondaryTrailGlow]
  for (const entity of entities) {
    if (!entity) continue
    try {
      viewer.entities.remove(entity)
    } catch {
      // ignore
    }
  }
}

/** Creates the orbit. Returns null (after cleaning up anything it added) if the geometry is degenerate. */
export function createLandingOrbit({ Cesium, viewer, getViewer, hue, saturation }: LandingOrbitOptions): LandingOrbit | null {
  const { headColor, trailCoreColor, trailGlowColor } = orbitAccentColors(Cesium, hue, saturation)
  const sprite = createOrbitParticleSprite()

  let parts = emptyParts()
  let trail: Cartesian3[] = []
  let secondaryTrail: Cartesian3[] = []
  let rafId: number | null = null
  let lastNow: number | null = null

  const billboards = viewer.scene.primitives.add(new Cesium.BillboardCollection())
  parts.billboards = billboards
  const orbitHead = billboards.add({ image: sprite, color: headColor, scale: ORBIT.headScale })
  parts.head = orbitHead

  const ellipsoid = viewer.scene.globe.ellipsoid
  const orbitRadius = ellipsoid.maximumRadius * ORBIT.radiusFactor
  const orbitSecondaryRadius = ellipsoid.maximumRadius * ORBIT.secondaryRadiusFactor
  const orbitPlaneTiltRad = Cesium.Math.toRadians(ORBIT.planeTiltDeg)
  const orbitPlanePrecessionRadPerSec = Cesium.Math.toRadians(ORBIT.planePrecessionDegPerSec)
  const speedRadPerSec = Cesium.Math.toRadians(ORBIT.speedDegPerSec)
  const secondaryPhaseOffsetRad = Cesium.Math.PI
  const scratch = createOrbitBasisScratch(Cesium)

  let angle = Cesium.Math.toRadians(ORBIT.initialAngleDeg)
  let planePrecessionAngle = Cesium.Math.toRadians(ORBIT.initialPrecessionDeg)

  const dispose = (viewerArg: CesiumViewer | null) => {
    if (rafId !== null) {
      window.cancelAnimationFrame(rafId)
      rafId = null
    }
    lastNow = null
    const removed = parts
    parts = emptyParts()
    trail = []
    secondaryTrail = []
    if (viewerArg) removeParts(viewerArg, removed)
  }

  const updateBasis = () =>
    computeOrbitBasis(Cesium, getViewer, planePrecessionAngle, orbitPlaneTiltRad, scratch)

  const orbitPoint = (a: number, radius: number) => {
    const p = orbitPointComponents(scratch.basisU, scratch.basisV, a, radius)
    return new Cesium.Cartesian3(p.x, p.y, p.z)
  }

  const secondaryPoint = () => orbitPoint((angle + secondaryPhaseOffsetRad) % Cesium.Math.TWO_PI, orbitSecondaryRadius)

  if (!updateBasis()) {
    dispose(viewer)
    return null
  }
  const initialHeadPosition = orbitPoint(angle, orbitRadius)
  if (!isFiniteCartesian3(initialHeadPosition)) {
    dispose(viewer)
    return null
  }
  const initialSecondaryHeadPosition = secondaryPoint()
  if (!isFiniteCartesian3(initialSecondaryHeadPosition)) {
    dispose(viewer)
    return null
  }
  trail = [initialHeadPosition, initialHeadPosition]
  secondaryTrail = [initialSecondaryHeadPosition, initialSecondaryHeadPosition]

  orbitHead.position = initialHeadPosition

  const orbitSecondaryHead = billboards.add({
    image: sprite,
    color: headColor.withAlpha(ORBIT_SECONDARY_HEAD_ALPHA),
    scale: ORBIT.secondaryHeadScale,
  })
  orbitSecondaryHead.position = initialSecondaryHeadPosition
  parts.secondaryHead = orbitSecondaryHead

  const trailPositionsProperty = new Cesium.CallbackProperty(() => trail, false)
  const secondaryTrailPositionsProperty = new Cesium.CallbackProperty(() => secondaryTrail, false)

  const trailGlowMaterial = new Cesium.PolylineGlowMaterialProperty({ color: trailGlowColor, ...PRIMARY_GLOW })
  parts.trailGlowMaterial = trailGlowMaterial
  const secondaryTrailGlowMaterial = new Cesium.PolylineGlowMaterialProperty({
    color: trailGlowColor.withAlpha(ORBIT_SECONDARY_TRAIL_GLOW_ALPHA),
    ...SECONDARY_GLOW,
  })
  parts.secondaryTrailGlowMaterial = secondaryTrailGlowMaterial

  parts.trailGlow = viewer.entities.add({
    polyline: { positions: trailPositionsProperty, width: 14, material: trailGlowMaterial },
  })
  parts.trailCore = viewer.entities.add({
    polyline: { positions: trailPositionsProperty, width: 4, material: trailCoreColor },
  })
  parts.secondaryTrailGlow = viewer.entities.add({
    polyline: { positions: secondaryTrailPositionsProperty, width: 11, material: secondaryTrailGlowMaterial },
  })
  parts.secondaryTrailCore = viewer.entities.add({
    polyline: {
      positions: secondaryTrailPositionsProperty,
      width: 3,
      material: trailCoreColor.withAlpha(ORBIT_SECONDARY_TRAIL_CORE_ALPHA),
    },
  })

  const drawFrame = (now: number, advance: boolean): boolean => {
    const viewerNow = getViewer()
    const headNow = parts.head
    const secondaryHeadNow = parts.secondaryHead
    if (!viewerNow || !headNow || !secondaryHeadNow) return false

    const dt = frameDeltaSeconds(now, lastNow ?? now)
    lastNow = now

    if (advance) {
      angle = (angle + speedRadPerSec * dt) % Cesium.Math.TWO_PI
      planePrecessionAngle = (planePrecessionAngle + orbitPlanePrecessionRadPerSec * dt) % Cesium.Math.TWO_PI
    }

    if (!updateBasis()) return false

    const headPosition = orbitPoint(angle, orbitRadius)
    const secondaryHeadPosition = secondaryPoint()
    if (!isFiniteCartesian3(headPosition) || !isFiniteCartesian3(secondaryHeadPosition)) return false

    headNow.position = headPosition
    secondaryHeadNow.position = secondaryHeadPosition
    headNow.scale = orbitHeadScale(now)
    secondaryHeadNow.scale = orbitSecondaryHeadScale(now)

    const nextTrail = advanceTrail(trail, headPosition, ORBIT.trailPointCount)
    if (!nextTrail) return false
    trail = nextTrail

    const nextSecondaryTrail = advanceTrail(secondaryTrail, secondaryHeadPosition, ORBIT.trailPointCount)
    if (!nextSecondaryTrail) return false
    secondaryTrail = nextSecondaryTrail

    viewerNow.scene.requestRender()
    return true
  }

  return {
    drawStatic: () => drawFrame(performance.now(), false),
    startLoop: (isCancelled, onFail) => {
      const tick = (now: number) => {
        if (isCancelled()) return
        if (shouldSkipFrame(now, lastNow, ORBIT.frameIntervalMs)) {
          rafId = window.requestAnimationFrame(tick)
          return
        }
        if (!drawFrame(now, true)) {
          onFail()
          return
        }
        rafId = window.requestAnimationFrame(tick)
      }
      lastNow = null
      rafId = window.requestAnimationFrame(tick)
    },
    applyAccent: (CesiumNow, hueNow, saturationNow) => applyOrbitAccent(CesiumNow, parts, hueNow, saturationNow),
    dispose,
  }
}

function applyOrbitAccent(Cesium: Cesium, parts: OrbitParts, hue: number, saturation: number) {
  const { headColor, trailCoreColor, trailGlowColor } = orbitAccentColors(Cesium, hue, saturation)

  if (parts.head) {
    parts.head.color = headColor
  }
  if (parts.secondaryHead) {
    parts.secondaryHead.color = headColor.withAlpha(ORBIT_SECONDARY_HEAD_ALPHA)
  }

  // Cesium's PolylineGraphics.material setter accepts a Color and wraps it in a
  // ColorMaterialProperty at runtime, but the typings only declare MaterialProperty.
  const corePolyline = parts.trailCore?.polyline
  if (corePolyline) {
    corePolyline.material = trailCoreColor as unknown as import("cesium").MaterialProperty
  }
  const secondaryCorePolyline = parts.secondaryTrailCore?.polyline
  if (secondaryCorePolyline) {
    secondaryCorePolyline.material = trailCoreColor.withAlpha(
      ORBIT_SECONDARY_TRAIL_CORE_ALPHA
    ) as unknown as import("cesium").MaterialProperty
  }

  // Likewise PolylineGlowMaterialProperty.color accepts a raw Color (wrapped in a ConstantProperty).
  if (parts.trailGlowMaterial) {
    parts.trailGlowMaterial.color = trailGlowColor as unknown as import("cesium").Property
  } else if (parts.trailGlow?.polyline) {
    parts.trailGlow.polyline.material = new Cesium.PolylineGlowMaterialProperty({ color: trailGlowColor, ...PRIMARY_GLOW })
  }

  const secondaryTrailGlowColor = trailGlowColor.withAlpha(ORBIT_SECONDARY_TRAIL_GLOW_ALPHA)
  if (parts.secondaryTrailGlowMaterial) {
    parts.secondaryTrailGlowMaterial.color = secondaryTrailGlowColor as unknown as import("cesium").Property
  } else if (parts.secondaryTrailGlow?.polyline) {
    parts.secondaryTrailGlow.polyline.material = new Cesium.PolylineGlowMaterialProperty({
      color: secondaryTrailGlowColor,
      ...SECONDARY_GLOW,
    })
  }
}
