import { afterEach, describe, expect, it, vi } from "vitest"

import { createProject, getSharedProject, ProjectsApiError, updateProject } from "@/lib/projects-api"

function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl)
  vi.stubGlobal("fetch", fn)
  return fn
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe("projects-api", () => {
  it("createProject posts same-origin and returns ids", async () => {
    const f = mockFetch(async () => json({ projectId: "p1", shareSlug: "slug1234567" }, 201))
    const res = await createProject({ name: "Untitled" })
    expect(res).toEqual({ projectId: "p1", shareSlug: "slug1234567" })
    expect(f.mock.calls[0][0]).toBe("/api/projects")
    expect(f.mock.calls[0][1].method).toBe("POST")
    expect(f.mock.calls[0][1].credentials).toBe("include")
  })

  it("honours NEXT_PUBLIC_API_ORIGIN via apiUrl", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_ORIGIN", "https://api.example.com/")
    const f = mockFetch(async () => json({ project: { name: "x" } }))
    await getSharedProject("abc")
    expect(f.mock.calls[0][0]).toBe("https://api.example.com/api/share/abc")
  })

  it("updateProject encodes the id and returns the project", async () => {
    const f = mockFetch(async () => json({ project: { id: "a/b" } }))
    const p = await updateProject("a/b", { name: "n" })
    expect(p.id).toBe("a/b")
    expect(f.mock.calls[0][0]).toBe("/api/projects/a%2Fb")
    expect(f.mock.calls[0][1].method).toBe("PATCH")
  })

  it("maps statuses to user-safe errors", async () => {
    mockFetch(async () => json({ error: "internal secret" }, 404))
    const err = await getSharedProject("zzz").catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProjectsApiError)
    expect((err as ProjectsApiError).status).toBe(404)
    expect((err as Error).message).not.toContain("secret")

    mockFetch(async () => json({}, 503))
    await expect(createProject({})).rejects.toThrow(/not available/i)
    mockFetch(async () => json({}, 429))
    await expect(updateProject("a", { name: "n" })).rejects.toThrow(/too many/i)
    mockFetch(async () => json({}, 413))
    await expect(updateProject("a", { name: "n" })).rejects.toThrow(/too large/i)
    mockFetch(async () => json({}, 500))
    await expect(createProject({})).rejects.toThrow("Could not create the project.")
  })

  it("wraps network failures and malformed responses", async () => {
    mockFetch(async () => {
      throw new TypeError("Failed to fetch")
    })
    const err = await createProject({}).catch((e: unknown) => e)
    expect((err as ProjectsApiError).status).toBe(0)

    mockFetch(async () => json({ nope: true }))
    await expect(createProject({})).rejects.toThrow(/unexpected response/i)
    await expect(getSharedProject("abc")).rejects.toThrow(/unexpected response/i)
    mockFetch(async () => new Response("<html>", { status: 200 }))
    await expect(updateProject("a", { name: "n" })).rejects.toThrow(/unexpected response/i)
  })
})
