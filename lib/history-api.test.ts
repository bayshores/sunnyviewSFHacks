import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { getHistoryEntry, listHistory, patchHistory, removeHistory, saveHistory } from "@/lib/history-api"
import { SNAPSHOT, SUMMARY } from "@/test/history-fake-db"

const fetchMock = vi.fn()
beforeEach(() => vi.stubGlobal("fetch", fetchMock))
afterEach(() => {
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const bad = (status = 500) => new Response("not json", { status })

describe("listHistory", () => {
  it("requests with limit and returns items", async () => {
    fetchMock.mockResolvedValue(json({ items: [{ id: "1" }] }))
    expect(await listHistory(5)).toEqual([{ id: "1" }])
    expect(fetchMock.mock.calls[0][0]).toBe("/api/history?limit=5")
  })
  it("defaults to 100 and tolerates a missing items array", async () => {
    fetchMock.mockResolvedValue(json({}))
    expect(await listHistory()).toEqual([])
    expect(fetchMock.mock.calls[0][0]).toBe("/api/history?limit=100")
  })
  it("throws server error message, else fallback", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: "nope" }, 503))
    await expect(listHistory()).rejects.toThrow("nope")
    fetchMock.mockResolvedValueOnce(bad())
    await expect(listHistory()).rejects.toThrow("Failed to list history")
    fetchMock.mockResolvedValueOnce(json({ error: 5 }, 500))
    await expect(listHistory()).rejects.toThrow("Failed to list history")
  })
})

describe("saveHistory", () => {
  const input = { snapshot: SNAPSHOT, summary: SUMMARY }
  it("posts JSON and returns the item", async () => {
    fetchMock.mockResolvedValue(json({ item: { id: "a" } }))
    expect(await saveHistory(input)).toEqual({ id: "a" })
    const init = fetchMock.mock.calls[0][1]
    expect(init.method).toBe("POST")
    expect(JSON.parse(init.body)).toEqual(input)
  })
  it("throws on !ok or missing item", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: "bad" }, 400))
    await expect(saveHistory(input)).rejects.toThrow("bad")
    fetchMock.mockResolvedValueOnce(json({}))
    await expect(saveHistory(input)).rejects.toThrow("Failed to save history")
  })
})

describe("getHistoryEntry", () => {
  it("encodes the id", async () => {
    fetchMock.mockResolvedValue(json({ item: { id: "a/b" } }))
    await getHistoryEntry("a/b")
    expect(fetchMock.mock.calls[0][0]).toBe("/api/history/a%2Fb")
  })
  it("throws", async () => {
    fetchMock.mockResolvedValue(bad(404))
    await expect(getHistoryEntry("x")).rejects.toThrow("Failed to load history entry")
  })
})

describe("patchHistory", () => {
  it("sends PATCH", async () => {
    fetchMock.mockResolvedValue(json({ item: { id: "a" } }))
    expect(await patchHistory("a", { pinned: true })).toEqual({ id: "a" })
    expect(fetchMock.mock.calls[0][1].method).toBe("PATCH")
  })
  it("throws", async () => {
    fetchMock.mockResolvedValue(json({ error: "e" }, 400))
    await expect(patchHistory("a", {})).rejects.toThrow("e")
    fetchMock.mockResolvedValue(json({}))
    await expect(patchHistory("a", {})).rejects.toThrow("Failed to update history entry")
  })
})

describe("removeHistory", () => {
  it("resolves on ok", async () => {
    fetchMock.mockResolvedValue(json({ ok: true }))
    await expect(removeHistory("a")).resolves.toBeUndefined()
    expect(fetchMock.mock.calls[0][1].method).toBe("DELETE")
  })
  it("throws message or fallback", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: "gone" }, 404))
    await expect(removeHistory("a")).rejects.toThrow("gone")
    fetchMock.mockResolvedValueOnce(bad(500))
    await expect(removeHistory("a")).rejects.toThrow("Failed to delete history entry")
  })
})
