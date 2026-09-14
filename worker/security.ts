const TOKEN_BYTES = 32;
const ADMIN_SESSION_COOKIE = "sytycds_admin";
const VOTER_COOKIE = "sytycds_voter";

export interface CookieSettings {
  name: string;
  value: string;
  maxAgeSeconds: number;
  sameSite: "Lax" | "Strict";
  secure: boolean;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function generateOpaqueToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export function isOpaqueToken(value: string | undefined): value is string {
  return value !== undefined && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export async function tokenHash(token: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
}

export function parseCookie(
  request: Request,
  name: string,
): string | undefined {
  const header = request.headers.get("Cookie");
  if (!header) {
    return undefined;
  }
  for (const part of header.split(";")) {
    const [key, ...valueParts] = part.trim().split("=");
    if (key === name) {
      return valueParts.join("=");
    }
  }
  return undefined;
}

export function cookieHeader(settings: CookieSettings): string {
  return [
    `${settings.name}=${settings.value}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${settings.sameSite}`,
    `Max-Age=${settings.maxAgeSeconds}`,
    ...(settings.secure ? ["Secure"] : []),
  ].join("; ");
}

export function expiredCookieHeader(name: string, secure: boolean): string {
  return cookieHeader({
    name,
    value: "",
    maxAgeSeconds: 0,
    sameSite: "Strict",
    secure,
  });
}

export function isSecureRequest(request: Request): boolean {
  return new URL(request.url).protocol === "https:";
}

export function adminSessionCookieName(): string {
  return ADMIN_SESSION_COOKIE;
}

export function voterCookieName(): string {
  return VOTER_COOKIE;
}

export function sameSecret(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const maximum = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < maximum; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

/** Browsers send Origin for fetch/XHR; rejecting mismatches blocks cross-site posts. */
export function hasSameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  return origin === null || origin === new URL(request.url).origin;
}
