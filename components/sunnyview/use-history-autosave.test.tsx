// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveHistory } from "@/lib/history-api";
import { useHistoryAutosave } from "./use-history-autosave";
import type { HistoryAutosaveInput } from "./use-history-autosave";
import { INITIAL_ESTIMATE } from "./estimate";

vi.mock("@/lib/history-api", () => ({ saveHistory: vi.fn() }));
const saveMock = vi.mocked(saveHistory);

const VERTICES = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
];

function makeInput(overrides: Partial<HistoryAutosaveInput> = {}): HistoryAutosaveInput {
  return {
    panelsMounted: true,
    opened: true,
    mapKind: "address",
    address: "1 Main St",
    lat: 37.7,
    lng: -122.4,
    zoom: 19,
    mPerPx: 0.1,
    tiltDeg: 20,
    azimuthDeg: 180,
    lossesPct: 14,
    panelSpec: { widthM: 1.1, heightM: 1.7, wattW: 400, gapM: 0.02 },
    orientationDeg: 0,
    panelCount: 4,
    dcKw: 1.6,
    vertices: VERTICES,
    closed: true,
    estimate: INITIAL_ESTIMATE,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  saveMock.mockReset();
  saveMock.mockResolvedValue(undefined as never);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useHistoryAutosave", () => {
  it("saves after the 1800ms debounce with snapshot and summary", async () => {
    renderHook(() => useHistoryAutosave(makeInput()));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1799);
    });
    expect(saveMock).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(saveMock).toHaveBeenCalledTimes(1);
    const arg = saveMock.mock.calls[0][0];
    expect(arg.snapshot).toMatchObject({ mode: "address", address: "1 Main St", lat: 37.7 });
    expect(arg.summary).toBeDefined();
  });

  it("restarts the debounce when the design changes", async () => {
    const { rerender } = renderHook((p: HistoryAutosaveInput) => useHistoryAutosave(p), {
      initialProps: makeInput(),
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    rerender(makeInput({ tiltDeg: 30 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(saveMock).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(saveMock.mock.calls[0][0].snapshot.siteSpec.tiltDeg).toBe(30);
  });

  it("does not re-save an identical signature and records it in the returned ref", async () => {
    const { result, rerender } = renderHook((p: HistoryAutosaveInput) => useHistoryAutosave(p), {
      initialProps: makeInput(),
    });
    expect(result.current.current).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1800);
    });
    expect(result.current.current).not.toBeNull();

    // Fresh vertex array with identical content: same signature, so no second save.
    rerender(makeInput({ vertices: VERTICES.map((p) => ({ ...p })) }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(saveMock).toHaveBeenCalledTimes(1);
  });

  it("re-saves when the ref is cleared by the caller", async () => {
    const { result, rerender } = renderHook((p: HistoryAutosaveInput) => useHistoryAutosave(p), {
      initialProps: makeInput(),
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1800);
    });
    result.current.current = null;
    rerender(makeInput({ lossesPct: 15 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1800);
    });
    expect(saveMock).toHaveBeenCalledTimes(2);
  });

  it("swallows save errors and retries on the next change", async () => {
    saveMock.mockRejectedValueOnce(new Error("db down"));
    const { result, rerender } = renderHook((p: HistoryAutosaveInput) => useHistoryAutosave(p), {
      initialProps: makeInput(),
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1800);
    });
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(result.current.current).toBeNull();
    rerender(makeInput({ lossesPct: 12 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1800);
    });
    expect(saveMock).toHaveBeenCalledTimes(2);
    expect(result.current.current).not.toBeNull();
  });

  it("does not record the signature when unmounted mid-save", async () => {
    let resolve!: () => void;
    saveMock.mockReturnValue(new Promise<never>((r) => (resolve = r as () => void)));
    const { result, unmount } = renderHook(() => useHistoryAutosave(makeInput()));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1800);
    });
    unmount();
    await act(async () => {
      resolve();
    });
    expect(result.current.current).toBeNull();
  });

  it.each([
    ["panels not mounted", { panelsMounted: false }],
    ["app not opened", { opened: false }],
    ["image input", { mapKind: "image" as const }],
    ["no site", { lat: null }],
    ["open ring", { closed: false }],
    ["no panels", { panelCount: 0 }],
  ])("does not save when %s", async (_name, overrides) => {
    renderHook(() => useHistoryAutosave(makeInput(overrides)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(saveMock).not.toHaveBeenCalled();
  });
});
