// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CesiumViewer, RafRef, ViewerRef } from "./types";
import { useLandingSpin } from "./useLandingSpin";
import type { UseLandingSpinOptions } from "./useLandingSpin";

let rafQueue: Map<number, FrameRequestCallback>;
let rafId: number;

function fakeViewer() {
  return {
    camera: { flyHome: vi.fn(), rotateRight: vi.fn() },
    scene: { requestRender: vi.fn() },
  };
}

function options(viewer: ReturnType<typeof fakeViewer> | null, over: Partial<UseLandingSpinOptions> = {}) {
  const viewerRef = { current: viewer as unknown as CesiumViewer | null } as ViewerRef;
  const landingSpinRafRef: RafRef = { current: null };
  const landingSpinLastNowRef: RafRef = { current: null };
  return {
    ready: true,
    isHero: true,
    landingActive: true,
    viewerRef,
    landingSpinRafRef,
    landingSpinLastNowRef,
    cancelLandingSpin: vi.fn(),
    ...over,
  } satisfies UseLandingSpinOptions;
}

function runFrame(now: number) {
  const pending = [...rafQueue.values()];
  rafQueue.clear();
  pending.forEach((cb) => cb(now));
}

function mockReducedMotion(matches: boolean) {
  window.matchMedia = vi.fn(() => ({ matches })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  vi.useFakeTimers();
  rafQueue = new Map();
  rafId = 1;
  window.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
    rafQueue.set(rafId, cb);
    return rafId++;
  });
  window.cancelAnimationFrame = vi.fn((id: number) => {
    rafQueue.delete(id);
  });
  mockReducedMotion(false);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useLandingSpin", () => {
  it("flies home, then starts spinning after the hero delay", () => {
    const viewer = fakeViewer();
    const opts = options(viewer);
    renderHook(() => useLandingSpin(opts));
    expect(opts.cancelLandingSpin).toHaveBeenCalled();
    expect(viewer.camera.flyHome).toHaveBeenCalledWith(1);
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(rafQueue.size).toBe(0);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(rafQueue.size).toBe(1);

    act(() => runFrame(1000));
    act(() => runFrame(1016));
    expect(viewer.camera.rotateRight).toHaveBeenCalledTimes(2);
    const [angle] = viewer.camera.rotateRight.mock.calls[1];
    expect(angle).toBeCloseTo(0.011 * 0.016, 6);
    expect(viewer.scene.requestRender).toHaveBeenCalled();
    expect(opts.landingSpinRafRef.current).not.toBeNull();
  });

  it("uses the faster app spin and longer delay when not the hero", () => {
    const viewer = fakeViewer();
    const opts = options(viewer, { isHero: false });
    renderHook(() => useLandingSpin(opts));
    act(() => {
      vi.advanceTimersByTime(1049);
    });
    expect(rafQueue.size).toBe(0);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    act(() => runFrame(0));
    act(() => runFrame(16));
    expect(viewer.camera.rotateRight.mock.calls[1][0]).toBeCloseTo(0.03 * 0.016, 6);
  });

  it("does not spin with reduced motion, but still snaps the camera home", () => {
    mockReducedMotion(true);
    const viewer = fakeViewer();
    renderHook(() => useLandingSpin(options(viewer)));
    expect(viewer.camera.flyHome).toHaveBeenCalledWith(0);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(rafQueue.size).toBe(0);
  });

  it("stops the loop when the camera throws", () => {
    const viewer = fakeViewer();
    viewer.camera.rotateRight.mockImplementation(() => {
      throw new Error("destroyed");
    });
    renderHook(() => useLandingSpin(options(viewer)));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    act(() => runFrame(10));
    expect(rafQueue.size).toBe(0);
  });

  it("survives a flyHome failure", () => {
    const viewer = fakeViewer();
    viewer.camera.flyHome.mockImplementation(() => {
      throw new Error("nope");
    });
    expect(() => renderHook(() => useLandingSpin(options(viewer)))).not.toThrow();
  });

  it("stops the loop when the viewer disappears", () => {
    const viewer = fakeViewer();
    const opts = options(viewer);
    renderHook(() => useLandingSpin(opts));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    opts.viewerRef.current = null;
    act(() => runFrame(10));
    expect(rafQueue.size).toBe(0);
  });

  it("cancels the timer and frame on unmount", () => {
    const viewer = fakeViewer();
    const opts = options(viewer);
    const { unmount } = renderHook(() => useLandingSpin(opts));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    unmount();
    expect(rafQueue.size).toBe(0);
    expect(opts.landingSpinRafRef.current).toBeNull();
    expect(opts.landingSpinLastNowRef.current).toBeNull();
  });

  it.each([
    ["not ready", { ready: false }],
    ["landing inactive", { landingActive: false }],
  ])("does not spin when %s", (_name, over) => {
    const viewer = fakeViewer();
    renderHook(() => useLandingSpin(options(viewer, over)));
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(rafQueue.size).toBe(0);
    expect(viewer.camera.rotateRight).not.toHaveBeenCalled();
  });

  it("does nothing without a viewer", () => {
    const opts = options(null);
    renderHook(() => useLandingSpin(opts));
    expect(opts.cancelLandingSpin).not.toHaveBeenCalled();
  });
});
