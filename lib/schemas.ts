import { z } from "zod"

/**
 * Zod schemas for the Projects feature (create / patch payloads).
 * Bounds mirror the History SnapshotSchema.
 */

const finite = z.number().finite()

export const ProjectSiteSpecSchema = z
  .object({
    lat: finite.min(-90).max(90),
    lng: finite.min(-180).max(180),
    tiltDeg: finite.min(0).max(90),
    azimuthDeg: finite.min(0).max(360),
    lossesPct: finite.min(0).max(40),
  })
  .strict()

export const ProjectPanelSpecSchema = z
  .object({
    widthM: finite.positive().max(4),
    heightM: finite.positive().max(4),
    wattW: finite.positive().max(1500),
    gapM: finite.min(0).max(1),
  })
  .strict()

export const ProjectLayoutSummarySchema = z
  .object({
    dcKw: finite.nonnegative().max(20_000),
    panelCount: z.number().int().nonnegative().max(20_000),
    orientationDeg: finite.min(-360).max(360),
  })
  .strict()

export const ProjectGeometrySchema = z
  .object({
    vertices: z.array(z.object({ x: finite, y: finite }).strict()).max(160),
    closed: z.boolean(),
    mPerPx: finite.positive().nullable().optional(),
    background: z.enum(["address", "image"]),
    zoom: finite.min(0).max(24),
  })
  .strict()

const AssumptionValueSchema = z.union([z.string().max(200), finite, z.boolean(), z.null()])

export const ProjectEstimateSchema = z
  .object({
    annualKwh: finite.nonnegative().max(2_000_000),
    monthlyKwh: z.array(finite.nonnegative().max(400_000)).length(12),
    annualCo2Kg: finite.nonnegative().max(2_000_000),
    source: z.string().trim().max(40),
    assumptions: z
      .record(z.string().max(60), AssumptionValueSchema)
      .refine((v) => Object.keys(v).length <= 40, { message: "Too many assumptions." })
      .optional(),
  })
  .strict()

export const ProjectNameSchema = z.string().trim().min(1).max(80)

export const ProjectCreateSchema = z
  .object({
    name: ProjectNameSchema.optional(),
    siteSpec: ProjectSiteSpecSchema.optional(),
    panelSpec: ProjectPanelSpecSchema.optional(),
  })
  .strict()

export const ProjectPatchSchema = z
  .object({
    name: ProjectNameSchema.optional(),
    siteSpec: ProjectSiteSpecSchema.optional(),
    panelSpec: ProjectPanelSpecSchema.optional(),
    layoutSummary: ProjectLayoutSummarySchema.optional(),
    geometry: ProjectGeometrySchema.optional(),
    estimate: ProjectEstimateSchema.nullable().optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "At least one field must be provided.",
  })
