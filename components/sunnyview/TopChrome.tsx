"use client";

import type { RefObject } from "react";
import { ArrowLeft, History, Settings2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Phase } from "./types";

export type TopChromeProps = {
  chromeRef: RefObject<HTMLDivElement | null>;
  phase: Phase;
  historyOpen: boolean;
  onBackToLanding: () => void;
  onOpenHistory: () => void;
  onOpenSettings: () => void;
};

/** Floating pill with the brand mark, "Back to landing", History, and Settings. */
export function TopChrome({
  chromeRef,
  phase,
  historyOpen,
  onBackToLanding,
  onOpenHistory,
  onOpenSettings,
}: TopChromeProps) {
  return (
    <div ref={chromeRef} className="pointer-events-none absolute inset-x-0 top-3 z-30 flex justify-center px-3 sm:top-4">
      <div className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-2 rounded-full border border-border/55 bg-background/25 p-1.5 shadow-[0_12px_28px_-20px_rgba(0,0,0,0.95)] backdrop-blur-md">
        <div className="inline-flex items-center gap-2 rounded-full border border-primary/45 bg-primary/12 px-3 py-1.5 shadow-[0_10px_30px_-22px_rgba(0,0,0,0.95)]">
          <span className="text-[10px] font-semibold tracking-[0.24em] text-foreground uppercase">
            Sunnyview
          </span>
        </div>

        {phase === "app" && (
          <button
            type="button"
            onClick={onBackToLanding}
            className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-background/45 px-3.5 py-1.5 text-xs font-medium text-foreground transition hover:bg-background/65"
          >
            <ArrowLeft size={14} />
            Back to landing
          </button>
        )}

        <button
          type="button"
          onClick={onOpenHistory}
          className={cn(
            "inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-xs font-semibold text-foreground shadow-[0_12px_28px_-16px_rgba(0,0,0,0.95)] backdrop-blur-sm transition",
            historyOpen
              ? "border-primary/70 bg-primary/26"
              : "border-primary/60 bg-primary/14 hover:bg-primary/22",
          )}
        >
          <History size={14} />
          History
        </button>

        <button
          type="button"
          onClick={onOpenSettings}
          className="inline-flex items-center gap-2 rounded-full border border-primary/65 bg-primary/18 px-4 py-1.5 text-xs font-semibold text-foreground shadow-[0_12px_28px_-16px_rgba(0,0,0,0.95)] backdrop-blur-sm transition hover:bg-primary/28"
        >
          <Settings2 size={14} />
          Settings
        </button>
      </div>
    </div>
  );
}
