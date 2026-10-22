"use client"

import { useMemo, useRef } from "react"
import { SunnyviewLogoLoader } from "@/components/SunnyviewLogoLoader"
import { formatLocationLabel, hasFiniteLocation } from "@/components/globe/math"
import { useCameraActions } from "@/components/globe/useCameraActions"
import { useCesiumViewer } from "@/components/globe/useCesiumViewer"
import { useGlobeHandles } from "@/components/globe/useGlobeHandles"
import { useGlobeInteraction } from "@/components/globe/useGlobeInteraction"
import { useLandingOrbit } from "@/components/globe/useLandingOrbit"
import { useLandingSpin } from "@/components/globe/useLandingSpin"
import { useSiteMarker } from "@/components/globe/useSiteMarker"
import { useAccent } from "@/lib/accent-context"
import { cn } from "@/lib/utils"

export function GlobeView({
  lat,
  lng,
  className,
  showUi = true,
  interactive = true,
  onPrimaryClick,
  onPickLocation,
  frame = true,
  variant = "app",
  onReadyChange,
}: {
  lat: number | null
  lng: number | null
  className?: string
  showUi?: boolean
  interactive?: boolean
  onPrimaryClick?: () => void
  onPickLocation?: (p: { lat: number; lng: number }) => void
  frame?: boolean
  variant?: "app" | "hero"
  onReadyChange?: (ready: boolean) => void
}) {
  const isHero = variant === "hero"
  const { hue, saturation } = useAccent()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const {
    viewerRef,
    cesiumRef,
    markerEntityRef,
    pickHandlerRef,
    clickSpinRafRef,
    landingSpinRafRef,
    landingSpinLastNowRef,
    orbitRef,
    clearLandingOrbit,
    destroyPickHandler,
    cancelLandingSpin,
    teardownBeforeDestroy,
  } = useGlobeHandles()

  // Hook order matters: effects run in declaration order (viewer boot first, auto fly-to last).
  const { ready, error } = useCesiumViewer({
    containerRef,
    viewerRef,
    cesiumRef,
    isHero,
    onReadyChange,
    onNanRenderError: clearLandingOrbit,
    onBeforeDestroy: teardownBeforeDestroy,
  })

  const showLoader = !ready
  const landingActive = !interactive && Boolean(onPrimaryClick)
  const hasLocation = hasFiniteLocation(lat, lng)
  const locationLabel = useMemo(() => formatLocationLabel(lat, lng), [lat, lng])

  useGlobeInteraction({ ready, interactive, onPickLocation, viewerRef, cesiumRef, pickHandlerRef, destroyPickHandler })
  useLandingSpin({ ready, isHero, landingActive, viewerRef, landingSpinRafRef, landingSpinLastNowRef, cancelLandingSpin })
  useLandingOrbit({
    ready,
    isHero,
    landingActive,
    hue,
    saturation,
    viewerRef,
    cesiumRef,
    orbitRef,
    clearLandingOrbit,
  })
  useSiteMarker({ ready, hasLocation, lat, lng, viewerRef, markerEntityRef })
  const { flyTo, centerAndSpin } = useCameraActions({
    ready,
    interactive,
    hasLocation,
    lat,
    lng,
    viewerRef,
    clickSpinRafRef,
    cancelLandingSpin,
  })

  return (
    <div
      className={cn(
        "relative h-full w-full overflow-hidden",
        isHero && "globe-hero",
        frame && "rounded-xl border border-border bg-card",
        className
      )}
    >
      {showLoader && !error && (
        <div
          className={cn(
            "absolute inset-0 z-10 grid place-items-center overflow-hidden",
            isHero ? "bg-transparent" : "bg-gradient-to-b from-black/10 via-black/20 to-black/40"
          )}
        >
          {isHero ? (
            <div className="absolute inset-0 bg-black" aria-hidden />
          ) : null}

          <SunnyviewLogoLoader className="relative z-[1]" />
        </div>
      )}

      {showUi && (
        <div className="absolute left-3 top-3 z-20 rounded-md border border-border/70 bg-background/70 px-3 py-2 text-xs text-muted-foreground backdrop-blur">
          <div className="font-medium text-foreground">3D Earth</div>
          <div className="mt-0.5">{locationLabel}</div>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={flyTo}
              disabled={!hasLocation}
              className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              Fly to location
            </button>
            <div className="text-[11px] text-muted-foreground">
              {variant !== "hero" && process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN?.trim()
                ? "Cesium ion imagery"
                : "Esri World Imagery"}
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="absolute inset-0 z-30 grid place-items-center p-6 text-center">
          <div className="rounded-lg border border-border bg-background/80 p-4 text-sm text-muted-foreground backdrop-blur">
            <div className="font-medium text-foreground">Globe failed to load</div>
            <div className="mt-1">{error}</div>
          </div>
        </div>
      )}

      {onPrimaryClick && !interactive && !error && (
        <button
          type="button"
          aria-label="Start"
          className="absolute inset-0 z-30 cursor-pointer bg-transparent"
          onClick={() => {
            void centerAndSpin()
            onPrimaryClick()
          }}
        />
      )}

      <div
        ref={containerRef}
        className={`absolute inset-0 transition-opacity duration-700 motion-reduce:duration-0 ${ready && !error ? "opacity-100" : "opacity-0"}`}
      />
    </div>
  )
}
