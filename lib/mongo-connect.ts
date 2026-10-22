import type { Db } from "mongodb"

import { getMongoDb } from "@/lib/mongo"

export type MongoConnection =
  | { ok: true; db: Db }
  | { ok: false; reason: "unconfigured" }
  | { ok: false; reason: "unavailable"; error: unknown }

export type MongoBackend = "History" | "Project"

/**
 * Resolve the Mongo database without throwing. A missing MONGODB_URI is
 * "unconfigured"; any connection failure (bad URI, auth, network, timeout) is
 * "unavailable" so routes can answer 503 instead of crashing.
 */
export async function connectMongo(): Promise<MongoConnection> {
  try {
    const db = await getMongoDb()
    return db ? { ok: true, db } : { ok: false, reason: "unconfigured" }
  } catch (error) {
    return { ok: false, reason: "unavailable", error }
  }
}

export function mongoConnectMessage(backend: MongoBackend, reason: "unconfigured" | "unavailable"): string {
  return reason === "unconfigured"
    ? `${backend} backend is not configured.`
    : `${backend} backend is temporarily unavailable. Please try again.`
}
