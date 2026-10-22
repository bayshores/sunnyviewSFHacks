import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  connect: vi.fn(),
  db: vi.fn(),
  ctor: vi.fn(),
  options: vi.fn(),
}))

vi.mock("mongodb", () => ({
  MongoClient: class {
    constructor(uri: string, options?: unknown) {
      state.ctor(uri)
      state.options(options)
    }
    connect() {
      return state.connect()
    }
    db(name: string) {
      return state.db(name)
    }
  },
}))

import { getMongoClient, getMongoDb, isMongoConfigured } from "@/lib/mongo"

beforeEach(() => {
  delete (globalThis as any).__sunnyviewMongoCache
  state.connect.mockReset()
  state.db.mockReset()
  state.ctor.mockReset()
  state.options.mockReset()
  vi.stubEnv("MONGODB_URI", "")
  vi.stubEnv("MONGODB_DB", "")
})
afterEach(() => vi.unstubAllEnvs())

describe("mongo", () => {
  it("returns null when no URI is configured", async () => {
    expect(isMongoConfigured()).toBe(false)
    expect(await getMongoClient()).toBeNull()
    expect(await getMongoDb()).toBeNull()
    expect(state.ctor).not.toHaveBeenCalled()
  })

  it("caches the client per URI and rebuilds when the URI changes", async () => {
    vi.stubEnv("MONGODB_URI", "mongodb://a")
    const clientA = { id: "a" }
    state.connect.mockResolvedValue(clientA)
    expect(isMongoConfigured()).toBe(true)
    expect(await getMongoClient()).toBe(clientA)
    expect(await getMongoClient()).toBe(clientA)
    expect(state.ctor).toHaveBeenCalledTimes(1)

    vi.stubEnv("MONGODB_URI", "mongodb://b")
    await getMongoClient()
    expect(state.ctor).toHaveBeenCalledTimes(2)
    expect(state.ctor).toHaveBeenLastCalledWith("mongodb://b")
  })

  it("clears the cache after a failed connect so the next call retries", async () => {
    vi.stubEnv("MONGODB_URI", "mongodb://a")
    state.connect.mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce({ ok: true })
    await expect(getMongoClient()).rejects.toThrow("down")
    expect(await getMongoClient()).toEqual({ ok: true })
    expect(state.ctor).toHaveBeenCalledTimes(2)
  })

  it("uses short connection timeouts so an unreachable cluster fails fast", async () => {
    vi.stubEnv("MONGODB_URI", "mongodb://a")
    state.connect.mockResolvedValue({ ok: true })
    await getMongoClient()
    expect(state.options).toHaveBeenCalledWith(
      expect.objectContaining({ serverSelectionTimeoutMS: 5_000, connectTimeoutMS: 5_000 })
    )
  })

  it("selects the default or configured database", async () => {
    vi.stubEnv("MONGODB_URI", "mongodb://a")
    state.connect.mockResolvedValue({ db: state.db })
    state.db.mockReturnValue("DB")
    expect(await getMongoDb()).toBe("DB")
    expect(state.db).toHaveBeenLastCalledWith("sunnyview")
    vi.stubEnv("MONGODB_DB", " custom ")
    await getMongoDb()
    expect(state.db).toHaveBeenLastCalledWith("custom")
  })
})
