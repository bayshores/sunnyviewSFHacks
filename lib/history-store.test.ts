import { ObjectId } from "mongodb"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { SNAPSHOT, SUMMARY, createHistoryFakeDb } from "@/test/history-fake-db"

type Store = typeof import("@/lib/history-store")
let store: Store
const V = "v_visitorvisitorvisitor"

beforeEach(async () => {
  vi.resetModules()
  store = await import("@/lib/history-store")
})
afterEach(() => vi.unstubAllEnvs())

const snap = (over: Record<string, unknown> = {}) => ({ ...SNAPSHOT, ...over })

describe("buildHistoryQueryHash", () => {
  it("is stable for near-identical snapshots and differs for real changes", () => {
    const a = store.buildHistoryQueryHash(snap())
    const b = store.buildHistoryQueryHash(snap({ lat: SNAPSHOT.lat + 1e-9, address: "  1 MARKET st ", zoom: 19.2 }))
    expect(a).toMatch(/^[0-9a-f]{40}$/)
    expect(b).toBe(a)
    expect(store.buildHistoryQueryHash(snap({ lat: 38 }))).not.toBe(a)
    expect(store.buildHistoryQueryHash(snap({ address: null }))).not.toBe(a)
  })
})

describe("ensureHistoryIndexes", () => {
  it("runs once per module and retries after a failure", async () => {
    const { db, collection } = createHistoryFakeDb()
    await store.ensureHistoryIndexes(db)
    await store.ensureHistoryIndexes(db)
    expect(collection.createIndex).toHaveBeenCalledTimes(2)

    vi.resetModules()
    store = await import("@/lib/history-store")
    const f = createHistoryFakeDb()
    f.collection.createIndex.mockRejectedValueOnce(new Error("boom"))
    await expect(store.ensureHistoryIndexes(f.db)).rejects.toThrow("boom")
    await expect(store.ensureHistoryIndexes(f.db)).resolves.toBeUndefined()
    expect(f.collection.createIndex).toHaveBeenCalledTimes(3)
  })
})

describe("upsertHistoryEntry", () => {
  it("inserts with normalised title fallbacks", async () => {
    const { db, docs } = createHistoryFakeDb()
    const e = await store.upsertHistoryEntry({ db, visitorId: V, input: { snapshot: SNAPSHOT, summary: SUMMARY } })
    expect(e.title).toBe("1 Market St")
    expect(e.note).toBeNull()
    expect(e.pinned).toBe(false)
    expect(e.snapshot).toEqual(SNAPSHOT)
    expect(docs).toHaveLength(1)

    const noAddr = await store.upsertHistoryEntry({
      db,
      visitorId: V,
      input: { snapshot: snap({ address: "   ", lat: 1.5, lng: 2.25 }), summary: SUMMARY },
    })
    expect(noAddr.title).toBe("1.50000, 2.25000")
  })

  it("trims and truncates title/note, honours pinned", async () => {
    const { db } = createHistoryFakeDb()
    const e = await store.upsertHistoryEntry({
      db,
      visitorId: V,
      input: { snapshot: SNAPSHOT, summary: SUMMARY, title: ` ${"t".repeat(100)} `, note: "n".repeat(600), pinned: true },
    })
    expect(e.title).toHaveLength(80)
    expect(e.note).toHaveLength(500)
    expect(e.pinned).toBe(true)
  })

  it("updates the existing entry with the same queryHash", async () => {
    const { db, docs } = createHistoryFakeDb()
    const first = await store.upsertHistoryEntry({
      db,
      visitorId: V,
      input: { snapshot: SNAPSHOT, summary: SUMMARY, title: "A", note: "keep", pinned: true },
    })
    const again = await store.upsertHistoryEntry({ db, visitorId: V, input: { snapshot: SNAPSHOT, summary: SUMMARY } })
    expect(docs).toHaveLength(1)
    expect(again.id).toBe(first.id)
    expect(again).toMatchObject({ title: "A", note: "keep", pinned: true })

    const edited = await store.upsertHistoryEntry({
      db,
      visitorId: V,
      input: { snapshot: SNAPSHOT, summary: SUMMARY, title: "", note: "  ", pinned: false },
    })
    expect(edited).toMatchObject({ title: "1 Market St", note: null, pinned: false })
  })

  it("does not share entries between visitors", async () => {
    const { db, docs } = createHistoryFakeDb()
    await store.upsertHistoryEntry({ db, visitorId: V, input: { snapshot: SNAPSHOT, summary: SUMMARY } })
    await store.upsertHistoryEntry({ db, visitorId: "other", input: { snapshot: SNAPSHOT, summary: SUMMARY } })
    expect(docs).toHaveLength(2)
  })

  it("throws when the inserted/updated document cannot be re-read", async () => {
    const { db, collection } = createHistoryFakeDb()
    collection.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null)
    await expect(
      store.upsertHistoryEntry({ db, visitorId: V, input: { snapshot: SNAPSHOT, summary: SUMMARY } })
    ).rejects.toThrow("History insert failed")

    const f = createHistoryFakeDb()
    await store.upsertHistoryEntry({ db: f.db, visitorId: V, input: { snapshot: SNAPSHOT, summary: SUMMARY } })
    f.collection.findOne
      .mockImplementationOnce(async () => ({ ...f.docs[0] }))
      .mockImplementationOnce(async () => null)
    await expect(
      store.upsertHistoryEntry({ db: f.db, visitorId: V, input: { snapshot: SNAPSHOT, summary: SUMMARY } })
    ).rejects.toThrow("History update failed")
  })

  it("enforces retention, deleting the oldest beyond the limit", async () => {
    vi.stubEnv("HISTORY_RETENTION_MAX", "2")
    const { db, docs } = createHistoryFakeDb()
    vi.useFakeTimers()
    try {
      for (let i = 0; i < 4; i++) {
        vi.setSystemTime(new Date(2024, 0, 1, 0, 0, i))
        await store.upsertHistoryEntry({ db, visitorId: V, input: { snapshot: snap({ lat: 10 + i }), summary: SUMMARY } })
      }
    } finally {
      vi.useRealTimers()
    }
    expect(docs).toHaveLength(2)
    expect(docs.map((d) => d.snapshot.lat).sort()).toEqual([12, 13])
  })

  it("falls back to 100 for invalid retention env and caps at 300 (visible via list limit clamp)", async () => {
    const { db, collection } = createHistoryFakeDb()
    const limitSeen = async (raw: string) => {
      vi.stubEnv("HISTORY_RETENTION_MAX", raw)
      const spy = vi.fn()
      collection.find.mockImplementationOnce(() => {
        const c: any = {
          sort: () => c,
          limit: (n: number) => (spy(n), c),
          toArray: async () => [],
        }
        return c
      })
      await store.listHistoryEntries({ db, visitorId: V, limit: 1000 })
      return spy.mock.calls[0][0]
    }
    expect(await limitSeen("abc")).toBe(100)
    expect(await limitSeen("-5")).toBe(100)
    expect(await limitSeen("9999")).toBe(300)
    expect(await limitSeen("7.4")).toBe(7)
  })
})

