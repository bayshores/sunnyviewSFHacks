// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prefersReducedMotion, useAppShell } from "./use-app-shell";

function mockReducedMotion(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches })),
  );
  window.matchMedia = globalThis.matchMedia;
}

beforeEach(() => {
  vi.useFakeTimers();
  mockReducedMotion(false);
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("prefersReducedMotion", () => {
  it("reads the media query", () => {
    mockReducedMotion(true);
    expect(prefersReducedMotion()).toBe(true);
    mockReducedMotion(false);
    expect(prefersReducedMotion()).toBe(false);
  });

  it("is false when matchMedia is unavailable", () => {
    // @ts-expect-error simulate an environment without matchMedia
    window.matchMedia = undefined;
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe("useAppShell startup", () => {
  it("needs both the 1050ms minimum and the globe boot before startupDone/entered", () => {
    const { result } = renderHook(() => useAppShell());
    act(() => result.current.setGlobeBootReady(true));
    act(() => {
      vi.advanceTimersByTime(1049);
    });
    expect(result.current.startupDone).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.startupDone).toBe(true);
    expect(result.current.entered).toBe(false);
    act(() => {
      vi.advanceTimersByTime(30);
    });
    expect(result.current.entered).toBe(true);
  });

  it("is not done when the globe never becomes ready", () => {
    const { result } = renderHook(() => useAppShell());
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current.startupDone).toBe(false);
  });

  it("skips the delay with reduced motion", () => {
    mockReducedMotion(true);
    const { result } = renderHook(() => useAppShell());
    act(() => result.current.setGlobeBootReady(true));
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(result.current.startupDone).toBe(true);
  });
});

describe("useAppShell phases", () => {
  it("openApp goes landing -> opening -> app with panels mounted at 90ms", () => {
    const { result } = renderHook(() => useAppShell());
    expect(result.current.phase).toBe("landing");
    expect(result.current.opened).toBe(false);

    act(() => result.current.openApp());
    expect(result.current.phase).toBe("opening");
    expect(result.current.opening).toBe(true);
    expect(result.current.opened).toBe(true);
    expect(result.current.panelsMounted).toBe(false);

    act(() => {
      vi.advanceTimersByTime(90);
    });
    expect(result.current.panelsMounted).toBe(true);
    expect(result.current.phase).toBe("opening");

    act(() => {
      vi.advanceTimersByTime(289);
    });
    expect(result.current.phase).toBe("opening");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.phase).toBe("app");
    expect(result.current.opening).toBe(false);
  });

  it("openApp is immediate with reduced motion", () => {
    mockReducedMotion(true);
    const { result } = renderHook(() => useAppShell());
    act(() => result.current.openApp());
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(result.current.phase).toBe("app");
    expect(result.current.panelsMounted).toBe(true);
  });

  it("openApp is a no-op outside the landing phase", () => {
    const { result } = renderHook(() => useAppShell());
    act(() => result.current.openApp());
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(result.current.phase).toBe("app");
    act(() => result.current.openApp());
    expect(result.current.phase).toBe("app");
  });

  it("globeInteractive requires the app phase and closed settings", () => {
    const { result } = renderHook(() => useAppShell());
    expect(result.current.globeInteractive).toBe(false);
    act(() => result.current.openApp());
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(result.current.globeInteractive).toBe(true);
    act(() => result.current.setSettingsOpen(true));
    expect(result.current.globeInteractive).toBe(false);
  });

  it("Escape closes settings and other keys do not", () => {
    const { result } = renderHook(() => useAppShell());
    act(() => result.current.setSettingsOpen(true));
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    });
    expect(result.current.settingsOpen).toBe(true);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(result.current.settingsOpen).toBe(false);
  });

  it("returnToLanding resets overlays, notice and phase", () => {
    const { result } = renderHook(() => useAppShell());
    act(() => result.current.enterAppWithNotice("hi"));
    act(() => {
      result.current.setShowShare(true);
      result.current.setSettingsOpen(true);
    });
    act(() => result.current.returnToLanding());
    expect(result.current).toMatchObject({
      phase: "landing",
      showShare: false,
      settingsOpen: false,
      actionNotice: null,
    });
  });

  it("enterAppWithNotice jumps straight into the app", () => {
    const { result } = renderHook(() => useAppShell());
    act(() => {
      result.current.setHistoryOpen(true);
      result.current.setMobilePane("results");
    });
    act(() => result.current.enterAppWithNotice("Loaded"));
    expect(result.current).toMatchObject({
      phase: "app",
      panelsMounted: true,
      entered: true,
      actionNotice: "Loaded",
      historyOpen: false,
      mobilePane: "setup",
    });
  });
});

describe("useAppShell ?view=app deep link", () => {
  it("opens the app and strips only the view param", () => {
    window.history.replaceState({ k: 1 }, "", "/plan?view=app&x=1#top");
    const { result } = renderHook(() => useAppShell());
    expect(result.current).toMatchObject({ phase: "app", panelsMounted: true, entered: true });
    expect(window.location.pathname + window.location.search + window.location.hash).toBe("/plan?x=1#top");
    expect(window.history.state).toEqual({ k: 1 });
  });

  it("drops the query entirely when view was the only param", () => {
    window.history.replaceState(null, "", "/?view=app");
    renderHook(() => useAppShell());
    expect(window.location.search).toBe("");
  });

  it("ignores other view values", () => {
    window.history.replaceState(null, "", "/?view=other");
    const { result } = renderHook(() => useAppShell());
    expect(result.current.phase).toBe("landing");
    expect(window.location.search).toBe("?view=other");
  });
});
