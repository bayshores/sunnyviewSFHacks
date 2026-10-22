// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRafInvalidate } from "./useRafInvalidate";

let rafCallbacks: Map<number, FrameRequestCallback>;
let nextId: number;
let resizeCallbacks: Array<() => void>;
const disconnect = vi.fn();
const observe = vi.fn();

class FakeResizeObserver {
  constructor(cb: () => void) {
    resizeCallbacks.push(cb);
  }
  observe = observe;
  disconnect = disconnect;
}

function flushFrame() {
  const pending = [...rafCallbacks.entries()];
  rafCallbacks.clear();
  for (const [, cb] of pending) cb(0);
}

beforeEach(() => {
  rafCallbacks = new Map();
  nextId = 1;
  resizeCallbacks = [];
  disconnect.mockClear();
  observe.mockClear();
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  window.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
    const id = nextId++;
    rafCallbacks.set(id, cb);
    return id;
  });
  window.cancelAnimationFrame = vi.fn((id: number) => {
    rafCallbacks.delete(id);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useRafInvalidate", () => {
  it("coalesces many invalidations into one draw per frame", () => {
    const draw = vi.fn();
    const { result } = renderHook(() => useRafInvalidate({ current: draw }, { current: null }));
    result.current();
    result.current();
    result.current();
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(draw).not.toHaveBeenCalled();
    act(flushFrame);
    expect(draw).toHaveBeenCalledTimes(1);
  });

  it("allows a new draw after the frame ran", () => {
    const draw = vi.fn();
    const { result } = renderHook(() => useRafInvalidate({ current: draw }, { current: null }));
    result.current();
    act(flushFrame);
    result.current();
    act(flushFrame);
    expect(draw).toHaveBeenCalledTimes(2);
  });

  it("calls the latest draw function held in the ref", () => {
    const first = vi.fn();
    const second = vi.fn();
    const drawRef = { current: first };
    const { result } = renderHook(() => useRafInvalidate(drawRef, { current: null }));
    result.current();
    drawRef.current = second;
    act(flushFrame);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending frame on unmount", () => {
    const draw = vi.fn();
    const { result, unmount } = renderHook(() => useRafInvalidate({ current: draw }, { current: null }));
    result.current();
    unmount();
    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(1);
    flushFrame();
    expect(draw).not.toHaveBeenCalled();
  });

  it("does not cancel anything on unmount when no frame is pending", () => {
    const { unmount } = renderHook(() => useRafInvalidate({ current: vi.fn() }, { current: null }));
    unmount();
    expect(window.cancelAnimationFrame).not.toHaveBeenCalled();
  });

  it("redraws when the observed element resizes and disconnects on unmount", () => {
    const draw = vi.fn();
    const el = document.createElement("div");
    const { unmount } = renderHook(() => useRafInvalidate({ current: draw }, { current: el }));
    expect(observe).toHaveBeenCalledWith(el);
    act(() => resizeCallbacks[0]());
    act(flushFrame);
    expect(draw).toHaveBeenCalledTimes(1);
    unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
