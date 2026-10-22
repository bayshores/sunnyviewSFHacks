import { afterEach, describe, expect, it, vi } from "vitest"

import { createFakeDb } from "@/test/projects-fake-db"
import {
  createProject,
  getOwnedProject,
  getSharedProjectBySlug,
  updateOwnedProject,
} from "@/lib/projects-store"

const site = { lat: 37.77, lng: -122.41, tiltDeg: 20, azimuthDeg: 180, lossesPct: 14 }
const panel = { widthM: 1.1, heightM: 1.7, wattW: 400, gapM: 0.02 }

afterEach(() => {
  delete process.env.PROJECTS_TTL_DAYS
  delete process.env.PROJECTS_MAX_PER_VISITOR
})

describe("projects-store", () => {
  it("runs createIndex once per index across distinct Db objects with the same databaseName", async () => {
    const a = createFakeDb("shared_name")
    const b = createFakeDb("shared_name")
    await createProject({ db: a.db, visitorId: "v_a", input: {} })
    await createProject({ db: b.db, visitorId: "v_a", input: {} })
    expect(a.collection.createIndex).toHaveBeenCalledTimes(3)
    expect(b.collection.createIndex).not.toHaveBeenCalled()
  })

  it("retries index init after a failure", async () => {
    const f = createFakeDb("flaky_name")
    f.collection.createIndex.mockRejectedValueOnce(new Error("not authorized"))
    await expect(createProject({ db: f.db, visitorId: "v", input: {} })).rejects.toThrow("not authorized")
    await createProject({ db: f.db, visitorId: "v", input: {} })
    expect(f.collection.createIndex.mock.calls.length).toBeGreaterThanOrEqual(4)
  })

  it("creates a TTL index on updatedAt, default 90 days", async () => {
    const { db, collection } = createFakeDb()
    await createProject({ db, visitorId: "v", input: {} })
    expect(collection.createIndex).toHaveBeenCalledWith({ updatedAt: 1 }, { expireAfterSeconds: 90 * 86_400 })
  })

  it("honors PROJECTS_TTL_DAYS and falls back on invalid values", async () => {
    process.env.PROJECTS_TTL_DAYS = "7"
    const a = createFakeDb()
    await createProject({ db: a.db, visitorId: "v", input: {} })
    expect(a.collection.createIndex).toHaveBeenCalledWith({ updatedAt: 1 }, { expireAfterSeconds: 7 * 86_400 })

    process.env.PROJECTS_TTL_DAYS = "abc"
    const b = createFakeDb()
    await createProject({ db: b.db, visitorId: "v", input: {} })
    expect(b.collection.createIndex).toHaveBeenCalledWith({ updatedAt: 1 }, { expireAfterSeconds: 90 * 86_400 })
  })

  it("TTL index conflict (code 85) falls back to collMod and ensure resolves", async () => {
    process.env.PROJECTS_TTL_DAYS = "7"
    const { db, collection, command } = createFakeDb()
    collection.createIndex.mockImplementation(async (keys?: unknown) => {
      if (JSON.stringify(keys) === JSON.stringify({ updatedAt: 1 })) throw Object.assign(new Error("conflict"), { code: 85 })
      return "idx"
    })
    await expect(createProject({ db, visitorId: "v", input: {} })).resolves.toBeTruthy()
    expect(command).toHaveBeenCalledWith({
      collMod: "projects",
      index: { keyPattern: { updatedAt: 1 }, expireAfterSeconds: 7 * 86_400 },
    })
  })

  it("TTL index conflict (code 86) also uses collMod", async () => {
    const { db, collection, command } = createFakeDb()
    collection.createIndex.mockImplementation(async (keys?: unknown) => {
      if (JSON.stringify(keys) === JSON.stringify({ updatedAt: 1 })) throw Object.assign(new Error("conflict"), { code: 86 })
      return "idx"
    })
    await createProject({ db, visitorId: "v", input: {} })
    expect(command).toHaveBeenCalledTimes(1)
  })

  it("still resolves when collMod fails too, and for other TTL errors without collMod", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const a = createFakeDb()
    a.collection.createIndex.mockImplementation(async (keys?: unknown) => {
      if (JSON.stringify(keys) === JSON.stringify({ updatedAt: 1 })) throw Object.assign(new Error("conflict"), { code: 85 })
      return "idx"
    })
    a.command.mockRejectedValue(new Error("collMod denied"))
    await expect(createProject({ db: a.db, visitorId: "v", input: {} })).resolves.toBeTruthy()

    const b = createFakeDb()
    b.collection.createIndex.mockImplementation(async (keys?: unknown) => {
      if (JSON.stringify(keys) === JSON.stringify({ updatedAt: 1 })) throw new Error("not authorized")
      return "idx"
    })
    await expect(createProject({ db: b.db, visitorId: "v", input: {} })).resolves.toBeTruthy()
    expect(b.command).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it("rejects when the shareSlug unique index fails", async () => {
    const { db, collection } = createFakeDb()
    collection.createIndex.mockRejectedValueOnce(Object.assign(new Error("slug idx"), { code: 85 }))
    await expect(createProject({ db, visitorId: "v", input: {} })).rejects.toThrow("slug idx")
  })

  it("create still resolves when visitor cap cleanup fails after insert", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    process.env.PROJECTS_MAX_PER_VISITOR = "1"
    const { db, collection, docs } = createFakeDb()
    await createProject({ db, visitorId: "v", input: { name: "a" } })
    collection.deleteMany.mockRejectedValueOnce(new Error("transient"))
    const res = await createProject({ db, visitorId: "v", input: { name: "b" } })
    expect(res.projectId).toMatch(/^[a-f0-9]{24}$/)
    expect(collection.insertOne).toHaveBeenCalledTimes(2)
    expect(docs.length).toBe(2)
    vi.restoreAllMocks()
  })

  it("deletes the oldest projects beyond PROJECTS_MAX_PER_VISITOR for that visitor only", async () => {
    process.env.PROJECTS_MAX_PER_VISITOR = "2"
    const { db, docs } = createFakeDb()
    const first = await createProject({ db, visitorId: "v_a", input: { name: "first" } })
    await createProject({ db, visitorId: "v_b", input: { name: "other" } })
    await createProject({ db, visitorId: "v_a", input: { name: "second" } })
    const third = await createProject({ db, visitorId: "v_a", input: { name: "third" } })

    const mine = docs.filter((d) => d.visitorId === "v_a").map((d) => d.name)
    expect(mine).toEqual(["second", "third"])
    expect(docs.some((d) => d.visitorId === "v_b")).toBe(true)
    expect(await getOwnedProject({ db, visitorId: "v_a", id: first.projectId })).toBeNull()
    expect(await getOwnedProject({ db, visitorId: "v_a", id: third.projectId })).not.toBeNull()
  })

  it("defaults the cap to 50 per visitor", async () => {
    const { db, docs } = createFakeDb()
    for (let i = 0; i < 52; i++) await createProject({ db, visitorId: "v", input: {} })
    expect(docs.length).toBe(50)
  })

  it("creates indexes once per db and creates a project with slug", async () => {
    const { db, collection } = createFakeDb()
    const a = await createProject({ db, visitorId: "v_a", input: { siteSpec: site, panelSpec: panel } })
    await createProject({ db, visitorId: "v_a", input: {} })

    expect(a.projectId).toMatch(/^[a-f0-9]{24}$/)
    expect(a.shareSlug.length).toBeGreaterThanOrEqual(10)
    expect(collection.createIndex).toHaveBeenCalledWith({ shareSlug: 1 }, { unique: true })
    expect(collection.createIndex).toHaveBeenCalledTimes(3)
  })

  it("defaults name to Untitled", async () => {
    const { db } = createFakeDb()
    const { projectId } = await createProject({ db, visitorId: "v_a", input: {} })
    const p = await getOwnedProject({ db, visitorId: "v_a", id: projectId })
    expect(p?.name).toBe("Untitled")
    expect(p?.siteSpec).toBeNull()
  })

  it("retries on duplicate slug", async () => {
    const { db, insertErrors, collection } = createFakeDb()
    insertErrors.push(Object.assign(new Error("dup"), { code: 11000 }))
    const res = await createProject({ db, visitorId: "v_a", input: {} })
    expect(res.shareSlug).toBeTruthy()
    expect(collection.insertOne).toHaveBeenCalledTimes(2)
  })

  it("rethrows non-duplicate insert errors", async () => {
    const { db, insertErrors } = createFakeDb()
    insertErrors.push(new Error("boom"))
    await expect(createProject({ db, visitorId: "v_a", input: {} })).rejects.toThrow("boom")
  })

  it("gives up after repeated duplicate slugs", async () => {
    const { db, insertErrors } = createFakeDb()
    for (let i = 0; i < 5; i++) insertErrors.push(Object.assign(new Error("dup"), { code: 11000 }))
    await expect(createProject({ db, visitorId: "v_a", input: {} })).rejects.toThrow()
  })

  it("owner can read, foreign visitor and bad ids get null", async () => {
    const { db } = createFakeDb()
    const { projectId } = await createProject({ db, visitorId: "v_owner", input: { siteSpec: site } })
    const mine = await getOwnedProject({ db, visitorId: "v_owner", id: projectId })
    expect(mine?.id).toBe(projectId)
    expect(mine).not.toHaveProperty("visitorId")
    expect(await getOwnedProject({ db, visitorId: "v_other", id: projectId })).toBeNull()
    expect(await getOwnedProject({ db, visitorId: "v_owner", id: "not-an-id" })).toBeNull()
  })

  it("updates only for the owner and applies given fields", async () => {
    const { db } = createFakeDb()
    const { projectId } = await createProject({ db, visitorId: "v_owner", input: {} })
    expect(await updateOwnedProject({ db, visitorId: "v_other", id: projectId, patch: { name: "x" } })).toBeNull()
    expect(await updateOwnedProject({ db, visitorId: "v_owner", id: "zzz", patch: { name: "x" } })).toBeNull()

    const updated = await updateOwnedProject({
      db,
      visitorId: "v_owner",
      id: projectId,
      patch: { siteSpec: site, name: "Roof" },
    })
    expect(updated?.name).toBe("Roof")
    expect(updated?.siteSpec).toEqual(site)
    expect(updated?.panelSpec).toBeNull()
  })

  it("does not overwrite fields that are undefined in the patch", async () => {
    const { db } = createFakeDb()
    const { projectId } = await createProject({ db, visitorId: "v_owner", input: { panelSpec: panel } })
    const updated = await updateOwnedProject({
      db,
      visitorId: "v_owner",
      id: projectId,
      patch: { siteSpec: site, panelSpec: undefined },
    })
    expect(updated?.panelSpec).toEqual(panel)
  })

  it("shared projection excludes visitorId and ids", async () => {
    const { db } = createFakeDb()
    const { shareSlug } = await createProject({ db, visitorId: "v_owner", input: { siteSpec: site } })
    const shared = await getSharedProjectBySlug({ db, slug: shareSlug })
    expect(shared?.siteSpec).toEqual(site)
    const keys = Object.keys(shared ?? {})
    expect(keys).not.toContain("visitorId")
    expect(keys).not.toContain("id")
    expect(keys).not.toContain("_id")
    expect(keys).not.toContain("shareSlug")
    expect(JSON.stringify(shared)).not.toContain("v_owner")
    expect(await getSharedProjectBySlug({ db, slug: "missingslug123" })).toBeNull()
  })
})
