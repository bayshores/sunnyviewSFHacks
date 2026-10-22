"use client";

import { SettingsPage } from "@/components/settings-page";
import { SunnyviewLogoLoader } from "@/components/SunnyviewLogoLoader";
import { cn } from "@/lib/utils";

/** Side/bottom gradient scrims behind the dashboard columns. */
export function DashboardScrims({ opened }: { opened: boolean }) {
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-0 z-[3] transition-opacity duration-700 motion-reduce:duration-0",
        opened ? "opacity-100" : "opacity-0",
      )}
    >
      <div className="dashboard-scrim dashboard-scrim-left absolute inset-y-0 left-0 hidden w-[34vw] lg:block" />
      <div className="dashboard-scrim dashboard-scrim-right absolute inset-y-0 right-0 hidden w-[28vw] lg:block" />
      <div className="dashboard-scrim dashboard-scrim-bottom absolute inset-x-0 bottom-0 h-[24vh] lg:hidden" />
    </div>
  );
}

/** Full-screen logo loader shown until the startup minimum elapses and the globe is ready. */
export function StartupLoader() {
  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-background">
      <div
        aria-hidden
        className="absolute inset-0 bg-[radial-gradient(120%_85%_at_50%_38%,rgba(11,20,40,0.85)_0%,rgba(6,10,22,0.92)_42%,rgba(0,0,0,0.98)_100%)]"
      />
      <SunnyviewLogoLoader className="relative z-[1]" />
    </div>
  );
}

/** Embedded settings page over a dimmed backdrop (click backdrop or Escape to close). */
export function SettingsOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="absolute inset-0 z-40">
      <button
        type="button"
        aria-label="Close settings"
        onClick={onClose}
        className="absolute inset-0 bg-black/35 backdrop-blur-[1px]"
      />
      <div className="relative z-10 flex h-full items-start justify-center overflow-auto px-2 py-6 sm:px-4 sm:py-8">
        <SettingsPage embedded onClose={onClose} />
      </div>
    </div>
  );
}
