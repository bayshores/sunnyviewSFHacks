import { Db, MongoClient } from "mongodb"

const DEFAULT_DB_NAME = "sunnyview"
// Fail fast when the cluster is unreachable instead of waiting out the driver's
// 30s default, which outlives typical serverless function limits.
const SERVER_SELECTION_TIMEOUT_MS = 5_000
const CONNECT_TIMEOUT_MS = 5_000

type MongoCache = {
  uri: string
  clientPromise: Promise<MongoClient>
}

function readMongoUri() {
  return process.env.MONGODB_URI?.trim() ?? ""
}

function readMongoDbName() {
  const raw = process.env.MONGODB_DB?.trim()
  return raw && raw.length > 0 ? raw : DEFAULT_DB_NAME
}

function globalMongoCache() {
  const g = globalThis as unknown as { __sunnyviewMongoCache?: MongoCache }
  return g
}

export function isMongoConfigured() {
  return readMongoUri().length > 0
}

export async function getMongoClient(): Promise<MongoClient | null> {
  const uri = readMongoUri()
  if (!uri) return null

  const g = globalMongoCache()
  if (!g.__sunnyviewMongoCache || g.__sunnyviewMongoCache.uri !== uri) {
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
      connectTimeoutMS: CONNECT_TIMEOUT_MS,
    })
    const clientPromise = client.connect().catch((err) => {
      if (g.__sunnyviewMongoCache?.uri === uri) {
        delete g.__sunnyviewMongoCache
      }
      throw err
    })
    g.__sunnyviewMongoCache = { uri, clientPromise }
  }

  return g.__sunnyviewMongoCache.clientPromise
}

export async function getMongoDb(): Promise<Db | null> {
  const client = await getMongoClient()
  if (!client) return null
  return client.db(readMongoDbName())
}
