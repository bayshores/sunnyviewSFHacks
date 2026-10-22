// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBackgroundImage } from "./useBackgroundImage";

class FakeImage {
  static instances: FakeImage[] = [];
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = "";
  constructor() {
    FakeImage.instances.push(this);
  }
}

beforeEach(() => {
  FakeImage.instances = [];
  vi.stubGlobal("Image", FakeImage);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useBackgroundImage", () => {
  it("returns nothing and loads nothing without a src", () => {
    const { result } = renderHook(() => useBackgroundImage(null));
    expect(result.current).toEqual({ image: null, error: null });
    expect(FakeImage.instances).toHaveLength(0);
  });

  it("exposes the image once it loads", () => {
    const { result } = renderHook(() => useBackgroundImage("/a.png"));
    expect(FakeImage.instances[0].src).toBe("/a.png");
    expect(result.current.image).toBeNull();
    act(() => FakeImage.instances[0].onload?.());
    expect(result.current.image).toBe(FakeImage.instances[0]);
    expect(result.current.error).toBeNull();
  });

  it("reports an error when the load fails", () => {
    const { result } = renderHook(() => useBackgroundImage("/bad.png"));
    act(() => FakeImage.instances[0].onerror?.());
    expect(result.current.image).toBeNull();
    expect(result.current.error).toMatch(/failed to load/);
    expect(console.error).toHaveBeenCalled();
  });

  it("keeps the previous image while a new src loads, then swaps", () => {
    const { result, rerender } = renderHook((p: { src: string | null }) => useBackgroundImage(p.src), {
      initialProps: { src: "/a.png" as string | null },
    });
    act(() => FakeImage.instances[0].onload?.());
    rerender({ src: "/b.png" });
    expect(result.current.image).toBe(FakeImage.instances[0]);
    act(() => FakeImage.instances[1].onload?.());
    expect(result.current.image).toBe(FakeImage.instances[1]);
  });

  it("scopes the error to the failing src", () => {
    const { result, rerender } = renderHook((p: { src: string | null }) => useBackgroundImage(p.src), {
      initialProps: { src: "/bad.png" as string | null },
    });
    act(() => FakeImage.instances[0].onerror?.());
    expect(result.current.error).not.toBeNull();
    rerender({ src: "/good.png" });
    expect(result.current.error).toBeNull();
  });

  it("drops the image when src becomes null", () => {
    const { result, rerender } = renderHook((p: { src: string | null }) => useBackgroundImage(p.src), {
      initialProps: { src: "/a.png" as string | null },
    });
    act(() => FakeImage.instances[0].onload?.());
    rerender({ src: null });
    expect(result.current.image).toBeNull();
  });

  it("ignores late results from a superseded or unmounted load", () => {
    const { result, rerender, unmount } = renderHook((p: { src: string | null }) => useBackgroundImage(p.src), {
      initialProps: { src: "/a.png" as string | null },
    });
    rerender({ src: "/b.png" });
    act(() => FakeImage.instances[0].onload?.());
    expect(result.current.image).toBeNull();
    act(() => FakeImage.instances[0].onerror?.());
    expect(result.current.error).toBeNull();
    unmount();
    act(() => FakeImage.instances[1].onload?.());
  });
});
