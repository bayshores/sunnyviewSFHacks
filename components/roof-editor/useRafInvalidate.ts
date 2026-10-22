"use client"

import { useCallback, useEffect, useRef } from "react"
import type { RefObject } from "react"

/**
 * Coalesces redraw requests into one animation frame. Calls `drawRef.current` on the next
 * frame, redraws when `observeRef`'s element resizes, and cancels a pending frame on unmount.
 */
export function useRafInvalidate(
  drawRef: RefObject<() => void>,
  observeRef: RefObject<HTMLElement | null>
): () => void {
  const rafRef = useRef<number | null>(null)

  const invalidate = useCallback(() => {
    if (rafRef.current !== null) return
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null
      drawRef.current()
    })
  }, [drawRef])

  useEffect(() => {
    const el = observeRef.current
    if (!el) return
    const ro = new ResizeObserver(() => invalidate())
    ro.observe(el)
    return () => ro.disconnect()
  }, [invalidate, observeRef])

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [])

  return invalidate
}
