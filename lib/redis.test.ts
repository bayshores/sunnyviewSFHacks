import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const redisCtor = vi.hoisted(() => vi.fn())

beforeEach(() => {
  vi.resetModules()
  redisCtor.mockReset()
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "")
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "")
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.doUnmock("@upstash/redis")
})

describe("getRedis", () => {
  it("returns null without env", async () => {
    const { getRedis } = await import("@/lib/redis")
    expect(await getRedis()).toBeNull()
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://r")
    expect(await getRedis()).toBeNull()
  })

  it("constructs once with trimmed env and caches the promise", async () => {
    vi.doMock("@upstash/redis", () => ({
      Redis: class {
        constructor(opts: unknown) {
          redisCtor(opts)
        }
      },
    }))
    vi.stubEnv("UPSTASH_REDIS_REST_URL", " https://r ")
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", " tok ")
    const { getRedis } = await import("@/lib/redis")
    const a = await getRedis()
    const b = await getRedis()
    expect(a).not.toBeNull()
    expect(b).toBe(a)
    expect(redisCtor).toHaveBeenCalledTimes(1)
    expect(redisCtor).toHaveBeenCalledWith({ url: "https://r", token: "tok" })
  })

  it("returns null when the module has no Redis export", async () => {
    vi.doMock("@upstash/redis", () => ({}))
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://r")
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "t")
    const { getRedis } = await import("@/lib/redis")
    expect(await getRedis()).toBeNull()
  })

  it("returns null when the import or constructor throws", async () => {
    vi.doMock("@upstash/redis", () => ({
      Redis: class {
        constructor() {
          throw new Error("bad")
        }
      },
    }))
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://r")
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "t")
    const { getRedis } = await import("@/lib/redis")
    expect(await getRedis()).toBeNull()
  })
})
