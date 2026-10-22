import { ObjectId } from "mongodb"
import { vi } from "vitest"

import type { Db } from "mongodb"

type Doc = Record<string, any> & { _id: ObjectId }

function matches(doc: Doc, filter: Record<string, any>) {
  return Object.entries(filter).every(([k, v]) => {
    const actual = doc[k]
    if (v && typeof v === "object" && Array.isArray(v.$in)) {
      return v.$in.some((x: unknown) => (x instanceof ObjectId && actual instanceof ObjectId ? x.equals(actual) : x === actual))
    }
    if (v instanceof ObjectId && actual instanceof ObjectId) return v.equals(actual)
    return actual === v
  })
}

function cursor(rows: Doc[]) {
  let list = rows
  const c = {
    sort(spec: Record<string, 1 | -1>) {
      list = [...list].sort((a, b) => {
        for (const [k, dir] of Object.entries(spec)) {
          const av = a[k] instanceof Date ? a[k].getTime() : Number(a[k])
          const bv = b[k] instanceof Date ? b[k].getTime() : Number(b[k])
          if (av !== bv) return (av - bv) * dir
        }
        return 0
      })
      return c
    },
    skip(n: number) {
      list = list.slice(n)
      return c
    },
    limit(n: number) {
      list = list.slice(0, n)
      return c
    },
    project() {
      return c
    },
    toArray: async () => list.map((d) => ({ ...d })),
  }
  return c
}

/** In-memory Db fake for lib/history-store. Test helper only. */
export function createHistoryFakeDb() {
  const docs: Doc[] = []
  const collection = {
    createIndex: vi.fn(async () => "idx"),
    find: vi.fn((filter: Record<string, any>) => cursor(docs.filter((d) => matches(d, filter)))),
    findOne: vi.fn(async (filter: Record<string, any>) => {
      const d = docs.find((x) => matches(x, filter))
      return d ? { ...d } : null
    }),
    insertOne: vi.fn(async (doc: Record<string, any>) => {
      const _id = new ObjectId()
      docs.push({ ...doc, _id })
      return { insertedId: _id }
    }),
    updateOne: vi.fn(async (filter: Record<string, any>, update: { $set: Record<string, any> }) => {
      const d = docs.find((x) => matches(x, filter))
      if (d) Object.assign(d, update.$set)
      return { matchedCount: d ? 1 : 0 }
    }),
    deleteOne: vi.fn(async (filter: Record<string, any>) => {
      const i = docs.findIndex((x) => matches(x, filter))
      if (i >= 0) docs.splice(i, 1)
      return { deletedCount: i >= 0 ? 1 : 0 }
    }),
    deleteMany: vi.fn(async (filter: Record<string, any>) => {
      const before = docs.length
      for (let i = docs.length - 1; i >= 0; i--) if (matches(docs[i], filter)) docs.splice(i, 1)
      return { deletedCount: before - docs.length }
    }),
  }
  const db = { collection: vi.fn(() => collection) } as unknown as Db
  return { db, collection, docs }
}

export const SNAPSHOT = {
  mode: "address" as const,
  address: "1 Market St",
  lat: 37.7749,
  lng: -122.4194,
  zoom: 19,
  mPerPx: 0.1,
  siteSpec: { tiltDeg: 20, azimuthDeg: 180, lossesPct: 14 },
  panelSpec: { widthM: 1.1, heightM: 1.7, wattW: 400, gapM: 0.02 },
  layoutSummary: { orientationDeg: 0, panelCount: 10, dcKw: 4 },
  geometry: {
    vertices: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ],
    closed: true,
    mPerPx: 0.1,
    zoom: 19,
  },
  estimate: null,
}

export const SUMMARY = {
  address: "1 Market St",
  panelCount: 10,
  dcKw: 4,
  annualKwh: null,
  annualCo2Kg: null,
  lat: 37.7749,
  lng: -122.4194,
}
