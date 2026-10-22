import { describe, expect, it } from "vitest"

import { asRecord, readKey } from "@/lib/geo/narrow"

describe("narrow", () => {
  it("asRecord accepts plain objects only", () => {
    const o = { a: 1 }
    expect(asRecord(o)).toBe(o)
    expect(asRecord([1])).toBeNull()
    expect(asRecord(null)).toBeNull()
    expect(asRecord("x")).toBeNull()
    expect(asRecord(undefined)).toBeNull()
  })

  it("readKey reads from objects and tolerates non-objects", () => {
    expect(readKey({ a: 2 }, "a")).toBe(2)
    expect(readKey(null, "a")).toBeUndefined()
    expect(readKey("str", "length")).toBeUndefined()
  })
})
