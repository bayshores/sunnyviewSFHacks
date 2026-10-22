import { afterEach, describe, expect, it, vi } from "vitest"

import { apiOrigin, apiUrl } from "@/lib/api"

afterEach(() => vi.unstubAllEnvs())

describe("api helpers", () => {
  it("returns relative paths without an origin", () => {
    vi.stubEnv("NEXT_PUBLIC_API_ORIGIN", "")
    expect(apiOrigin()).toBe("")
    expect(apiUrl("/api/x")).toBe("/api/x")
    expect(apiUrl("api/x")).toBe("/api/x")
  })

  it("trims whitespace and one trailing slash", () => {
    vi.stubEnv("NEXT_PUBLIC_API_ORIGIN", "  https://api.example.com/ ")
    expect(apiOrigin()).toBe("https://api.example.com")
    expect(apiUrl("/api/x")).toBe("https://api.example.com/api/x")
    expect(apiUrl("api/x")).toBe("https://api.example.com/api/x")
  })
})
