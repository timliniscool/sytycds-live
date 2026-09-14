/**
 * The audience QR must point at the canonical production origin even when the
 * projector browser reached the site by some other hostname. `PUBLIC_ORIGIN` is
 * a plain Worker variable; when absent, each client falls back to its own
 * origin, which is the right answer in development.
 */
export function configuredPublicOrigin(env: object): string | null {
  const value = (env as Record<string, unknown>).PUBLIC_ORIGIN;
  return typeof value === "string" ? normalisePublicOrigin(value) : null;
}

/** Accepts only a bare absolute http(s) origin; anything else is unset. */
export function normalisePublicOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  return url.origin;
}

export function audienceJoinUrl(origin: string): string {
  return `${origin}/vote`;
}
