import { nanoid } from "nanoid"
import { Collection, Db, ObjectId, WithId } from "mongodb"

import type {
  CreateProjectRequest,
  CreateProjectResponse,
  OwnedProject,
  ProjectEstimate,
  ProjectGeometry,
  ProjectLayoutSummary,
  ProjectPanelSpec,
  ProjectSiteSpec,
  SharedProject,
  UpdateProjectRequest,
} from "@/lib/projects-types"

const COLLECTION_NAME = "projects"
const SHARE_SLUG_LEN = 12
const MAX_SLUG_ATTEMPTS = 4
const DUPLICATE_KEY_CODE = 11000
const INDEX_OPTIONS_CONFLICT_CODE = 85
const INDEX_KEY_SPECS_CONFLICT_CODE = 86

type ProjectDocFields = {
  visitorId: string
  shareSlug: string
  name: string
  siteSpec: ProjectSiteSpec | null
  panelSpec: ProjectPanelSpec | null
  layoutSummary: ProjectLayoutSummary | null
  geometry: ProjectGeometry | null
  estimate: ProjectEstimate | null
  createdAt: Date
  updatedAt: Date
}

type StoredProjectDoc = WithId<ProjectDocFields>

const DEFAULT_TTL_DAYS = 90
const DEFAULT_MAX_PER_VISITOR = 50
const MAX_TTL_DAYS = 3650
const MAX_PER_VISITOR_CAP = 1000
const SECONDS_PER_DAY = 86_400

// Keyed by database name: getMongoDb() returns a fresh Db object per call, so object identity is useless.
type IndexInitCache = Map<string, Promise<void>>

function indexInitCache(): IndexInitCache {
  const g = globalThis as unknown as { __sunnyviewProjectIndexInit?: IndexInitCache }
  g.__sunnyviewProjectIndexInit ??= new Map()
  return g.__sunnyviewProjectIndexInit
}

function parsePositiveInt(raw: string | undefined, fallback: number, max: number) {
  const n = Number(raw ?? "")
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(1, Math.min(max, Math.round(n)))
}

function parseTtlSeconds() {
  return parsePositiveInt(process.env.PROJECTS_TTL_DAYS, DEFAULT_TTL_DAYS, MAX_TTL_DAYS) * SECONDS_PER_DAY
}

function parseMaxPerVisitor() {
  return parsePositiveInt(process.env.PROJECTS_MAX_PER_VISITOR, DEFAULT_MAX_PER_VISITOR, MAX_PER_VISITOR_CAP)
}

function projectsCollection(db: Db): Collection<ProjectDocFields> {
  return db.collection<ProjectDocFields>(COLLECTION_NAME)
}

function errorCode(err: unknown) {
  return typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined
}

/** Best-effort: a TTL problem must never take down every project request. */
async function ensureTtlIndex(db: Db, coll: Collection<ProjectDocFields>) {
  const expireAfterSeconds = parseTtlSeconds()
  try {
    await coll.createIndex({ updatedAt: 1 }, { expireAfterSeconds })
    return
  } catch (err) {
    const code = errorCode(err)
    if (code !== INDEX_OPTIONS_CONFLICT_CODE && code !== INDEX_KEY_SPECS_CONFLICT_CODE) {
      console.warn("[projects] TTL index creation failed", { code })
      return
    }
  }
  try {
    await db.command({ collMod: COLLECTION_NAME, index: { keyPattern: { updatedAt: 1 }, expireAfterSeconds } })
  } catch (err) {
    console.warn("[projects] TTL index update failed", { code: errorCode(err) })
  }
}

/**
 * Creates indexes once per database name (per process), including a TTL index on updatedAt
 * (PROJECTS_TTL_DAYS, default 90). Changing PROJECTS_TTL_DAYS after the index exists requires
 * a `collMod` on the existing index; createIndex with different options would conflict.
 */
export async function ensureProjectIndexes(db: Db): Promise<void> {
  const cache = indexInitCache()
  const key = db.databaseName
  const existing = cache.get(key)
  if (existing) return existing

  const coll = projectsCollection(db)
  const promise = (async () => {
    await coll.createIndex({ shareSlug: 1 }, { unique: true })
    await coll.createIndex({ visitorId: 1, updatedAt: -1 })
    await ensureTtlIndex(db, coll)
  })().catch((err) => {
    cache.delete(key)
    throw err
  })
  cache.set(key, promise)
  return promise
}

