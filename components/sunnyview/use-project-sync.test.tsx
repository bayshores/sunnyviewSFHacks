// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProject, ProjectsApiError, updateProject } from "@/lib/projects-api";
import { projectCreateErrorMessage, PROJECT_STORAGE_UNAVAILABLE_MESSAGE, useProjectSync } from "./use-project-sync";
import type { ProjectSyncInput } from "./use-project-sync";
import { INITIAL_ESTIMATE } from "./estimate";

vi.mock("@/lib/projects-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/projects-api")>();
  return { ...actual, createProject: vi.fn(), updateProject: vi.fn() };
});

const createMock = vi.mocked(createProject);
const updateMock = vi.mocked(updateProject);

const PANEL_SPEC = { widthM: 1.1, heightM: 1.7, wattW: 400, gapM: 0.02 };
const VERTICES = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
];

function baseInput(overrides: Partial<ProjectSyncInput> = {}): ProjectSyncInput {
  return {
    panelsMounted: true,
    mapKind: "address",
    lat: 37.77,
    lng: -122.41,
    zoom: 19,
    tiltDeg: 20,
    azimuthDeg: 180,
    lossesPct: 14,
    panelSpec: PANEL_SPEC,
    dcKw: 2,
    panelCount: 5,
    orientationDeg: 10,
    vertices: VERTICES,
    closed: true,
    mPerPx: 0.1,
    estimate: INITIAL_ESTIMATE,
    setActionNotice: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  createMock.mockReset();
  updateMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("projectCreateErrorMessage", () => {
  it("maps 503 to the storage message", () => {
    expect(projectCreateErrorMessage(new ProjectsApiError("x", 503))).toBe(PROJECT_STORAGE_UNAVAILABLE_MESSAGE);
  });
  it("keeps other API error messages", () => {
    expect(projectCreateErrorMessage(new ProjectsApiError("Too many", 429))).toBe("Too many");
  });
  it("falls back for unknown errors", () => {
    expect(projectCreateErrorMessage(new Error("boom"))).toMatch(/Could not connect/);
  });
});

describe("useProjectSync", () => {
  it("creates a project once with the site and panel payload", async () => {
    createMock.mockResolvedValue({ projectId: "p1", shareSlug: "slug1" });
    const { result, rerender } = renderHook((p: ProjectSyncInput) => useProjectSync(p), {
      initialProps: baseInput(),
    });
    await act(async () => {});
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledWith({
      name: "Untitled",
      siteSpec: { lat: 37.77, lng: -122.41, tiltDeg: 20, azimuthDeg: 180, lossesPct: 14 },
      panelSpec: PANEL_SPEC,
    });
    expect(result.current).toEqual({ projectId: "p1", shareSlug: "slug1", projectError: null });

    rerender(baseInput({ tiltDeg: 25 }));
    await act(async () => {});
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("does not create without an address site or before panels mount", async () => {
    renderHook(() => useProjectSync(baseInput({ lat: null })));
    renderHook(() => useProjectSync(baseInput({ mapKind: "image" })));
    renderHook(() => useProjectSync(baseInput({ panelsMounted: false })));
    await act(async () => {});
    expect(createMock).not.toHaveBeenCalled();
  });

  it("reports the storage notice on 503 and does not retry", async () => {
    createMock.mockRejectedValue(new ProjectsApiError("unavailable", 503));
    const setActionNotice = vi.fn();
    const { result, rerender } = renderHook((p: ProjectSyncInput) => useProjectSync(p), {
      initialProps: baseInput({ setActionNotice }),
    });
    await act(async () => {});
    expect(result.current.projectError).toBe("Sharing is unavailable: project storage isn't configured.");
    expect(setActionNotice).toHaveBeenCalledWith("Sharing is unavailable: project storage isn't configured.");
    expect(result.current.projectId).toBeNull();

    rerender(baseInput({ setActionNotice, lat: 40 }));
    await act(async () => {});
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("uses the generic message for network failures", async () => {
    createMock.mockRejectedValue(new Error("network"));
    const { result } = renderHook(() => useProjectSync(baseInput()));
    await act(async () => {});
    expect(result.current.projectError).toMatch(/Could not connect to project backend/);
  });

  it("discards an in-flight create result after unmount", async () => {
    let resolve!: (v: { projectId: string; shareSlug: string }) => void;
    createMock.mockReturnValue(new Promise((r) => (resolve = r)));
    const setActionNotice = vi.fn();
    const { unmount } = renderHook(() => useProjectSync(baseInput({ setActionNotice })));
    unmount();
    await act(async () => {
      resolve({ projectId: "late", shareSlug: "late" });
    });
    expect(setActionNotice).not.toHaveBeenCalled();
  });

  it("skips error state updates after unmount", async () => {
    let reject!: (e: unknown) => void;
    createMock.mockReturnValue(new Promise((_, r) => (reject = r)));
    const setActionNotice = vi.fn();
    const { unmount } = renderHook(() => useProjectSync(baseInput({ setActionNotice })));
    unmount();
    await act(async () => {
      reject(new ProjectsApiError("x", 503));
    });
    expect(setActionNotice).not.toHaveBeenCalled();
  });

  it("debounces PATCHes by 900ms with a sanitised payload", async () => {
    createMock.mockResolvedValue({ projectId: "p1", shareSlug: "s" });
    updateMock.mockResolvedValue({} as never);
    const { rerender } = renderHook((p: ProjectSyncInput) => useProjectSync(p), { initialProps: baseInput() });
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(899);
    });
    expect(updateMock).not.toHaveBeenCalled();

    // A change inside the window restarts the debounce.
    rerender(baseInput({ panelCount: 6, dcKw: 2.4, lossesPct: 99 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(899);
    });
    expect(updateMock).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(updateMock).toHaveBeenCalledTimes(1);
    const [id, patch] = updateMock.mock.calls[0];
    expect(id).toBe("p1");
    // lossesPct 99 is out of server bounds, so the siteSpec section is dropped.
    expect(patch).not.toHaveProperty("siteSpec");
    expect(patch.layoutSummary).toEqual({ dcKw: 2.4, panelCount: 6, orientationDeg: 10 });
    expect(patch.panelSpec).toEqual(PANEL_SPEC);
    expect(patch.geometry).toMatchObject({ closed: true, background: "address", zoom: 19 });
  });

  it.each([404, 503])("stops PATCHing after a %i", async (status) => {
    createMock.mockResolvedValue({ projectId: "p1", shareSlug: "s" });
    updateMock.mockRejectedValue(new ProjectsApiError("gone", status));
    const { rerender } = renderHook((p: ProjectSyncInput) => useProjectSync(p), { initialProps: baseInput() });
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900);
    });
    expect(updateMock).toHaveBeenCalledTimes(1);

    rerender(baseInput({ panelCount: 9 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it("keeps PATCHing after a transient failure", async () => {
    createMock.mockResolvedValue({ projectId: "p1", shareSlug: "s" });
    updateMock.mockRejectedValue(new ProjectsApiError("net", 0));
    const { rerender } = renderHook((p: ProjectSyncInput) => useProjectSync(p), { initialProps: baseInput() });
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900);
    });
    rerender(baseInput({ panelCount: 9 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900);
    });
    expect(updateMock).toHaveBeenCalledTimes(2);
  });
});
