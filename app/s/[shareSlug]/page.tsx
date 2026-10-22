"use client"

import dynamic from "next/dynamic"
import { useParams } from "next/navigation"
import { useEffect, useMemo, useState } from "react"
import { GlobeView } from "@/components/GlobeView"
import { RoofCanvas } from "@/components/RoofCanvas"
import type { PanelSpec } from "@/components/PanelPacking"
import { packPanelsDeterministic } from "@/components/PanelPacking"
import { resolveSharedLayout } from "@/components/sunnyview/project-payload"
import { getSharedProject, ProjectsApiError } from "@/lib/projects-api"
import type { SharedProject } from "@/lib/projects-types"
import { fallbackAnnualEstimate } from "@/lib/solar-defaults"
import { buildStaticMapSpec } from "@/lib/static-map"

const Globe = dynamic(() => Promise.resolve(GlobeView), { ssr: false })

export default function SharePage() {
  const params = useParams<{ shareSlug: string }>()
  const shareSlug = String(params?.shareSlug ?? "")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [snapshot, setSnapshot] = useState<SharedProject | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setError(null)
      setNotFound(false)
      try {
        const project = await getSharedProject(shareSlug)
        if (cancelled) return
        setSnapshot(project)
      } catch (e) {
        if (cancelled) return
        if (e instanceof ProjectsApiError && e.status === 404) setNotFound(true)
        else setError(e instanceof Error ? e.message : "Failed to load share snapshot.")
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [shareSlug])

  const lat = snapshot?.siteSpec?.lat ?? null
  const lng = snapshot?.siteSpec?.lng ?? null
  const orientationDeg = snapshot?.layoutSummary?.orientationDeg ?? 0

  const panelSpec: PanelSpec = useMemo(
    () => ({
      widthM: snapshot?.panelSpec?.widthM ?? 1.1,
      heightM: snapshot?.panelSpec?.heightM ?? 1.7,
      wattW: snapshot?.panelSpec?.wattW ?? 400,
      gapM: snapshot?.panelSpec?.gapM ?? 0.02,
    }),
    [snapshot]
  )

  const vertices = useMemo(() => snapshot?.geometry?.vertices ?? [], [snapshot])
  const closed = snapshot?.geometry?.closed ?? true
  const mPerPx = snapshot?.geometry?.mPerPx ?? null
  const zoom = snapshot?.geometry?.zoom ?? 19

  const background = useMemo(() => {
    if (snapshot?.geometry?.background === "address" && lat !== null && lng !== null) {
      const spec = buildStaticMapSpec({ lat, lng, zoom })
      return { kind: "image" as const, src: spec.src, widthPx: spec.widthPx, heightPx: spec.heightPx }
    }
    return { kind: "none" as const }
  }, [lat, lng, snapshot?.geometry?.background, zoom])

  const packedPanels = useMemo(() => {
    if (!closed || vertices.length < 3 || !mPerPx) return []
    return packPanelsDeterministic({
      usablePolygon: vertices,
      mPerPx,
      panel: { widthM: panelSpec.widthM, heightM: panelSpec.heightM, gapM: panelSpec.gapM },
      orientationDeg,
    })
  }, [closed, vertices, mPerPx, panelSpec.widthM, panelSpec.heightM, panelSpec.gapM, orientationDeg])

  // Honor a manually reduced panel count / saved dcKw from the shared layoutSummary.
  const layout = useMemo(
    () => resolveSharedLayout(packedPanels, snapshot?.layoutSummary, panelSpec.wattW),
    [packedPanels, snapshot?.layoutSummary, panelSpec.wattW]
  )
  const { panels, panelCount, dcKw } = layout
  const fallback = fallbackAnnualEstimate(dcKw)
  const annualKwh = snapshot?.estimate?.annualKwh ?? fallback.annualKwh
  const annualCo2Kg = snapshot?.estimate?.annualCo2Kg ?? fallback.annualCo2Kg

  return (
    <div className="flex min-h-screen w-screen flex-col bg-background">
      <header className="flex h-14 items-center justify-between border-b border-border/50 bg-background/80 px-5 backdrop-blur">
        <div className="text-sm font-semibold text-foreground">sunnyview</div>
        <div className="text-xs text-muted-foreground">Share: /s/{shareSlug}</div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 p-5">
        {loading && <div className="text-sm text-muted-foreground">Loading…</div>}
        {notFound && (
          <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
            <div className="font-medium text-foreground">Shared project not found</div>
            <div className="mt-1">This link may be incorrect or the project may no longer be available.</div>
          </div>
        )}
        {error && (
          <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
            <div className="font-medium text-foreground">Couldn’t load share snapshot</div>
            <div className="mt-1">{error}</div>
          </div>
        )}

        {!loading && !error && !notFound && (
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-4">
              <div className="grid gap-3 md:grid-cols-3">
                <div className="rounded-lg border border-border bg-card p-3">
                  <div className="text-xs text-muted-foreground">Panels</div>
                  <div className="mt-1 text-lg font-semibold text-foreground">{panelCount}</div>
                </div>
                <div className="rounded-lg border border-border bg-card p-3">
                  <div className="text-xs text-muted-foreground">DC kW</div>
                  <div className="mt-1 text-lg font-semibold text-foreground">{dcKw.toFixed(1)}</div>
                </div>
                <div className="rounded-lg border border-border bg-card p-3">
                  <div className="text-xs text-muted-foreground">Annual kWh</div>
                  <div className="mt-1 text-lg font-semibold text-foreground">{Math.round(annualKwh).toLocaleString()}</div>
                </div>
                <div className="rounded-lg border border-border bg-card p-3 md:col-span-2">
                  <div className="text-xs text-muted-foreground">Annual CO₂ (kg)</div>
                  <div className="mt-1 text-lg font-semibold text-foreground">
                    {Math.round(annualCo2Kg).toLocaleString()}
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-card p-3">
                  <div className="text-xs text-muted-foreground">Location</div>
                  <div className="mt-1 text-sm text-foreground">
                    {lat !== null && lng !== null ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : "—"}
                  </div>
                </div>
              </div>

              <RoofCanvas
                background={background}
                mPerPx={mPerPx}
                orientationDeg={orientationDeg}
                panelSpec={panelSpec}
                vertices={vertices}
                closed={closed}
                panels={panels}
                mode="view"
              />
            </div>

            <div className="h-[620px]">
              <Globe lat={lat} lng={lng} className="h-full" />
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
