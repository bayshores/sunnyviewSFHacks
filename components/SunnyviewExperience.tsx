"use client";

import { useCallback, useMemo } from "react";
import { HistorySheet } from "@/components/history-sheet";
import { GlobeStage } from "@/components/GlobeStage";
import type { Point } from "@/components/PanelPacking";
import { BackgroundScene } from "@/components/BackgroundScene";
import { useIsMobile } from "@/hooks/use-mobile";
import type { HistorySnapshot } from "@/lib/history-types";
import { cn } from "@/lib/utils";
import { INITIAL_ESTIMATE } from "@/components/sunnyview/estimate";
import { historySaveSignature, historySummaryFromSnapshot } from "@/components/sunnyview/history";
import { apiRequestsAreSameOrigin } from "@/components/sunnyview/local-keys";
import { DesktopLayout, MobileLayout } from "@/components/sunnyview/layouts";
import { DashboardScrims, SettingsOverlay, StartupLoader } from "@/components/sunnyview/overlays";
import { ResultsPanel } from "@/components/sunnyview/ResultsPanel";
import { SetupPanel } from "@/components/sunnyview/SetupPanel";
import { ShareDialog } from "@/components/sunnyview/ShareDialog";
import { TopChrome } from "@/components/sunnyview/TopChrome";
import { useAppShell } from "@/components/sunnyview/use-app-shell";
import { useExplainAndTalk } from "@/components/sunnyview/use-explain-and-talk";
import { useHistoryAutosave } from "@/components/sunnyview/use-history-autosave";
import { usePackingAndEstimate } from "@/components/sunnyview/use-packing-and-estimate";
import { usePanelSelection } from "@/components/sunnyview/use-panel-selection";
import { useProjectSync } from "@/components/sunnyview/use-project-sync";
import { useRoofLayout } from "@/components/sunnyview/use-roof-layout";
import { useRoofOutline } from "@/components/sunnyview/use-roof-outline";
import { useSiteInput } from "@/components/sunnyview/use-site-input";
import { useTopChromeIntro } from "@/components/sunnyview/use-top-chrome-intro";

