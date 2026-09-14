import { recordAuditEvent } from "./audit";
import {
  adminSessionCookieName,
  cookieHeader,
  expiredCookieHeader,
  generateOpaqueToken,
  hasSameOrigin,
  isOpaqueToken,
  isSecureRequest,
  parseCookie,
  sameSecret,
  tokenHash,
} from "./security";

const SESSION_LIFETIME_SECONDS = 8 * 60 * 60;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;

interface SessionRow extends Record<string, SqlStorageValue> {
  expires_at: number;
}

interface RateLimitRow extends Record<string, SqlStorageValue> {
  window_started_at: number;
  failed_count: number;
  blocked_until: number;
}

export interface AdminSession {
  tokenHash: ArrayBuffer;
  expiresAt: number;
}

export interface LoginResult {
  ok: boolean;
  status: 200 | 400 | 401 | 403 | 429 | 503;
  setCookie?: string;
}

function adminSecret(env: object): string | undefined {
  const value = (env as Record<string, unknown>).ADMIN_ACCESS_TOKEN;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function loginSubjectHash(request: Request): Promise<ArrayBuffer> {
  // Admin-login throttling is isolated from audience paths; the raw address is never stored.
  return tokenHash(
    request.headers.get("CF-Connecting-IP") ?? "local-admin-login",
  );
}

function isRateLimited(
  sql: SqlStorage,
  subjectHash: ArrayBuffer,
  timestamp: number,
): boolean {
  const row = sql
    .exec<RateLimitRow>(
      `SELECT window_started_at, failed_count, blocked_until
       FROM admin_login_limits WHERE subject_hash = ?`,
      subjectHash,
    )
    .toArray()[0];
  return row !== undefined && row.blocked_until > timestamp;
}

function recordLoginFailure(
  sql: SqlStorage,
  subjectHash: ArrayBuffer,
  timestamp: number,
): void {
  const previous = sql
    .exec<RateLimitRow>(
      `SELECT window_started_at, failed_count, blocked_until
       FROM admin_login_limits WHERE subject_hash = ?`,
      subjectHash,
    )
    .toArray()[0];
  const withinWindow =
    previous && timestamp - previous.window_started_at < LOGIN_WINDOW_MS;
  const failedCount = (withinWindow ? previous.failed_count : 0) + 1;
  const blockedUntil =
    failedCount >= LOGIN_MAX_FAILURES ? timestamp + LOGIN_BLOCK_MS : 0;
  sql.exec(
    `INSERT INTO admin_login_limits (
      subject_hash, window_started_at, failed_count, blocked_until, updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(subject_hash) DO UPDATE SET
      window_started_at = excluded.window_started_at,
      failed_count = excluded.failed_count,
      blocked_until = excluded.blocked_until,
      updated_at = excluded.updated_at`,
    subjectHash,
    withinWindow ? previous.window_started_at : timestamp,
    failedCount,
    blockedUntil,
    new Date(timestamp).toISOString(),
  );
}

function clearLoginFailures(sql: SqlStorage, subjectHash: ArrayBuffer): void {
  sql.exec(
    "DELETE FROM admin_login_limits WHERE subject_hash = ?",
    subjectHash,
  );
}

export async function createAdminSession(
  storage: DurableObjectStorage,
  request: Request,
  secret: string,
  showIdentifier: string,
): Promise<LoginResult> {
  if (!hasSameOrigin(request)) {
    return { ok: false, status: 403 };
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { ok: false, status: 400 };
  }
  const supplied =
    typeof body === "object" && body !== null && "secret" in body
      ? (body as Record<string, unknown>).secret
      : undefined;
  if (typeof supplied !== "string" || supplied.length > 1024) {
    return { ok: false, status: 400 };
  }

  const subjectHash = await loginSubjectHash(request);
  const timestamp = Date.now();
  // Security events name neither the secret nor the address; the log answers
  // "was someone trying the door?" and nothing more.
  if (
    storage.transactionSync(() =>
      isRateLimited(storage.sql, subjectHash, timestamp),
    )
  ) {
    recordAuditEvent(storage.sql, showIdentifier, {
      type: "admin.login_blocked",
      actor: "system",
      data: {},
    });
    return { ok: false, status: 429 };
  }
  if (!sameSecret(supplied, secret)) {
    storage.transactionSync(() =>
      recordLoginFailure(storage.sql, subjectHash, timestamp),
    );
    recordAuditEvent(storage.sql, showIdentifier, {
      type: "admin.login_failed",
      actor: "system",
      data: {},
    });
    return { ok: false, status: 401 };
  }

  const token = generateOpaqueToken();
  const hash = await tokenHash(token);
  const expiresAt = timestamp + SESSION_LIFETIME_SECONDS * 1000;
  storage.transactionSync(() => {
    clearLoginFailures(storage.sql, subjectHash);
    storage.sql.exec(
      `INSERT INTO admin_sessions (token_hash, expires_at, created_at, last_seen_at)
       VALUES (?, ?, ?, ?)`,
      hash,
      expiresAt,
      new Date(timestamp).toISOString(),
      new Date(timestamp).toISOString(),
    );
  });
  recordAuditEvent(storage.sql, showIdentifier, {
    type: "admin.login",
    actor: "admin",
    data: {},
  });
  return {
    ok: true,
    status: 200,
    setCookie: cookieHeader({
      name: adminSessionCookieName(),
      value: token,
      maxAgeSeconds: SESSION_LIFETIME_SECONDS,
      sameSite: "Strict",
      secure: isSecureRequest(request),
    }),
  };
}

export async function readAdminSession(
  sql: SqlStorage,
  request: Request,
): Promise<AdminSession | null> {
  const token = parseCookie(request, adminSessionCookieName());
  if (!isOpaqueToken(token)) {
    return null;
  }
  const hash = await tokenHash(token);
  const row = sql
    .exec<SessionRow>(
      "SELECT expires_at FROM admin_sessions WHERE token_hash = ?",
      hash,
    )
    .toArray()[0];
  if (!row || row.expires_at <= Date.now()) {
    return null;
  }
  return { tokenHash: hash, expiresAt: row.expires_at };
}

export function isAdminSessionHashActive(
  sql: SqlStorage,
  tokenHashValue: ArrayBuffer,
): boolean {
  return (
    (sql
      .exec<SessionRow>(
        "SELECT expires_at FROM admin_sessions WHERE token_hash = ?",
        tokenHashValue,
      )
      .toArray()[0]?.expires_at ?? 0) > Date.now()
  );
}

export async function destroyAdminSession(
  storage: DurableObjectStorage,
  request: Request,
): Promise<string> {
  const session = await readAdminSession(storage.sql, request);
  if (session) {
    storage.sql.exec(
      "DELETE FROM admin_sessions WHERE token_hash = ?",
      session.tokenHash,
    );
  }
  return expiredCookieHeader(
    adminSessionCookieName(),
    isSecureRequest(request),
  );
}

export function configuredAdminSecret(env: object): string | undefined {
  return adminSecret(env);
}