async function enforceVisitorCap(coll: Collection<ProjectDocFields>, visitorId: string) {
  const stale = await coll
    .find({ visitorId })
    .sort({ updatedAt: -1, _id: -1 })
    .skip(parseMaxPerVisitor())
    .project<{ _id: ObjectId }>({ _id: 1 })
    .toArray()
  if (!stale.length) return
  await coll.deleteMany({ _id: { $in: stale.map((doc) => doc._id) } })
}

/** The project is already stored; a failed cleanup must not fail (and cause a duplicate retry of) the create. */
async function enforceVisitorCapBestEffort(coll: Collection<ProjectDocFields>, visitorId: string) {
  try {
    await enforceVisitorCap(coll, visitorId)
  } catch (err) {
    console.warn("[projects] visitor cap cleanup failed", { name: err instanceof Error ? err.name : typeof err })
  }
}

function toObjectId(id: string) {
  return /^[a-fA-F0-9]{24}$/.test(id) ? new ObjectId(id) : null
}

function isDuplicateKey(err: unknown) {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === DUPLICATE_KEY_CODE
}

function toOwned(doc: StoredProjectDoc): OwnedProject {
  return {
    id: doc._id.toHexString(),
    shareSlug: doc.shareSlug,
    name: doc.name,
    siteSpec: doc.siteSpec,
    panelSpec: doc.panelSpec,
    layoutSummary: doc.layoutSummary,
    geometry: doc.geometry,
    estimate: doc.estimate,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  }
}

function toShared(doc: StoredProjectDoc): SharedProject {
  return {
    name: doc.name,
    siteSpec: doc.siteSpec,
    panelSpec: doc.panelSpec,
    layoutSummary: doc.layoutSummary,
    geometry: doc.geometry,
    estimate: doc.estimate,
    updatedAt: doc.updatedAt.toISOString(),
  }
}

export async function createProject(opts: {
  db: Db
  visitorId: string
  input: CreateProjectRequest
}): Promise<CreateProjectResponse> {
  await ensureProjectIndexes(opts.db)
  const coll = projectsCollection(opts.db)
  const now = new Date()

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    const shareSlug = nanoid(SHARE_SLUG_LEN)
    let insertedId: ObjectId
    try {
      const res = await coll.insertOne({
        visitorId: opts.visitorId,
        shareSlug,
        name: opts.input.name ?? "Untitled",
        siteSpec: opts.input.siteSpec ?? null,
        panelSpec: opts.input.panelSpec ?? null,
        layoutSummary: null,
        geometry: null,
        estimate: null,
        createdAt: now,
        updatedAt: now,
      })
      insertedId = res.insertedId
    } catch (err) {
      if (!isDuplicateKey(err)) throw err
      continue
    }
    await enforceVisitorCapBestEffort(coll, opts.visitorId)
    return { projectId: insertedId.toHexString(), shareSlug }
  }
  throw new Error("Could not allocate a unique share slug")
}

export async function getOwnedProject(opts: { db: Db; visitorId: string; id: string }): Promise<OwnedProject | null> {
  const objectId = toObjectId(opts.id)
  if (!objectId) return null
  await ensureProjectIndexes(opts.db)
  const doc = await projectsCollection(opts.db).findOne({ _id: objectId, visitorId: opts.visitorId })
  return doc ? toOwned(doc) : null
}

export async function updateOwnedProject(opts: {
  db: Db
  visitorId: string
  id: string
  patch: UpdateProjectRequest
}): Promise<OwnedProject | null> {
  const objectId = toObjectId(opts.id)
  if (!objectId) return null
  await ensureProjectIndexes(opts.db)
  const coll = projectsCollection(opts.db)

  const set: Partial<ProjectDocFields> = { updatedAt: new Date() }
  const { name, siteSpec, panelSpec, layoutSummary, geometry, estimate } = opts.patch
  if (name !== undefined) set.name = name
  if (siteSpec !== undefined) set.siteSpec = siteSpec
  if (panelSpec !== undefined) set.panelSpec = panelSpec
  if (layoutSummary !== undefined) set.layoutSummary = layoutSummary
  if (geometry !== undefined) set.geometry = geometry
  if (estimate !== undefined) set.estimate = estimate

  const filter = { _id: objectId, visitorId: opts.visitorId }
  const res = await coll.updateOne(filter, { $set: set })
  if (res.matchedCount === 0) return null

  const doc = await coll.findOne(filter)
  return doc ? toOwned(doc) : null
}

export async function getSharedProjectBySlug(opts: { db: Db; slug: string }): Promise<SharedProject | null> {
  await ensureProjectIndexes(opts.db)
  const doc = await projectsCollection(opts.db).findOne({ shareSlug: opts.slug })
  return doc ? toShared(doc) : null
}
