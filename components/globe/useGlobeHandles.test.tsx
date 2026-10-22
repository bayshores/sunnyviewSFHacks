// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CesiumViewer } from "./types";
import { useGlobeHandles } from "./useGlobeHandles";

afterEach(cleanup);

function viewerStub(requestRender = vi.fn()) {
  return { scene: { requestRender } } as unknown as CesiumViewer;
}

describe("useGlobeHandles", () => {
  it("destroyPickHandler destroys once and clears the ref, tolerating throws", () => {
    const { result } = renderHook(() => useGlobeHandles());
    const destroy = vi.fn(() => {
      throw new Error("already destroyed");
    });
    result.current.pickHandlerRef.current = { destroy } as never;
    result.current.destroyPickHandler();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(result.current.pickHandlerRef.current).toBeNull();
    result.current.destroyPickHandler();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("cancelLandingSpin cancels the pending frame only when one exists", () => {
    window.cancelAnimationFrame = vi.fn();
    const { result } = renderHook(() => useGlobeHandles());
    result.current.cancelLandingSpin();
    expect(window.cancelAnimationFrame).not.toHaveBeenCalled();
    result.current.landingSpinRafRef.current = 7;
    result.current.landingSpinLastNowRef.current = 123;
    result.current.cancelLandingSpin();
    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(7);
    expect(result.current.landingSpinRafRef.current).toBeNull();
    expect(result.current.landingSpinLastNowRef.current).toBeNull();
  });

  it("clearLandingOrbit disposes the orbit and requests a render", () => {
    const { result } = renderHook(() => useGlobeHandles());
    const dispose = vi.fn();
    const requestRender = vi.fn();
    const viewer = viewerStub(requestRender);
    result.current.viewerRef.current = viewer;
    result.current.orbitRef.current = { dispose } as never;
    result.current.clearLandingOrbit();
    expect(dispose).toHaveBeenCalledWith(viewer);
    expect(result.current.orbitRef.current).toBeNull();
    expect(requestRender).toHaveBeenCalledTimes(1);
  });

  it("clearLandingOrbit prefers the viewer argument and ignores render errors", () => {
    const { result } = renderHook(() => useGlobeHandles());
    const arg = viewerStub(
      vi.fn(() => {
        throw new Error("gone");
      }),
    );
    expect(() => result.current.clearLandingOrbit(arg)).not.toThrow();
  });

  it("clearLandingOrbit with no viewer still disposes", () => {
    const { result } = renderHook(() => useGlobeHandles());
    const dispose = vi.fn();
    result.current.orbitRef.current = { dispose } as never;
    result.current.clearLandingOrbit();
    expect(dispose).toHaveBeenCalledWith(null);
  });

  it("teardownBeforeDestroy stops every loop and drops the marker", () => {
    window.cancelAnimationFrame = vi.fn();
    const { result } = renderHook(() => useGlobeHandles());
    const dispose = vi.fn();
    const destroy = vi.fn();
    result.current.clickSpinRafRef.current = 1;
    result.current.landingSpinRafRef.current = 2;
    result.current.pickHandlerRef.current = { destroy } as never;
    result.current.orbitRef.current = { dispose } as never;
    result.current.markerEntityRef.current = {} as never;
    result.current.teardownBeforeDestroy(viewerStub());
    expect(result.current.clickSpinRafRef.current).toBeNull();
    expect(result.current.landingSpinRafRef.current).toBeNull();
    expect(destroy).toHaveBeenCalled();
    expect(dispose).toHaveBeenCalled();
    expect(result.current.markerEntityRef.current).toBeNull();
  });
});
