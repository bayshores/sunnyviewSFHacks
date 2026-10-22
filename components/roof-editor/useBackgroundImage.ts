"use client"

import { useEffect, useState } from "react"

const IMAGE_LOAD_ERROR = "Satellite image failed to load. Check API/network and try again."

type LoadResult = { src: string; image: HTMLImageElement | null; error: string | null }

export type BackgroundImageState = {
  /** Most recently loaded image (kept while a new src loads), or null without a src. */
  image: HTMLImageElement | null
  /** Load error for the current src, if any. */
  error: string | null
}

export function useBackgroundImage(src: string | null): BackgroundImageState {
  const [result, setResult] = useState<LoadResult | null>(null)

  useEffect(() => {
    if (!src) return

    let cancelled = false
    const img = new Image()
    img.onload = () => {
      if (cancelled) return
      setResult({ src, image: img, error: null })
    }
    img.onerror = () => {
      if (cancelled) return
      setResult({ src, image: null, error: IMAGE_LOAD_ERROR })
      console.error("[roof-canvas] satellite image failed", { src })
    }
    img.src = src

    return () => {
      cancelled = true
    }
  }, [src])

  return {
    image: src ? (result?.image ?? null) : null,
    error: src && result?.src === src ? result.error : null,
  }
}
