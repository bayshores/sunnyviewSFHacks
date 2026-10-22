import { apiOrigin } from "@/lib/api";

export const ELEVENLABS_KEY_STORAGE = "sunnyview-elevenlabs-api-key-v1";
export const ELEVENLABS_VOICE_STORAGE = "sunnyview-elevenlabs-voice-id-v1";
export const GEMINI_KEY_STORAGE = "sunnyview-gemini-api-key-v1";

export const ELEVENLABS_KEY_WITHHELD_NOTICE =
  "ElevenLabs key is stored locally, but this app is configured to use an external backend (NEXT_PUBLIC_API_ORIGIN). For safety, the key is not sent. Set ELEVENLABS_API_KEY on the backend instead.";

export const GEMINI_KEY_WITHHELD_NOTICE =
  "Gemini key is stored locally, but this app is configured to use an external backend (NEXT_PUBLIC_API_ORIGIN). For safety, the key is not sent. Set GEMINI_API_KEY on the backend instead.";

/** True when API requests go to the page's own origin (no backend override, or the same one). */
export function isSameOriginBackend(backendOrigin: string, pageOrigin: string): boolean {
  return backendOrigin.length === 0 || backendOrigin === pageOrigin;
}

function currentPageOrigin(): string {
  try {
    return window.location.origin;
  } catch {
    return "";
  }
}

/** Whether browser-held secrets may be attached to requests built with `apiUrl()`. */
export function apiRequestsAreSameOrigin(): boolean {
  return isSameOriginBackend(apiOrigin(), currentPageOrigin());
}

/** Read and trim a localStorage value; "" when missing or storage is unavailable. */
export function readLocalSetting(storageKey: string): string {
  try {
    return String(window.localStorage.getItem(storageKey) ?? "").trim();
  } catch {
    return "";
  }
}

export type KeyForwarding = "send" | "withhold" | "none";

/** Decide whether a locally stored API key may be forwarded to the backend. */
export function keyForwarding(key: string, sameOrigin: boolean): KeyForwarding {
  if (!key) return "none";
  return sameOrigin ? "send" : "withhold";
}

export type LocalKeyHeader = {
  hasKey: boolean;
  forwarding: KeyForwarding;
  headers: Record<string, string>;
};

/**
 * Build request headers carrying a locally stored API key, but only when the API is
 * same-origin. When the key exists but the backend is cross-origin it is withheld.
 */
export function localKeyHeader(storageKey: string, headerName: string): LocalKeyHeader {
  const key = readLocalSetting(storageKey);
  const forwarding = keyForwarding(key, apiRequestsAreSameOrigin());
  return {
    hasKey: key.length > 0,
    forwarding,
    headers: forwarding === "send" ? { [headerName]: key } : {},
  };
}
