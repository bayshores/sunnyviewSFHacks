import { NextRequest, NextResponse } from "next/server"

import { getOrCreateVisitorContext } from "@/lib/history-visitor"
import { getMongoDb } from "@/lib/mongo"
import { logProjectsDbError, mapProjectsDbError } from "@/lib/projects-db-errors"
import {
  PROJECTS_NOT_CONFIGURED,
  rateLimitResponse,
  readJsonBody,
  withVisitorCookie,
} from "@/lib/projects-http"
import { getOwnedProject, updateOwnedProject } from "@/lib/projects-store"
import { ProjectPatchSchema } from "@/lib/schemas"

export const runtime = "nodejs"

type RouteContext = {
  params: Promise<{ id: string }>
}

const DETAIL_RATE_LIMIT_MAX = 120
const PATCH_RATE_LIMIT_MAX = 90

const NOT_FOUND = "Project not found."

export async function GET(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const limited = rateLimitResponse(req, "detail", DETAIL_RATE_LIMIT_MAX)
  if (limited) return limited

  const visitor = getOrCreateVisitorContext(req)
  const { id } = await ctx.params
  const db = await getMongoDb()
  if (!db) {
    return withVisitorCookie({ error: PROJECTS_NOT_CONFIGURED }, visitor, { status: 503 })
  }

  try {
    const project = await getOwnedProject({ db, visitorId: visitor.visitorId, id })
    if (!project) return withVisitorCookie({ error: NOT_FOUND }, visitor, { status: 404 })
    return withVisitorCookie({ project }, visitor, { status: 200 })
  } catch (err) {
    logProjectsDbError("detail", err)
    const mapped = mapProjectsDbError(err, "Failed to load project.")
    return withVisitorCookie({ error: mapped.message }, visitor, { status: mapped.status })
  }
}

export async function PATCH(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const limited = rateLimitResponse(req, "patch", PATCH_RATE_LIMIT_MAX)
  if (limited) return limited

  const visitor = getOrCreateVisitorContext(req)
  const { id } = await ctx.params

  const raw = await readJsonBody(req)
  if (!raw.ok) {
    const error =
      raw.status === 413
        ? "Project payload is too large."
        : raw.status === 415
          ? "Content-Type must be application/json."
          : raw.status === 403
            ? "Cross-site requests are not allowed."
            : "Invalid JSON body."
    return withVisitorCookie({ error }, visitor, { status: raw.status })
  }

  const parsed = ProjectPatchSchema.safeParse(raw.body)
  if (!parsed.success) {
    return withVisitorCookie({ error: "Invalid body", issues: parsed.error.issues }, visitor, { status: 400 })
  }

  const db = await getMongoDb()
  if (!db) {
    return withVisitorCookie({ error: PROJECTS_NOT_CONFIGURED }, visitor, { status: 503 })
  }

  try {
    const project = await updateOwnedProject({ db, visitorId: visitor.visitorId, id, patch: parsed.data })
    if (!project) return withVisitorCookie({ error: NOT_FOUND }, visitor, { status: 404 })
    return withVisitorCookie({ project }, visitor, { status: 200 })
  } catch (err) {
    logProjectsDbError("patch", err)
    const mapped = mapProjectsDbError(err, "Failed to update project.")
    return withVisitorCookie({ error: mapped.message }, visitor, { status: mapped.status })
  }
}
