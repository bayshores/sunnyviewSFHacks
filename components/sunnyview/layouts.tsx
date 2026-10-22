"use client";

import type { ReactNode } from "react";
import { HeroSection } from "@/components/hero-section";
import { cn } from "@/lib/utils";
import type { MobilePane } from "./types";

const HIDDEN_SCROLL_COLUMN =
  "absolute inset-0 h-full min-h-0 overflow-x-hidden overflow-y-auto pr-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden";
const EASE_TRANSITION = "ease-[cubic-bezier(0.2,0.85,0.2,1)] motion-reduce:duration-0";

type LayoutBaseProps = {
  opened: boolean;
  entered: boolean;
  panelsMounted: boolean;
  onStart: () => void;
  setupPanel: ReactNode;
  resultsPanel: ReactNode;
};

export type DesktopLayoutProps = LayoutBaseProps & {
  opening: boolean;
};

/** Desktop: hero/setup in the left column, globe in the middle, results on the right. */
export function DesktopLayout(props: DesktopLayoutProps) {
  const { opened, opening, entered, panelsMounted } = props;
  return (
    <div
      className={cn(
        "grid h-full min-h-0 grid-cols-1 gap-3",
        opened
          ? "lg:grid-cols-[minmax(330px,420px)_minmax(0,1fr)_minmax(330px,420px)] xl:grid-cols-[minmax(350px,440px)_minmax(0,1fr)_minmax(350px,440px)]"
          : "lg:grid-cols-[minmax(320px,460px)_minmax(0,1fr)] xl:grid-cols-[minmax(340px,480px)_minmax(0,1fr)]",
      )}
    >
      <aside className={`pointer-events-auto relative min-h-0 transition-[opacity,transform] duration-[800ms] ${EASE_TRANSITION}`}>
        <div className={HIDDEN_SCROLL_COLUMN}>
          <div
            className={cn(
              `transition-[opacity,transform] ${EASE_TRANSITION}`,
              entered && !opened
                ? "translate-x-0 opacity-100 duration-[900ms]"
                : "pointer-events-none -translate-x-8 opacity-0 duration-[220ms]",
            )}
          >
            <HeroSection
              onStart={props.onStart}
              visible={entered && !opened}
            />
          </div>
        </div>

        <div
          className={cn(
            HIDDEN_SCROLL_COLUMN,
            `transition-[opacity,transform] duration-[900ms] ${EASE_TRANSITION}`,
            opened
              ? opening
                ? "translate-x-0 opacity-100 delay-[90ms]"
                : "translate-x-0 opacity-100 delay-0"
              : "pointer-events-none -translate-x-10 opacity-0 delay-0",
          )}
        >
          {panelsMounted ? props.setupPanel : null}
        </div>
      </aside>

      <div className="hidden min-h-0 lg:block" />

      {opened ? (
        <aside className={`pointer-events-auto min-h-0 transition-[opacity,transform] duration-[800ms] ${EASE_TRANSITION}`}>
          <div className="h-full min-h-0 overflow-x-hidden overflow-y-auto pl-1">
            <div
              className={cn(
                `transition-[opacity,transform] duration-[900ms] ${EASE_TRANSITION}`,
                opening
                  ? "translate-x-0 opacity-100 delay-[130ms]"
                  : "translate-x-0 opacity-100 delay-0",
              )}
            >
              {panelsMounted ? props.resultsPanel : null}
            </div>
          </div>
        </aside>
      ) : null}
    </div>
  );
}

export type MobileLayoutProps = LayoutBaseProps & {
  mobilePane: MobilePane;
  onMobilePaneChange: (pane: MobilePane) => void;
};

function PaneTab(props: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={cn(
        "rounded-full px-3 py-1.5 text-xs font-medium transition",
        props.active
          ? "bg-primary/18 text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {props.children}
    </button>
  );
}

/** Mobile: hero until opened, then a bottom sheet with Setup / Results tabs. */
export function MobileLayout(props: MobileLayoutProps) {
  const { opened, entered, panelsMounted, mobilePane, onMobilePaneChange } = props;
  return (
    <div className="relative h-full pt-14">
      <div
        className={cn(
          "pointer-events-auto h-full overflow-auto pr-1 transition-opacity duration-500 motion-reduce:duration-0",
          opened ? "pointer-events-none opacity-0" : "opacity-100",
        )}
      >
        <HeroSection onStart={props.onStart} visible={entered && !opened} />
      </div>

      {opened ? (
        <div className={`pointer-events-auto absolute inset-x-0 bottom-0 z-20 transition-[transform,opacity] duration-500 ${EASE_TRANSITION}`}>
          <div className="glass-card mx-1 mb-2 overflow-hidden rounded-2xl">
            <div className="flex items-center gap-2 border-b border-border/60 p-2">
              <PaneTab active={mobilePane === "setup"} onClick={() => onMobilePaneChange("setup")}>
                Setup
              </PaneTab>
              <PaneTab active={mobilePane === "results"} onClick={() => onMobilePaneChange("results")}>
                Results
              </PaneTab>
            </div>

            <div className="max-h-[68vh] overflow-auto p-3">
              {panelsMounted
                ? mobilePane === "setup"
                  ? props.setupPanel
                  : props.resultsPanel
                : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
