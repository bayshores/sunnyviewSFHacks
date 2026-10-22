// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gsap } from "gsap";
import { useTopChromeIntro } from "./use-top-chrome-intro";

const kill = vi.fn();
const fromTo = vi.fn();

vi.mock("gsap", () => ({ gsap: { timeline: vi.fn() } }));

function reducedMotion(matches: boolean) {
  window.matchMedia = vi.fn(() => ({ matches })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  kill.mockReset();
  fromTo.mockReset();
  vi.mocked(gsap.timeline).mockReset();
  vi.mocked(gsap.timeline).mockImplementation(() => ({ fromTo, kill }) as never);
  reducedMotion(false);
});
afterEach(cleanup);

type Props = { opened: boolean; settingsOpen: boolean; startupDone: boolean };
const READY: Props = { opened: true, settingsOpen: false, startupDone: true };

describe("useTopChromeIntro", () => {
  it("does not animate before startup finishes", () => {
    renderHook(() => useTopChromeIntro({ ...READY, startupDone: false }));
    expect(gsap.timeline).not.toHaveBeenCalled();
  });

  it("does not animate while settings are open", () => {
    renderHook(() => useTopChromeIntro({ ...READY, settingsOpen: true }));
    expect(gsap.timeline).not.toHaveBeenCalled();
  });

  it("skips the animation with reduced motion", () => {
    reducedMotion(true);
    renderHook(() => useTopChromeIntro(READY));
    expect(gsap.timeline).not.toHaveBeenCalled();
  });

  it("builds a timeline without tweening when the element is not attached", () => {
    renderHook(() => useTopChromeIntro(READY));
    expect(gsap.timeline).toHaveBeenCalledTimes(1);
    expect(fromTo).not.toHaveBeenCalled();
  });

  it("plays once only and kills the timeline on cleanup", () => {
    const { rerender, unmount } = renderHook((p: Props) => useTopChromeIntro(p), { initialProps: READY });
    rerender({ ...READY, opened: false });
    rerender({ ...READY, opened: true });
    expect(gsap.timeline).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalled();
    unmount();
  });

  it("drops the chrome in from above when the element is attached", () => {
    const el = document.createElement("div");
    const { result, rerender } = renderHook((p: Props) => useTopChromeIntro(p), {
      initialProps: { ...READY, startupDone: false },
    });
    result.current.current = el;
    rerender(READY);
    expect(fromTo).toHaveBeenCalledWith(
      el,
      { y: -14, opacity: 0, scale: 0.985 },
      { y: 0, opacity: 1, scale: 1, duration: 0.46 },
      0,
    );
  });
});
