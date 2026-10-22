import { apiUrl } from "@/lib/api"
import type {
  CreateProjectRequest,
  CreateProjectResponse,
  OwnedProject,
  SharedProject,
  UpdateProjectRequest,
} from "@/lib/projects-types"

export type {
  CreateProjectRequest,
  CreateProjectResponse,
  OwnedProject,
  SharedProject,
  UpdateProjectRequest,
} from "@/lib/projects-types"

/** Error carrying the HTTP status (0 for network failures) with a user-safe message. */
export class ProjectsApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "ProjectsApiError"
    this.status = status
  }
}

const NETWORK_MESSAGE = "Could not reach the project service. Check your connection and try again."

function statusMessage(status: number, fallback: string): string {
  if (status === 404) return "Project not found."
  if (status === 413) return "Project data is too large to save."
  if (status === 429) return "Too many requests. Please wait a moment and try again."
  if (status === 503) return "Project storage is not available right now."
  return fallback
}

async function requestJson<T>(path: string, init: RequestInit, fallback: string): Promise<T> {
  let res: Response
  try {
    res = await fetch(apiUrl(path), {
      ...init,
      credentials: "include",
      headers: { accept: "application/json", ...(init.headers ?? {}) },
    })
  } catch {
    throw new ProjectsApiError(NETWORK_MESSAGE, 0)
  }

  if (!res.ok) throw new ProjectsApiError(statusMessage(res.status, fallback), res.status)

  const data = (await res.json().catch(() => null)) as T | null
  if (data === null || typeof data !== "object") {
    throw new ProjectsApiError("The project service returned an unexpected response.", res.status)
  }
  return data
}

export async function createProject(input: CreateProjectRequest): Promise<CreateProjectResponse> {
  const data = await requestJson<Partial<CreateProjectResponse>>(
    "/api/projects",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) },
    "Could not create the project."
  )
  if (typeof data.projectId !== "string" || typeof data.shareSlug !== "string") {
    throw new ProjectsApiError("The project service returned an unexpected response.", 200)
  }
  return { projectId: data.projectId, shareSlug: data.shareSlug }
}

export async function updateProject(projectId: string, patch: UpdateProjectRequest): Promise<OwnedProject> {
  const data = await requestJson<{ project?: OwnedProject }>(
    `/api/projects/${encodeURIComponent(projectId)}`,
    { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) },
    "Could not save the project."
  )
  if (!data.project) throw new ProjectsApiError("The project service returned an unexpected response.", 200)
  return data.project
}

export async function getSharedProject(shareSlug: string): Promise<SharedProject> {
  const data = await requestJson<{ project?: SharedProject }>(
    `/api/share/${encodeURIComponent(shareSlug)}`,
    { method: "GET" },
    "Could not load the shared project."
  )
  if (!data.project) throw new ProjectsApiError("The project service returned an unexpected response.", 200)
  return data.project
}