describe("listHistoryEntries", () => {
  it("sorts pinned first then recent, applies limit", async () => {
    const { db, docs } = createHistoryFakeDb()
    vi.useFakeTimers()
    try {
      for (let i = 0; i < 3; i++) {
        vi.setSystemTime(new Date(2024, 0, 1, 0, 0, i))
        await store.upsertHistoryEntry({
          db,
          visitorId: V,
          input: { snapshot: snap({ lat: 20 + i }), summary: SUMMARY, title: `t${i}`, pinned: i === 0 },
        })
      }
    } finally {
      vi.useRealTimers()
    }
    expect(docs).toHaveLength(3)
    const all = await store.listHistoryEntries({ db, visitorId: V, limit: 10 })
    expect(all.map((x) => x.title)).toEqual(["t0", "t2", "t1"])
    expect(typeof all[0].createdAt).toBe("string")
    expect(await store.listHistoryEntries({ db, visitorId: V, limit: 0 })).toHaveLength(1)
    expect(await store.listHistoryEntries({ db, visitorId: "nobody", limit: 10 })).toEqual([])
  })
})

describe("get / patch / delete", () => {
  async function seeded() {
    const f = createHistoryFakeDb()
    const e = await store.upsertHistoryEntry({
      db: f.db,
      visitorId: V,
      input: { snapshot: SNAPSHOT, summary: SUMMARY, title: "Orig", note: "n" },
    })
    return { ...f, e }
  }

  it("get returns entry, null for bad id, missing id, or foreign visitor", async () => {
    const { db, e } = await seeded()
    expect((await store.getHistoryEntry({ db, visitorId: V, id: e.id }))?.snapshot).toEqual(SNAPSHOT)
    expect(await store.getHistoryEntry({ db, visitorId: V, id: "nope" })).toBeNull()
    expect(await store.getHistoryEntry({ db, visitorId: V, id: new ObjectId().toHexString() })).toBeNull()
    expect(await store.getHistoryEntry({ db, visitorId: "other", id: e.id })).toBeNull()
  })

  it("patch updates only provided fields", async () => {
    const { db, e } = await seeded()
    const a = await store.patchHistoryMetadata({ db, visitorId: V, id: e.id, patch: { pinned: true } })
    expect(a).toMatchObject({ title: "Orig", note: "n", pinned: true })
    const b = await store.patchHistoryMetadata({ db, visitorId: V, id: e.id, patch: { title: "New", note: "" } })
    expect(b).toMatchObject({ title: "New", note: null, pinned: true })
    const c = await store.patchHistoryMetadata({ db, visitorId: V, id: e.id, patch: { title: "  " } })
    expect(c?.title).toBe("1 Market St")
  })

  it("patch returns null for bad id, foreign visitor, or vanished doc", async () => {
    const { db, collection, docs, e } = await seeded()
    expect(await store.patchHistoryMetadata({ db, visitorId: V, id: "bad", patch: { pinned: true } })).toBeNull()
    expect(await store.patchHistoryMetadata({ db, visitorId: "other", id: e.id, patch: { pinned: true } })).toBeNull()
    const snapshotDoc = { ...docs[0] }
    collection.findOne.mockResolvedValueOnce(snapshotDoc).mockResolvedValueOnce(null)
    expect(await store.patchHistoryMetadata({ db, visitorId: V, id: e.id, patch: { pinned: true } })).toBeNull()
  })

  it("delete handles bad id, foreign visitor, success", async () => {
    const { db, docs, e } = await seeded()
    expect(await store.deleteHistoryEntry({ db, visitorId: V, id: "bad" })).toBe(false)
    expect(await store.deleteHistoryEntry({ db, visitorId: "other", id: e.id })).toBe(false)
    expect(await store.deleteHistoryEntry({ db, visitorId: V, id: e.id })).toBe(true)
    expect(docs).toHaveLength(0)
  })
})