export function SunnyviewExperience() {
  const isMobile = useIsMobile();
  const shell = useAppShell();
  const { opened, panelsMounted, settingsOpen, startupDone, setActionNotice } = shell;
  const topChromeRef = useTopChromeIntro({ opened, settingsOpen, startupDone });

  const site = useSiteInput({ panelsMounted, globeInteractive: shell.globeInteractive });
  const { mapInput, lat, lng, zoom, tiltDeg, azimuthDeg, lossesPct, mPerPx, addressStatic } = site;

  const layout = useRoofLayout({ mPerPx });
  const { panelSpec, panelSpecMode, orientationDeg, vertices, closed, estimate } = layout;
  const { panelCount, dcKw, roofAreaM2 } = layout;

  const lastHistorySigRef = useHistoryAutosave({
    panelsMounted,
    opened,
    mapKind: mapInput.kind,
    address: mapInput.address,
    lat,
    lng,
    zoom,
    mPerPx,
    tiltDeg,
    azimuthDeg,
    lossesPct,
    panelSpec,
    orientationDeg,
    panelCount,
    dcKw,
    vertices,
    closed,
    estimate,
  });

  const selection = usePanelSelection({
    panelsMounted,
    mapInput,
    lat,
    lng,
    closed,
    vertices,
    mPerPx,
    roofAreaM2,
    orientationDeg,
    roofAxisHintDeg: layout.roofAxisHintDeg,
    panelSpec,
    panelSpecMode,
    panelChoiceId: layout.panelChoiceId,
    setPanelSpec: layout.setPanelSpec,
    setPanelSpecMode: layout.setPanelSpecMode,
    setPanelChoiceId: layout.setPanelChoiceId,
    setOrientationDeg: layout.setOrientationDeg,
    setActionNotice,
  });
  const { resetAutoPick } = selection;

  usePackingAndEstimate({
    panelsMounted,
    closed,
    vertices,
    mPerPx,
    roofAreaM2,
    panelSpec,
    panelSpecMode,
    panelAutoReadyKey: selection.panelAutoReadyKey,
    orientationDeg,
    lat,
    lng,
    tiltDeg,
    azimuthDeg,
    lossesPct,
    dcKw,
    panelCount,
    setPanelsPacked: layout.setPanelsPacked,
    setEstimate: layout.setEstimate,
  });

  const outline = useRoofOutline({
    panelsMounted,
    mapInput,
    addressStatic,
    mPerPx,
    panelSpec,
    setVertices: layout.setVertices,
    setClosed: layout.setClosed,
    setPanelsPacked: layout.setPanelsPacked,
    setPanelCountOverride: layout.setPanelCountOverride,
    setOrientationDeg: layout.setOrientationDeg,
    setAzimuthDeg: site.setAzimuthDeg,
    setRoofAxisHintDeg: layout.setRoofAxisHintDeg,
    clearRoof: layout.clearRoof,
    resetAutoPick,
  });

  const project = useProjectSync({
    panelsMounted,
    mapKind: mapInput.kind,
    lat,
    lng,
    zoom,
    tiltDeg,
    azimuthDeg,
    lossesPct,
    panelSpec,
    dcKw,
    panelCount,
    orientationDeg,
    vertices,
    closed,
    mPerPx,
    estimate,
    setActionNotice,
  });

  const talk = useExplainAndTalk({
    opened,
    estimate,
    lat,
    lng,
    tiltDeg,
    azimuthDeg,
    lossesPct,
    panelSpec,
    orientationDeg,
    panelCount,
    dcKw,
    setActionNotice,
  });

  const { applySnapshotSite, clearSiteInput } = site;
  const { applySnapshotLayout, clearRoof } = layout;
  const { abortOutline, clearOutline } = outline;
  const { enterAppWithNotice } = shell;

  const loadHistorySnapshot = useCallback(
    (snapshot: HistorySnapshot) => {
      if (snapshot.mode !== "address") return;
      abortOutline();
      applySnapshotSite(snapshot);
      applySnapshotLayout(snapshot);
      clearOutline("Loaded from history.", true);
      enterAppWithNotice("Loaded history snapshot.");
      lastHistorySigRef.current = historySaveSignature(snapshot, historySummaryFromSnapshot(snapshot));
    },
    [abortOutline, applySnapshotLayout, applySnapshotSite, clearOutline, enterAppWithNotice, lastHistorySigRef],
  );

  function clearSite() {
    abortOutline();
    lastHistorySigRef.current = null;
    clearSiteInput();
    clearRoof();
    clearOutline(null, true);
    shell.setMobilePane("setup");
  }

  function handleVerticesChange(v: Point[]) {
    layout.setVertices(v);
    layout.setPanelCountOverride(null);
    layout.setPanelsPacked([]);
    layout.setRoofAxisHintDeg(null);
    layout.setEstimate(INITIAL_ESTIMATE);
    resetAutoPick();
    clearOutline(null, false);
    if (v.length < 3) layout.setClosed(false);
  }

  const { shareSlug } = project;
  const shareUrl = useMemo(() => {
    if (!shareSlug) return null;
    if (typeof window === "undefined") return null;
    return `${window.location.origin}/s/${shareSlug}`;
  }, [shareSlug]);

  const shareDisabledReason = shareSlug ? null : (project.projectError ?? "Create a project to enable sharing.");
  // Local keys are only forwarded same-origin, so the hint only applies there.
  const showElevenLabsHint = talk.hasLocalElevenLabsKey === false && apiRequestsAreSameOrigin();

  const setupPanel = (
    <SetupPanel
      compact={isMobile === false}
      onClear={clearSite}
      mapInput={mapInput}
      onMapInputChange={site.setMapInput}
      lat={lat}
      setLat={site.setLat}
      lng={lng}
      setLng={site.setLng}
      tiltDeg={tiltDeg}
      setTiltDeg={site.setTiltDeg}
      azimuthDeg={azimuthDeg}
      setAzimuthDeg={site.setAzimuthDeg}
      lossesPct={lossesPct}
      setLossesPct={site.setLossesPct}
      background={site.background}
      mPerPx={mPerPx}
      orientationDeg={orientationDeg}
      setOrientationDeg={layout.setOrientationDeg}
      panelSpec={panelSpec}
      vertices={vertices}
      closed={closed}
      panels={layout.panels}
      onVerticesChange={handleVerticesChange}
      onClosedChange={layout.setClosed}
      onAutoOutline={(roi) => {
        void outline.runAutoOutline({ reason: "manual", roi });
      }}
      autoOutlineBusy={outline.autoOutlineBusy}
      autoOutlineError={outline.autoOutlineError}
      autoOutlineHint={outline.autoOutlineHint}
      candidatePolygons={outline.candidatePolygons}
      onPickCandidate={outline.pickCandidate}
      centerPin={addressStatic ? { x: addressStatic.widthPx / 2, y: addressStatic.heightPx / 2 } : null}
    />
  );

  const resultsPanel = (
    <ResultsPanel
      lat={lat}
      lng={lng}
      dcKw={dcKw}
      lossesPct={lossesPct}
      panelCount={panelCount}
      estimate={estimate}
      panelModel={{
        panelChoiceLabel: layout.panelChoiceLabel,
        panelSpecMode,
        panelBrandRec: selection.panelBrandRec,
        panelBrandBusy: selection.panelBrandBusy,
        panelBrandError: selection.panelBrandError,
        onToggleMode: selection.togglePanelSpecMode,
        onAskGemini: selection.askGemini,
      }}
      explainLoading={talk.explainLoading}
      explainText={talk.explainText}
      ttsLoading={talk.ttsLoading}
      onExplain={talk.runExplain}
      onTalk={talk.runTalk}
      onToggleShare={() => shell.setShowShare((s) => !s)}
      shareDisabledReason={shareDisabledReason}
      showElevenLabsHint={showElevenLabsHint}
      onAddElevenLabsKey={shell.returnToLanding}
      actionNotice={shell.actionNotice}
      panelCountAuto={layout.panelCountAuto}
      manualPanelCount={layout.manualPanelCount}
      panelCountOverride={layout.panelCountOverride}
      onManualPanelCount={layout.setManualPanelCount}
      onResetPanelCount={() => layout.setPanelCountOverride(null)}
    />
  );

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-background">
      <BackgroundScene mode={opened ? "grid" : "fusion"} transitionMs={900} />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(3,8,20,0.10)_0%,rgba(3,8,20,0.14)_42%,rgba(3,8,20,0.28)_100%)]" />

      <GlobeStage
        lat={lat}
        lng={lng}
        interactive={shell.globeInteractive}
        onPrimaryClick={opened || settingsOpen ? undefined : shell.openApp}
        onPickLocation={site.pickEnabled ? site.handlePickLocation : undefined}
        onReadyChange={shell.setGlobeBootReady}
        dim={opened && !settingsOpen}
        className={cn(
          "z-[2] transition-transform duration-[900ms] ease-[cubic-bezier(0.2,0.85,0.2,1)] motion-reduce:duration-0",
          !opened && !settingsOpen
            ? "lg:translate-x-[7vw] lg:scale-[1.06] xl:translate-x-[9vw]"
            : "translate-x-0 scale-100",
        )}
      />

      {startupDone && !settingsOpen && <DashboardScrims opened={opened} />}

      {startupDone && !settingsOpen && (
        <TopChrome
          chromeRef={topChromeRef}
          phase={shell.phase}
          historyOpen={shell.historyOpen}
          onBackToLanding={shell.returnToLanding}
          onOpenHistory={() => {
            shell.setShowShare(false);
            shell.setHistoryOpen(true);
          }}
          onOpenSettings={() => {
            shell.setShowShare(false);
            shell.setHistoryOpen(false);
            shell.setSettingsOpen(true);
          }}
        />
      )}

      {startupDone && !settingsOpen && (
        <div className="pointer-events-none relative z-20 mx-auto h-full w-full max-w-[1820px] px-4 py-2 sm:px-6 sm:py-3 lg:px-10 lg:py-3 xl:px-14">
          {isMobile === null ? null : !isMobile ? (
            <DesktopLayout
              opened={opened}
              opening={shell.opening}
              entered={shell.entered}
              panelsMounted={panelsMounted}
              onStart={shell.openApp}
              setupPanel={setupPanel}
              resultsPanel={resultsPanel}
            />
          ) : (
            <MobileLayout
              opened={opened}
              entered={shell.entered}
              panelsMounted={panelsMounted}
              onStart={shell.openApp}
              mobilePane={shell.mobilePane}
              onMobilePaneChange={shell.setMobilePane}
              setupPanel={setupPanel}
              resultsPanel={resultsPanel}
            />
          )}
        </div>
      )}

      {!startupDone && <StartupLoader />}

      <HistorySheet
        open={shell.historyOpen}
        onOpenChange={shell.setHistoryOpen}
        onLoadSnapshot={loadHistorySnapshot}
        onNotice={setActionNotice}
      />

      {settingsOpen && <SettingsOverlay onClose={() => shell.setSettingsOpen(false)} />}

      {shell.showShare && (
        <ShareDialog shareUrl={shareUrl} shareSlug={shareSlug} onClose={() => shell.setShowShare(false)} />
      )}
    </div>
  );
}
