import { ObjectId } from "mongodb"
import { vi } from "vitest"

import type { Db } from "mongodb"

type Doc = Record<string, unknown> & { _id: ObjectId }

let dbCounter = 0

function matches(doc: Doc, filter: Record<string, unknown>) {
  return Object.entries(filter).every(([k, v]) => {
    const actual = doc[k]
    if (v instanceof ObjectId && actual instanceof ObjectId) return v.equals(actual)
    return actual === v
  })
}

function time(v: unknown) {
  return v instanceof Date ? v.getTime() : 0
}

/**
 * In-memory Db fake supporting the subset of Collection used by projects-store. Test helper only.
 * Each fake gets a unique databaseName unless one is given (the store caches index init per name).
 */
export function createFakeDb(databaseName: string = `fake_db_${++dbCounter}`) {
  const docs: Doc[] = []
  const insertErrors: unknown[] = []

  const collection = {
    createIndex: vi.fn(async (_keys?: unknown, _options?: unknown) => "idx"),
    findOne: vi.fn(async (filter: Record<string, unknown>) => {
      const doc = docs.find((d) => matches(d, filter))
      return doc ? { ...doc } : null
    }),
    insertOne: vi.fn(async (doc: Record<string, unknown>) => {
      const err = insertErrors.shift()
      if (err) throw err
      const _id = new ObjectId()
      docs.push({ ...doc, _id })
      return { insertedId: _id }
    }),
    updateOne: vi.fn(async (filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) => {
      const doc = docs.find((d) => matches(d, filter))
      if (!doc) return { matchedCount: 0, modifiedCount: 0 }
      Object.assign(doc, update.$set)
      return { matchedCount: 1, modifiedCount: 1 }
    }),
    /** Supports find(filter).sort(...).skip(n).project(...).toArray(); sorts newest updatedAt first, ties by insertion. */
    find: vi.fn((filter: Record<string, unknown>) => {
      let skipN = 0
      const cursor = {
        sort: () => cursor,
        skip: (n: number) => {
          skipN = n
          return cursor
        },
        project: () => cursor,
        toArray: async () =>
          docs
            .map((d, i) => ({ d, i }))
            .filter(({ d }) => matches(d, filter))
            .sort((a, b) => time(b.d.updatedAt) - time(a.d.updatedAt) || b.i - a.i)
            .slice(skipN)
            .map(({ d }) => ({ ...d })),
      }
      return cursor
    }),
    deleteMany: vi.fn(async (filter: { _id: { $in: ObjectId[] } }) => {
      const ids = filter._id.$in
      let deletedCount = 0
      for (let i = docs.length - 1; i >= 0; i--) {
        if (ids.some((id) => id.equals(docs[i]._id))) {
          docs.splice(i, 1)
          deletedCount++
        }
      }
      return { deletedCount }
    }),
  }

  const command = vi.fn(async (_cmd?: unknown) => ({ ok: 1 }))
  const db = { databaseName, collection: vi.fn(() => collection), command } as unknown as Db
  return { db, collection, command, docs, insertErrors }
}
