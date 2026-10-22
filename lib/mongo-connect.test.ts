import { beforeEach, describe, expect, it, vi } from "vitest"

const mongo = vi.hoisted(() => ({ getMongoDb: vi.fn() }))
vi.mock("@/lib/mongo", () => ({ getMongoDb: mongo.getMongoDb }))

import { connectMongo, mongoConnectMessage } from "@/lib/mongo-connect"

beforeEach(() => {
  mongo.getMongoDb.mockReset()
})

describe("connectMongo", () => {
  it("returns the db when connected", async () => {
    const db = { databaseName: "sunnyview" }
    mongo.getMongoDb.mockResolvedValue(db)
    expect(await connectMongo()).toEqual({ ok: true, db })
  })

  it("reports unconfigured when no URI is set", async () => {
    mongo.getMongoDb.mockResolvedValue(null)
    expect(await connectMongo()).toEqual({ ok: false, reason: "unconfigured" })
  })

  it("reports unavailable instead of throwing when the connection fails", async () => {
    const error = new Error("Server selection timed out after 5000 ms")
    mongo.getMongoDb.mockRejectedValue(error)
    const result = await connectMongo()
    expect(result).toMatchObject({ ok: false, reason: "unavailable" })
    expect(!result.ok && result.reason === "unavailable" && result.error).toBe(error)
  })
})

describe("mongoConnectMessage", () => {
  it("keeps the existing not-configured wording", () => {
    expect(mongoConnectMessage("History", "unconfigured")).toBe("History backend is not configured.")
    expect(mongoConnectMessage("Project", "unconfigured")).toBe("Project backend is not configured.")
  })

  it("gives a generic unavailable message without connection details", () => {
    expect(mongoConnectMessage("Project", "unavailable")).toBe(
      "Project backend is temporarily unavailable. Please try again."
    )
  })
})
