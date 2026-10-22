"use client";

import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { gsap } from "gsap";
import { prefersReducedMotion } from "./use-app-shell";

/** Plays the one-time GSAP drop-in of the top chrome pill once startup finishes. */
export function useTopChromeIntro(opts: {
  opened: boolean;
  settingsOpen: boolean;
  startupDone: boolean;
}): RefObject<HTMLDivElement | null> {
  const { opened, settingsOpen, startupDone } = opts;
  const topChromeRef = useRef<HTMLDivElement | null>(null);
  const topIntroPlayedRef = useRef(false);

  useEffect(() => {
    if (!startupDone || settingsOpen || topIntroPlayedRef.current) return;

    if (prefersReducedMotion()) {
      topIntroPlayedRef.current = true;
      return;
    }

    const tl = gsap.timeline({ defaults: { ease: "power2.out" } });

    if (topChromeRef.current) {
      tl.fromTo(
        topChromeRef.current,
        { y: -14, opacity: 0, scale: 0.985 },
        { y: 0, opacity: 1, scale: 1, duration: 0.46 },
        0,
      );
    }

    topIntroPlayedRef.current = true;

    return () => {
      tl.kill();
    };
  }, [opened, settingsOpen, startupDone]);

  return topChromeRef;
}
