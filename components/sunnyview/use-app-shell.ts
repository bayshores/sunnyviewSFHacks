"use client";

import { useCallback, useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { MobilePane, Phase } from "./types";

export function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
}

export type AppShell = {
  phase: Phase;
  opened: boolean;
  opening: boolean;
  entered: boolean;
  startupDone: boolean;
  globeInteractive: boolean;
  setGlobeBootReady: Dispatch<SetStateAction<boolean>>;
  settingsOpen: boolean;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  panelsMounted: boolean;
  mobilePane: MobilePane;
  setMobilePane: Dispatch<SetStateAction<MobilePane>>;
  historyOpen: boolean;
  setHistoryOpen: Dispatch<SetStateAction<boolean>>;
  showShare: boolean;
  setShowShare: Dispatch<SetStateAction<boolean>>;
  actionNotice: string | null;
  setActionNotice: Dispatch<SetStateAction<string | null>>;
  openApp: () => void;
  returnToLanding: () => void;
  enterAppWithNotice: (notice: string) => void;
};

/**
 * Landing -> opening -> app state machine, startup loader gating, `?view=app` deep link,
 * and the top-level overlay/pane UI state.
 */
export function useAppShell(): AppShell {
  const [phase, setPhase] = useState<Phase>("landing");
  const [entered, setEntered] = useState(false);
  const [startupMinElapsed, setStartupMinElapsed] = useState(false);
  const [globeBootReady, setGlobeBootReady] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [panelsMounted, setPanelsMounted] = useState(false);
  const [mobilePane, setMobilePane] = useState<MobilePane>("setup");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const opened = phase !== "landing";
  const opening = phase === "opening";
  const globeInteractive = phase === "app" && !settingsOpen;
  const startupDone = startupMinElapsed && globeBootReady;

  useEffect(() => {
    const t = window.setTimeout(() => setStartupMinElapsed(true), prefersReducedMotion() ? 0 : 1050);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!startupDone) return;
    const t = window.setTimeout(() => setEntered(true), 30);
    return () => window.clearTimeout(t);
  }, [startupDone]);

  useEffect(() => {
    if (!settingsOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSettingsOpen(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [settingsOpen]);

  useEffect(() => {
    if (phase !== "landing") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("view") !== "app") return;

    // Deep link reads window.location, so it must run after hydration (not in initial state).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPanelsMounted(true);
    setEntered(true);
    setPhase("app");

    params.delete("view");
    const nextQuery = params.toString();
    const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}${window.location.hash}`;
    window.history.replaceState(window.history.state, "", nextUrl);
  }, [phase]);

  function openApp() {
    if (phase !== "landing") return;
    const reduceMotion = prefersReducedMotion();
    setPhase("opening");
    window.setTimeout(() => setPanelsMounted(true), reduceMotion ? 0 : 90);
    window.setTimeout(() => setPhase("app"), reduceMotion ? 0 : 380);
  }

  function returnToLanding() {
    setShowShare(false);
    setSettingsOpen(false);
    setActionNotice(null);
    setPhase("landing");
  }

  /** Jump straight into the app (used when loading a history snapshot). */
  const enterAppWithNotice = useCallback((notice: string) => {
    setSettingsOpen(false);
    setShowShare(false);
    setHistoryOpen(false);
    setActionNotice(notice);
    setMobilePane("setup");

    setPanelsMounted(true);
    setEntered(true);
    setPhase("app");
  }, []);

  return {
    phase,
    opened,
    opening,
    entered,
    startupDone,
    globeInteractive,
    setGlobeBootReady,
    settingsOpen,
    setSettingsOpen,
    panelsMounted,
    mobilePane,
    setMobilePane,
    historyOpen,
    setHistoryOpen,
    showShare,
    setShowShare,
    actionNotice,
    setActionNotice,
    openApp,
    returnToLanding,
    enterAppWithNotice,
  };
}
