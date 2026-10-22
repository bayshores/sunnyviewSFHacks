/** Returns the normalized URL only when it parses and uses https; otherwise null (render as plain text). */
export function safeHttpsUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}
