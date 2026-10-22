import { NextRequest, NextResponse } from "next/server"

import { getOrCreateVisitorContext } from "@/lib/history-visitor"
import { connectMongo, mongoConnectMessage } from "@/lib/mongo-connect"
import { logProjectsDbError, mapProjectsDbError } from "@/lib/projects-db-errors"
import {
  rateLimitResponse,
  readJsonBody,
  withVisitorCookie,
} from "@/lib/projects-http"
import { createProject } from "@/lib/projects-store"
import { ProjectCreateSchema } from "@/lib/schemas"

export const runtime = "nodejs"

const CREATE_RATE_LIMIT_MAX = 20

export async function POST(req: NextRequest): Promise<NextResponse> {
  const limited = rateLimitResponse(req, "create", CREATE_RATE_LIMIT_MAX)
  if (limited) return limited

  const visitor = getOrCreateVisitorContext(req)

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

  const parsed = ProjectCreateSchema.safeParse(raw.body ?? {})
  if (!parsed.success) {
    return withVisitorCookie({ error: "Invalid body", issues: parsed.error.issues }, visitor, { status: 400 })
  }

  const conn = await connectMongo()
  if (!conn.ok) {
    if (conn.reason === "unavailable") logProjectsDbError("connect", conn.error)
    return withVisitorCookie({ error: mongoConnectMessage("Project", conn.reason) }, visitor, { status: 503 })
  }
  const db = conn.db

  try {
    const created = await createProject({ db, visitorId: visitor.visitorId, input: parsed.data })
    return withVisitorCookie(created, visitor, { status: 201 })
  } catch (err) {
    logProjectsDbError("create", err)
    const mapped = mapProjectsDbError(err, "Failed to create project.")
    return withVisitorCookie({ error: mapped.message }, visitor, { status: mapped.status })
  }
}
