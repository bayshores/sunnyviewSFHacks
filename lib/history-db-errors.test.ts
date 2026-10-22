import { MongoServerError } from "mongodb"
import { afterEach, describe, expect, it, vi } from "vitest"

import { logHistoryDbError, mapHistoryDbError } from "@/lib/history-db-errors"

afterEach(() => vi.restoreAllMocks())

describe("mapHistoryDbError", () => {
  it("maps Mongo code 8000 to 503 auth", () => {
    const r = mapHistoryDbError(new MongoServerError({ message: "x", code: 8000 }), "fb")
    expect(r.status).toBe(503)
    expect(r.message).toMatch(/authentication/)
  })

  it.each(["Authentication failed.", "bad auth: nope"])("maps message %s to auth", (m) => {
    expect(mapHistoryDbError(new Error(m), "fb").message).toMatch(/authentication/)
  })

  it.each(["Server selection timed out", "request timed out", "getaddrinfo ENOTFOUND h", "ECONNREFUSED", "Network down"])(
    "maps %s to unavailable",
    (m) => {
      const r = mapHistoryDbError(new Error(m), "fb")
      expect(r.status).toBe(503)
      expect(r.message).toMatch(/unavailable/)
    }
  )

  it("falls back to 500 for other or non-Error values", () => {
    expect(mapHistoryDbError(new Error("weird"), "fb")).toEqual({ status: 500, message: "fb" })
    expect(mapHistoryDbError("string", "fb")).toEqual({ status: 500, message: "fb" })
    expect(mapHistoryDbError(null, "fb")).toEqual({ status: 500, message: "fb" })
  })
})

describe("logHistoryDbError", () => {
  it("logs each error shape without throwing", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    logHistoryDbError("a", new MongoServerError({ message: "m", code: 1, codeName: "N" }))
    logHistoryDbError("b", new TypeError("t"))
    logHistoryDbError("c", 42)
    expect(spy).toHaveBeenCalledTimes(3)
    expect(spy.mock.calls[0][1]).toMatchObject({ code: 1, codeName: "N", message: "m" })
    expect(spy.mock.calls[1][1]).toEqual({ name: "TypeError", message: "t" })
    expect(spy.mock.calls[2][1]).toEqual({ value: 42 })
  })
})
