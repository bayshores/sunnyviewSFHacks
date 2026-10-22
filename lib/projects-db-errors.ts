import { logHistoryDbError, mapHistoryDbError } from "@/lib/history-db-errors"

const UNAVAILABLE_MESSAGE = "Project backend is temporarily unavailable. Please try again."

/**
 * Callers are unauthenticated, so never reveal why the backend is down
 * (e.g. bad MongoDB credentials). The specific reason goes to server logs only
 * via logProjectsDbError.
 */
export function mapProjectsDbError(err: unknown, fallback: string) {
  const mapped = mapHistoryDbError(err, fallback)
  if (mapped.status === 503) return { status: 503, message: UNAVAILABLE_MESSAGE }
  return mapped
}

export function logProjectsDbError(scope: string, err: unknown) {
  logHistoryDbError(`projects:${scope}`, err)
}
