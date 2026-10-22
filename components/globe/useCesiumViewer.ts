"use client"

import { useEffect, useState } from "react"
import {
  configureGlobeScene,
  createGlobeViewer,
  delay,
  loadBaseImagery,
  NAN_RENDER_ERROR_FRAGMENT,
  nextAnimationFrame,
  observeViewerResize,
  readIonToken,
  setCesiumBaseUrl,
  waitForGlobeTiles,
} from "./viewer-setup"
import type { RefObject } from "react"
import type { CesiumModule, CesiumRef, CesiumViewer, ViewerRef } from "./types"

/** Small delay after the first frame so the page paints before Cesium's heavy boot. */
const STARTUP_DELAY_MS = 60

type RenderErrorListener = (scene: unknown, error: unknown) => void

export type UseCesiumViewerOptions = {
  containerRef: RefObject<HTMLDivElement | null>
  viewerRef: ViewerRef
  cesiumRef: CesiumRef
  isHero: boolean
  onReadyChange?: (ready: boolean) => void
  /** Called when Cesium hits the degenerate-vector render error (caused by the landing orbit). */
  onNanRenderError: (viewer: CesiumViewer) => void
  /** Called on teardown right before the viewer is destroyed (stop loops, handlers, entities). */
  onBeforeDestroy: (viewer: CesiumViewer | null) => void
}

/**
 * Lazily boots a Cesium Viewer into `containerRef` and tears it down on unmount / variant change.
 * Guarantee: `onReadyChange(true)` is always reported eventually — on success, on boot failure and
 * on render errors — because the app's startup loader waits for it.
 */
export function useCesiumViewer({
  containerRef,
  viewerRef,
  cesiumRef,
  isHero,
  onReadyChange,
  onNanRenderError,
  onBeforeDestroy,
}: UseCesiumViewerOptions): { ready: boolean; error: string | null } {
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let ro: ResizeObserver | null = null
    let startupRaf: number | null = null
    let startupTimer: number | null = null
    let renderErrorListener: RenderErrorListener | null = null
    const isCancelled = () => cancelled
    const getViewer = () => viewerRef.current
    setReady(false)
    setError(null)
    onReadyChange?.(false)

    const createRenderErrorListener = (viewer: CesiumViewer): RenderErrorListener => (_scene, renderErr) => {
      if (cancelled) return

      const message = renderErr instanceof Error ? renderErr.message : String(renderErr ?? "")
      if (message.includes(NAN_RENDER_ERROR_FRAGMENT)) {
        onNanRenderError(viewer)
        try {
          viewer.scene.requestRender()
        } catch {
          // ignore
        }
        return
      }

      if (message.length > 0) {
        setError(message)
      }
      onReadyChange?.(true)
    }

    ;(async () => {
      try {
        await nextAnimationFrame((id) => {
          startupRaf = id
        })
        if (cancelled) return

        await delay(STARTUP_DELAY_MS, (id) => {
          startupTimer = id
        })
        if (cancelled) return

        const Cesium: CesiumModule = await import("cesium")
        cesiumRef.current = Cesium
        if (cancelled) return

        setCesiumBaseUrl()

        const token = readIonToken()
        // Cesium ion imagery shows ion branding + data attributions.
        // For the landing/hero globe we avoid ion imagery entirely.
        const useIonImagery = Boolean(token) && !isHero
        if (useIonImagery) {
          Cesium.Ion.defaultAccessToken = token
        }

        const el = containerRef.current
        if (!el) return

        const viewer = createGlobeViewer(Cesium, el, isHero)
        viewerRef.current = viewer
        renderErrorListener = createRenderErrorListener(viewer)
        try {
          viewer.scene.renderError.addEventListener(renderErrorListener)
        } catch {
          renderErrorListener = null
        }

        configureGlobeScene(Cesium, viewer, isHero)

        viewer.imageryLayers.removeAll()
        await loadBaseImagery(Cesium, useIonImagery, isCancelled, getViewer)
        if (cancelled) return

        await waitForGlobeTiles(viewerRef.current)
        if (cancelled) return

        ro = observeViewerResize(viewer, el)

        setReady(true)
        onReadyChange?.(true)
      } catch (e) {
        if (cancelled) return
        const msg = e instanceof Error ? e.message : "Failed to load Cesium."
        setError(msg)
        onReadyChange?.(true)
      }
    })()

    return () => {
      cancelled = true
      try {
        ro?.disconnect()
      } catch {
        // ignore
      }
      ro = null
      if (startupRaf !== null) {
        window.cancelAnimationFrame(startupRaf)
        startupRaf = null
      }
      if (startupTimer !== null) {
        window.clearTimeout(startupTimer)
        startupTimer = null
      }
      const v = viewerRef.current
      if (v && renderErrorListener) {
        try {
          v.scene.renderError.removeEventListener(renderErrorListener)
        } catch {
          // ignore
        }
      }
      renderErrorListener = null
      onBeforeDestroy(v)
      viewerRef.current = null
      try {
        v?.destroy()
      } catch {
        // ignore
      }
    }
  }, [cesiumRef, containerRef, isHero, onBeforeDestroy, onNanRenderError, onReadyChange, viewerRef])

  return { ready, error }
}
