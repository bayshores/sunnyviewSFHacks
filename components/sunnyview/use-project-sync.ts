"use client";

import { useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { PanelSpec, Point } from "@/components/PanelPacking";
import { createProject, ProjectsApiError, updateProject } from "@/lib/projects-api";
import { buildProjectPatch, toProjectPanelSpec, toProjectSiteSpec } from "./project-payload";
import type { Estimate } from "./types";

const PROJECT_PATCH_DEBOUNCE_MS = 900;

export const PROJECT_STORAGE_UNAVAILABLE_MESSAGE = "Sharing is unavailable: project storage isn't configured.";
const PROJECT_CREATE_FALLBACK_MESSAGE = "Could not connect to project backend. Sharing is currently unavailable.";

/** User-facing message for a failed project create. */
export function projectCreateErrorMessage(err: unknown): string {
  if (err instanceof ProjectsApiError) {
    return err.status === 503 ? PROJECT_STORAGE_UNAVAILABLE_MESSAGE : err.message;
  }
  return PROJECT_CREATE_FALLBACK_MESSAGE;
}

export type ProjectSyncInput = {
  panelsMounted: boolean;
  mapKind: "address" | "image";
  lat: number | null;
  lng: number | null;
  zoom: number;
  tiltDeg: number;
  azimuthDeg: number;
  lossesPct: number;
  panelSpec: PanelSpec;
  dcKw: number;
  panelCount: number;
  orientationDeg: number;
  vertices: Point[];
  closed: boolean;
  mPerPx: number | null;
  estimate: Estimate;
  setActionNotice: Dispatch<SetStateAction<string | null>>;
};

export type ProjectSync = {
  projectId: string | null;
  shareSlug: string | null;
  /** Message explaining why the project could not be created, if it failed. */
  projectError: string | null;
};

/** Creates a project once an address site exists, then debounces PATCHes of the design. */
export function useProjectSync(input: ProjectSyncInput): ProjectSync {
  const { panelsMounted, mapKind, lat, lng, zoom, tiltDeg, azimuthDeg, lossesPct, panelSpec } = input;
  const { dcKw, panelCount, orientationDeg, vertices, closed, mPerPx, estimate, setActionNotice } = input;

  const [projectId, setProjectId] = useState<string | null>(null);
  const [shareSlug, setShareSlug] = useState<string | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const creatingProjectRef = useRef(false);
  const projectCreateFailedRef = useRef(false);
  const patchDisabledRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!panelsMounted) return;
    if (projectCreateFailedRef.current) return;
    const hasSite = mapKind === "address" && Number.isFinite(lat ?? NaN) && Number.isFinite(lng ?? NaN);
    if (!hasSite) return;
    if (projectId) return;
    if (creatingProjectRef.current) return;

    creatingProjectRef.current = true;
    void (async () => {
      try {
        const created = await createProject({
          name: "Untitled",
          siteSpec: toProjectSiteSpec({ lat, lng, tiltDeg, azimuthDeg, lossesPct }),
          panelSpec: toProjectPanelSpec(panelSpec),
        });
        // Only an unmount discards the result; later dependency changes must not orphan it.
        if (!mountedRef.current) return;
        setProjectId(created.projectId);
        setShareSlug(created.shareSlug);
      } catch (err) {
        projectCreateFailedRef.current = true;
        if (!mountedRef.current) return;
        const message = projectCreateErrorMessage(err);
        setProjectError(message);
        setActionNotice(message);
      } finally {
        creatingProjectRef.current = false;
      }
    })();
  }, [panelsMounted, azimuthDeg, lat, lng, lossesPct, mapKind, panelSpec, projectId, tiltDeg, setActionNotice]);

  useEffect(() => {
    if (!panelsMounted) return;
    if (!projectId) return;
    if (patchDisabledRef.current) return;
    const t = window.setTimeout(async () => {
      const patch = buildProjectPatch({
        lat,
        lng,
        tiltDeg,
        azimuthDeg,
        lossesPct,
        panelSpec,
        dcKw,
        panelCount,
        orientationDeg,
        vertices,
        closed,
        mPerPx,
        background: mapKind,
        zoom,
        estimate,
      });
      if (!patch) return;
      try {
        await updateProject(projectId, patch);
      } catch (err) {
        // Saving is best-effort; stop retrying when the project is gone or storage is off.
        if (err instanceof ProjectsApiError && (err.status === 404 || err.status === 503)) {
          patchDisabledRef.current = true;
        }
      }
    }, PROJECT_PATCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [
    panelsMounted,
    azimuthDeg,
    closed,
    dcKw,
    estimate,
    lat,
    lng,
    lossesPct,
    mPerPx,
    mapKind,
    orientationDeg,
    panelCount,
    panelSpec,
    projectId,
    tiltDeg,
    vertices,
    zoom,
  ]);

  return { projectId, shareSlug, projectError };
}
