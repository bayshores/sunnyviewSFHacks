/**
 * Error whose message is safe to show to API clients (no hostnames, upstream
 * bodies or stack details). Anything else thrown while fetching an image is
 * logged server-side and replaced with a generic message.
 */
export class SafeImageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SafeImageError"
  }
}
