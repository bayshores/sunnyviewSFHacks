"use client"

import { useEffect } from "react"
import { prefersReducedMotion } from "./camera"
import { frameDeltaSeconds } from "./math"
import type { RafRef, ViewerRef } from "./types"

const HERO_SPIN = { speedRadPerSec: 0.011, delayMs: 300 } as const
const APP_SPIN = { speedRadPerSec: 0.03, delayMs: 1050 } as const

export type UseLandingSpinOptions = {
  ready: boolean
  isHero: boolean
  landingActive: boolean
  viewerRef: ViewerRef
  landingSpinRafRef: RafRef
  landingSpinLastNowRef: RafRef
  cancelLandingSpin: () => void
}

/** Idle auto-rotation while the landing globe waits for its first click (skipped for reduced motion). */
export function useLandingSpin({
  ready,
  isHero,
  landingActive,
  viewerRef,
  landingSpinRafRef,
  landingSpinLastNowRef,
  cancelLandingSpin,
}: UseLandingSpinOptions): void {
  useEffect(() => {
    if (!ready) return
    const viewer = viewerRef.current
    if (!viewer) return

    cancelLandingSpin()

    if (!landingActive) return

    const reduceMotion = prefersReducedMotion()
    try {
      viewer.camera.flyHome(reduceMotion ? 0 : 1)
    } catch {
      // ignore
    }

    if (reduceMotion) return

    const { speedRadPerSec, delayMs } = isHero ? HERO_SPIN : APP_SPIN

    const tick = (now: number) => {
      const viewerNow = viewerRef.current
      if (!viewerNow) return
      const dt = frameDeltaSeconds(now, landingSpinLastNowRef.current ?? now)
      landingSpinLastNowRef.current = now
      try {
        viewerNow.camera.rotateRight(speedRadPerSec * dt)
        viewerNow.scene.requestRender()
      } catch {
        return
      }
      landingSpinRafRef.current = window.requestAnimationFrame(tick)
    }

    const startTimer = window.setTimeout(() => {
      landingSpinLastNowRef.current = null
      landingSpinRafRef.current = window.requestAnimationFrame(tick)
    }, delayMs)

    return () => {
      window.clearTimeout(startTimer)
      if (landingSpinRafRef.current !== null) {
        window.cancelAnimationFrame(landingSpinRafRef.current)
        landingSpinRafRef.current = null
      }
      landingSpinLastNowRef.current = null
    }
  }, [cancelLandingSpin, isHero, landingActive, landingSpinLastNowRef, landingSpinRafRef, ready, viewerRef])
}
