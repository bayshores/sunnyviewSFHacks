import type { z } from "zod"

import type {
  ProjectCreateSchema,
  ProjectEstimateSchema,
  ProjectGeometrySchema,
  ProjectLayoutSummarySchema,
  ProjectPanelSpecSchema,
  ProjectPatchSchema,
  ProjectSiteSpecSchema,
} from "@/lib/schemas"

export type ProjectSiteSpec = z.infer<typeof ProjectSiteSpecSchema>
export type ProjectPanelSpec = z.infer<typeof ProjectPanelSpecSchema>
export type ProjectLayoutSummary = z.infer<typeof ProjectLayoutSummarySchema>
export type ProjectGeometry = z.infer<typeof ProjectGeometrySchema>
export type ProjectEstimate = z.infer<typeof ProjectEstimateSchema>

export type CreateProjectRequest = z.infer<typeof ProjectCreateSchema>
export type UpdateProjectRequest = z.infer<typeof ProjectPatchSchema>

export type CreateProjectResponse = {
  projectId: string
  shareSlug: string
}

/** Full project as seen by its owner. */
export type OwnedProject = {
  id: string
  shareSlug: string
  name: string
  siteSpec: ProjectSiteSpec | null
  panelSpec: ProjectPanelSpec | null
  layoutSummary: ProjectLayoutSummary | null
  geometry: ProjectGeometry | null
  estimate: ProjectEstimate | null
  createdAt: string
  updatedAt: string
}

/** Public, read-only projection served by GET /api/share/[slug]. No owner or internal ids. */
export type SharedProject = {
  name: string
  siteSpec: ProjectSiteSpec | null
  panelSpec: ProjectPanelSpec | null
  layoutSummary: ProjectLayoutSummary | null
  geometry: ProjectGeometry | null
  estimate: ProjectEstimate | null
  updatedAt: string
}
