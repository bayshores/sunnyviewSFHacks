// Cesium Viewer construction and startup helpers (imperative, no React).

import type { CesiumModule, CesiumViewer } from "./types"

/** Next.js: CopyWebpackPlugin outputs to `/_next/static/cesium/*` (Workers, Assets, Widgets). */
export const CESIUM_BASE_URL = "/_next/static/cesium"
export const ESRI_WORLD_IMAGERY_URL =
  "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer"
export const HERO_RESOLUTION_SCALE = 0.84
/** Upper bound for waiting on initial tiles before reporting ready anyway. */
export const TILE_LOAD_TIMEOUT_MS = 9000
/** Error Cesium throws when a degenerate vector is normalised (caused by the landing orbit). */
export const NAN_RENDER_ERROR_FRAGMENT = "normalized result is not a number"

export function readIonToken(): string {
  return (process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN ?? "").trim()
}

export function setCesiumBaseUrl(): void {
  ;(globalThis as { CESIUM_BASE_URL?: string }).CESIUM_BASE_URL = CESIUM_BASE_URL
}

export function createGlobeViewer(Cesium: CesiumModule, el: HTMLElement, isHero: boolean): CesiumViewer {
  return new Cesium.Viewer(el, {
    animation: false,
    timeline: false,
    baseLayerPicker: false,
    baseLayer: false,
    geocoder: false,
    sceneModePicker: false,
    homeButton: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    shouldAnimate: false,
    requestRenderMode: true,
    maximumRenderTimeChange: Infinity,
    scene3DOnly: true,
    contextOptions: isHero ? { webgl: { alpha: true } } : undefined,
  })
}

/** Hero: transparent, no sky/sun/moon/atmosphere. App: lighting, atmosphere and fog. */
export function configureGlobeScene(Cesium: CesiumModule, viewer: CesiumViewer, isHero: boolean): void {
  viewer.useBrowserRecommendedResolution = true
  if (isHero) {
    viewer.resolutionScale = HERO_RESOLUTION_SCALE
  }

  const scene = viewer.scene
  if (isHero) {
    scene.backgroundColor = Cesium.Color.TRANSPARENT
    scene.fog.enabled = false
    if (scene.skyBox) scene.skyBox.show = false
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = false
    if (scene.sun) scene.sun.show = false
    if (scene.moon) scene.moon.show = false
    scene.globe.enableLighting = false
    scene.globe.showGroundAtmosphere = false
  } else {
    scene.globe.enableLighting = true
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = true
    scene.fog.enabled = true
  }
}

/**
 * Imagery:
 * - App: prefer Cesium ion if a token is present.
 * - Hero: always Esri (keeps ion branding/attributions off the landing page).
 * Failures are swallowed: the globe simply stays untextured.
 */
export async function loadBaseImagery(
  Cesium: CesiumModule,
  useIonImagery: boolean,
  isCancelled: () => boolean,
  getViewer: () => CesiumViewer | null
): Promise<void> {
  try {
    const provider = useIonImagery
      ? await Cesium.createWorldImageryAsync()
      : await Cesium.ArcGisMapServerImageryProvider.fromUrl(ESRI_WORLD_IMAGERY_URL)
    if (isCancelled()) return
    const liveViewer = getViewer()
    if (!liveViewer) return
    liveViewer.imageryLayers.removeAll()
    liveViewer.imageryLayers.addImageryProvider(provider)
    liveViewer.scene.requestRender()
  } catch {
    // If imagery fails to load, keep the globe untextured.
  }
}

/** Resolves once the globe reports zero pending tiles, or after TILE_LOAD_TIMEOUT_MS. Never rejects. */
export function waitForGlobeTiles(liveViewer: CesiumViewer | null): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!liveViewer) {
      resolve()
      return
    }

    const globe = liveViewer.scene.globe
    let done = false
    let tileTimeout = 0
    let checkRaf: number | null = null

    const finish = () => {
      if (done) return
      done = true
      try {
        globe.tileLoadProgressEvent.removeEventListener(onTileProgress)
      } catch {
        // ignore
      }
      window.clearTimeout(tileTimeout)
      if (checkRaf !== null) {
        window.cancelAnimationFrame(checkRaf)
        checkRaf = null
      }
      resolve()
    }

    const onTileProgress = (remainingTiles: number) => {
      if (remainingTiles === 0) {
        finish()
      }
    }

    try {
      globe.tileLoadProgressEvent.addEventListener(onTileProgress)
    } catch {
      resolve()
      return
    }

    tileTimeout = window.setTimeout(finish, TILE_LOAD_TIMEOUT_MS)

    checkRaf = window.requestAnimationFrame(() => {
      checkRaf = null
      if (globe.tilesLoaded) {
        finish()
        return
      }
      try {
        liveViewer.scene.requestRender()
      } catch {
        finish()
      }
    })
  })
}

/** Keeps the Cesium canvas sized to its container. Returns the observer for later disconnect. */
export function observeViewerResize(viewer: CesiumViewer, el: HTMLElement): ResizeObserver {
  const ro = new ResizeObserver(() => {
    try {
      viewer.resize()
      viewer.scene.requestRender()
    } catch {
      // ignore
    }
  })
  try {
    ro.observe(el)
  } catch {
    // ignore
  }
  return ro
}

/** Resolves on the next animation frame; the pending id is reported via `onScheduled` for cancellation. */
export function nextAnimationFrame(onScheduled: (id: number | null) => void): Promise<void> {
  return new Promise<void>((resolve) => {
    onScheduled(
      window.requestAnimationFrame(() => {
        onScheduled(null)
        resolve()
      })
    )
  })
}

/** Resolves after `ms`; the pending timer id is reported via `onScheduled` for cancellation. */
export function delay(ms: number, onScheduled: (id: number | null) => void): Promise<void> {
  return new Promise<void>((resolve) => {
    onScheduled(
      window.setTimeout(() => {
        onScheduled(null)
        resolve()
      }, ms)
    )
  })
}
