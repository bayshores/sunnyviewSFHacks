import { SafeImageError } from "@/lib/segment/errors"

const LOCAL_DEV_PORT_FALLBACK = "3000"
const HOST_NOT_TRUSTED_MESSAGE = "imageUrl host must match this app host or SEGMENT_IMAGE_FETCH_ALLOWLIST"

export function readHostAllowlist(): string[] {
  const raw = process.env.SEGMENT_IMAGE_FETCH_ALLOWLIST ?? ""
  return raw
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host.length > 0)
}

let warnedNoAppOrigin = false

/**
 * Origin of this app as configured on the server. Never derived from the
 * incoming request (the Host header is client-controlled off-Vercel).
 * APP_ORIGIN, else https://VERCEL_URL, else the local dev server (non-production
 * only). Returns null in production when neither is set: a loopback fallback
 * there would let callers reach arbitrary paths on the app port.
 */
export function getAppOrigin(env: Record<string, string | undefined> = process.env): string | null {
  const explicit = env.APP_ORIGIN?.trim()
  if (explicit) {
    try {
      return new URL(explicit).origin
    } catch {
      // fall through to the other sources
    }
  }
  const vercel = env.VERCEL_URL?.trim()
  if (vercel) {
    try {
      return new URL(`https://${vercel}`).origin
    } catch {
      // fall through
    }
  }
  if (env.NODE_ENV === "production") {
    if (!warnedNoAppOrigin) {
      warnedNoAppOrigin = true
      console.warn("[segment] APP_ORIGIN/VERCEL_URL not set in production; relative imageUrl values are rejected")
    }
    return null
  }
  const port = env.PORT?.trim() || LOCAL_DEV_PORT_FALLBACK
  return `http://127.0.0.1:${/^\d{1,5}$/.test(port) ? port : LOCAL_DEV_PORT_FALLBACK}`
}

function parseIpv4(text: string): number[] | null {
  const m = text.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return null
  const octets = m.slice(1).map(Number)
  return octets.every((n) => n <= 255) ? octets : null
}

/** Parses an IPv6 literal (no brackets) into eight 16-bit groups, or null. */
function parseIpv6(text: string): number[] | null {
  if (!text.includes(":")) return null
  let rest = text
  let tail: number[] = []
  const lastColon = rest.lastIndexOf(":")
  const v4 = parseIpv4(rest.slice(lastColon + 1))
  if (v4) {
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]]
    rest = rest.slice(0, lastColon + 1) + "0:0"
  }
  const halves = rest.split("::")
  if (halves.length > 2) return null
  const toGroups = (part: string) => (part === "" ? [] : part.split(":"))
  const head = toGroups(halves[0])
  const back = halves.length === 2 ? toGroups(halves[1]) : []
  const all = [...head, ...back]
  if (!all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null
  let groups: number[]
  if (halves.length === 2) {
    const missing = 8 - all.length
    if (missing < 1) return null
    groups = [...head.map((g) => parseInt(g, 16)), ...Array<number>(missing).fill(0), ...back.map((g) => parseInt(g, 16))]
  } else {
    if (all.length !== 8) return null
    groups = all.map((g) => parseInt(g, 16))
  }
  if (tail.length) groups = [...groups.slice(0, 6), ...tail]
  return groups
}

function privateIpv4Octets(o: number[]): boolean {
  const [a, b, c] = o
  if (a === 0) return true // 0.0.0.0/8
  if (a === 10) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64/10
  if (a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 0 && c === 0) return true
  if (a === 192 && b === 168) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a >= 224) return true // multicast / reserved / broadcast
  return false
}

export function isPrivateIpv4(hostname: string): boolean {
  const octets = parseIpv4(hostname)
  return octets ? privateIpv4Octets(octets) : false
}

function privateIpv6Groups(g: number[]): boolean {
  const v4From = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255]
  if (g.every((x) => x === 0)) return true // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true // ::1
  // IPv4-mapped (::ffff:a.b.c.d) and deprecated IPv4-compatible (::a.b.c.d)
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return privateIpv4Octets(v4From(g[6], g[7]))
  // NAT64 64:ff9b::/96 embeds an IPv4 address
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return privateIpv4Octets(v4From(g[6], g[7]))
  if ((g[0] & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return true // ff00::/8 multicast
  return false
}

export function isPrivateHostname(hostname: string): boolean {
  let host = hostname.trim().toLowerCase()
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1)
  if (host.endsWith(".")) host = host.slice(0, -1)
  if (!host) return true
  if (host === "localhost" || host.endsWith(".localhost")) return true
  if (host.endsWith(".local") || host.endsWith(".internal")) return true

  const v4 = parseIpv4(host)
  if (v4) return privateIpv4Octets(v4)
  if (host.includes(":")) {
    const v6 = parseIpv6(host.split("%")[0])
    // An unparsable IPv6-looking host is rejected rather than trusted.
    return v6 ? privateIpv6Groups(v6) : true
  }
  return false
}

export function hostAllowed(hostname: string, allowlist: string[]): boolean {
  return allowlist.some((allowedHost) => hostname === allowedHost || hostname.endsWith(`.${allowedHost}`))
}

/**
 * Resolves `imageUrl` against the server-configured app origin and applies the
 * SSRF policy. Relative paths (e.g. `/api/static-map?...`) resolve to the app
 * origin and are trusted; every other URL must be public, https and allowlisted.
 * Throws a SafeImageError when the URL must not be fetched.
 */
export function resolveAllowedImageUrl(
  imageUrl: string,
  allowlist: string[] = readHostAllowlist(),
  appOrigin: string | null = getAppOrigin()
): URL {
  let abs: URL
  try {
    abs = appOrigin ? new URL(imageUrl, appOrigin) : new URL(imageUrl)
  } catch {
    // Without an app origin, relative URLs cannot be resolved and are rejected.
    throw new SafeImageError(appOrigin ? "Invalid imageUrl" : HOST_NOT_TRUSTED_MESSAGE)
  }

  if (!["https:", "http:"].includes(abs.protocol)) {
    throw new SafeImageError("imageUrl must use http(s)")
  }
  if (abs.username || abs.password) {
    throw new SafeImageError("imageUrl host is not allowed")
  }
  if (appOrigin && abs.origin === new URL(appOrigin).origin) return abs

  const absHost = abs.hostname.toLowerCase()
  if (isPrivateHostname(absHost)) {
    throw new SafeImageError("imageUrl host is not allowed")
  }
  if (!hostAllowed(absHost, allowlist)) {
    throw new SafeImageError(HOST_NOT_TRUSTED_MESSAGE)
  }
  if (abs.protocol !== "https:") {
    throw new SafeImageError("imageUrl must use https for remote hosts")
  }
  return abs
}
