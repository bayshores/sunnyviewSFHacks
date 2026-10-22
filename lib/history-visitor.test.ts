import { NextRequest, NextResponse } from "next/server"
import { afterEach, describe, expect, it, vi } from "vitest"

import { attachVisitorCookie, getOrCreateVisitorContext } from "@/lib/history-visitor"

const req = (cookie?: string) =>
  new NextRequest("http://localhost/api/history", { headers: cookie ? { cookie } : {} })

afterEach(() => vi.unstubAllEnvs())

describe("getOrCreateVisitorContext", () => {
  it("reuses a valid cookie", () => {
    const id = "abcdefghijklmnop1234"
    expect(getOrCreateVisitorContext(req(`sv_vid=${id}`))).toEqual({
      visitorId: id,
      cookieName: "sv_vid",
      shouldSetCookie: false,
    })
  })

  it.each(["short", "has space!!!!!!!!!!!!!!", "x".repeat(121), ""])("replaces invalid cookie %j", (v) => {
    const ctx = getOrCreateVisitorContext(req(v ? `sv_vid=${encodeURIComponent(v)}` : undefined))
    expect(ctx.shouldSetCookie).toBe(true)
    expect(ctx.visitorId).toMatch(/^v_[0-9a-f]{32}$/)
  })

  it("generates distinct ids and honours cookie name override (blank falls back)", () => {
    vi.stubEnv("HISTORY_COOKIE_NAME", " custom ")
    const a = getOrCreateVisitorContext(req())
    expect(a.cookieName).toBe("custom")
    expect(a.visitorId).not.toBe(getOrCreateVisitorContext(req()).visitorId)
    vi.stubEnv("HISTORY_COOKIE_NAME", "   ")
    expect(getOrCreateVisitorContext(req()).cookieName).toBe("sv_vid")
  })
})

describe("attachVisitorCookie", () => {
  const ctx = { visitorId: "v_abcdefghijklmnop", cookieName: "sv_vid", shouldSetCookie: true }

  it("does nothing when the cookie should not be set", () => {
    const res = attachVisitorCookie(NextResponse.json({}), { ...ctx, shouldSetCookie: false })
    expect(res.cookies.get("sv_vid")).toBeUndefined()
  })

  it("sets secure httpOnly cookie in production with default max age", () => {
    vi.stubEnv("NODE_ENV", "production")
    const c = attachVisitorCookie(NextResponse.json({}), ctx).cookies.get("sv_vid")
    expect(c).toMatchObject({
      value: ctx.visitorId,
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/",
      maxAge: 365 * 86400,
    })
  })

  it("is not secure outside production and respects max-age env", () => {
    vi.stubEnv("NODE_ENV", "development")
    vi.stubEnv("HISTORY_COOKIE_MAX_AGE_DAYS", "2")
    const c = attachVisitorCookie(NextResponse.json({}), ctx).cookies.get("sv_vid")
    expect(c?.secure).toBeFalsy()
    expect(c?.maxAge).toBe(2 * 86400)
    vi.stubEnv("HISTORY_COOKIE_MAX_AGE_DAYS", "-1")
    expect(attachVisitorCookie(NextResponse.json({}), ctx).cookies.get("sv_vid")?.maxAge).toBe(365 * 86400)
  })
})
