import { NextRequest, NextResponse } from "next/server"

import { getMongoDb } from "@/lib/mongo"
import { logProjectsDbError, mapProjectsDbError } from "@/lib/projects-db-errors"
import { PROJECTS_NOT_CONFIGURED, rateLimitResponse } from "@/lib/projects-http"
import { getSharedProjectBySlug } from "@/lib/projects-store"

export const runtime = "nodejs"

type RouteContext = {
  params: Promise<{ slug: string }>
}

const SHARE_RATE_LIMIT_MAX = 120
const SLUG_RE = /^[A-Za-z0-9_-]{10,64}$/
const PUBLIC_CACHE_CONTROL = "public, max-age=15, s-maxage=30, stale-while-revalidate=60"

export async function GET(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const limited = rateLimitResponse(req, "share", SHARE_RATE_LIMIT_MAX)
  if (limited) return limited

  const { slug } = await ctx.params
  if (!SLUG_RE.test(slug)) {
    return NextResponse.json({ error: "Shared project not found." }, { status: 404 })
  }

  const db = await getMongoDb()
  if (!db) {
    return NextResponse.json({ error: PROJECTS_NOT_CONFIGURED }, { status: 503 })
  }

  try {
    const project = await getSharedProjectBySlug({ db, slug })
    if (!project) return NextResponse.json({ error: "Shared project not found." }, { status: 404 })
    return NextResponse.json({ project }, { status: 200, headers: { "cache-control": PUBLIC_CACHE_CONTROL } })
  } catch (err) {
    logProjectsDbError("share", err)
    const mapped = mapProjectsDbError(err, "Failed to load shared project.")
    return NextResponse.json({ error: mapped.message }, { status: mapped.status })
  }
}
