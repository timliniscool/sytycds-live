import { isRecord } from "../shared/trust";
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
  sameBytes,
  sameSecret,
  tokenHash,
} from "./security";

const SESSION_LIFETIME_SECONDS = 8 * 60 * 60;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
export const ADMIN_PBKDF2_ITERATIONS = 210_000;

interface SessionRow extends Record<string, SqlStorageValue> {
  expires_at: number;
}
interface RateLimitRow extends Record<string, SqlStorageValue> {
  window_started_at: number;
  failed_count: number;
  blocked_until: number;
}
interface CredentialRow extends Record<string, SqlStorageValue> {
  username: string;
  salt: ArrayBuffer;
  verifier: ArrayBuffer;
  iterations: number;
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
export interface BootstrapCredential {
  username: string;
  password: string;
}

export function configuredAdminCredential(
  env: object,
): BootstrapCredential | null {
  const values = env as Record<string, unknown>;
  const username =
    typeof values.ADMIN_USERNAME === "string" && values.ADMIN_USERNAME.trim()
      ? values.ADMIN_USERNAME.trim()
      : "admin";
  const password =
    typeof values.ADMIN_PASSWORD === "string" &&
    values.ADMIN_PASSWORD.length > 0
      ? values.ADMIN_PASSWORD
      : typeof values.ADMIN_ACCESS_TOKEN === "string" &&
          values.ADMIN_ACCESS_TOKEN.length > 0
        ? values.ADMIN_ACCESS_TOKEN
        : null;
  return password ? { username, password } : null;
}

function randomSalt(): Uint8Array<ArrayBuffer> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return salt;
}

async function passwordVerifier(
  password: string,
  salt: BufferSource,
  iterations: number,
): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256,
  );
}

async function ensureCredential(
  storage: DurableObjectStorage,
  bootstrap: BootstrapCredential,
): Promise<CredentialRow> {
  const current = storage.sql
    .exec<CredentialRow>(
      "SELECT username, salt, verifier, iterations FROM admin_credentials WHERE singleton = 1",
    )
    .toArray()[0];
  if (current) return current;
  const salt = randomSalt();
  const verifier = await passwordVerifier(
    bootstrap.password,
    salt,
    ADMIN_PBKDF2_ITERATIONS,
  );
  storage.sql.exec(
    `INSERT OR IGNORE INTO admin_credentials
      (singleton, username, salt, verifier, iterations, updated_at)
     VALUES (1, ?, ?, ?, ?, ?)`,
    bootstrap.username,
    salt.buffer,
    verifier,
    ADMIN_PBKDF2_ITERATIONS,
    new Date().toISOString(),
  );
  return storage.sql
    .exec<CredentialRow>(
      "SELECT username, salt, verifier, iterations FROM admin_credentials WHERE singleton = 1",
    )
    .one();
}

async function loginSubjectHash(
  request: Request,
  username: string,
): Promise<ArrayBuffer> {
  return tokenHash(
    [
      username.toLowerCase(),
      request.headers.get("CF-Connecting-IP") ?? "local",
      (request.headers.get("User-Agent") ?? "unknown").slice(0, 160),
    ].join("\n"),
  );
}

function isRateLimited(
  sql: SqlStorage,
  subject: ArrayBuffer,
  now: number,
): boolean {
  return (
    (sql
      .exec<RateLimitRow>(
        "SELECT window_started_at, failed_count, blocked_until FROM admin_login_limits WHERE subject_hash = ?",
        subject,
      )
      .toArray()[0]?.blocked_until ?? 0) > now
  );
}

function recordFailure(
  sql: SqlStorage,
  subject: ArrayBuffer,
  now: number,
): void {
  const previous = sql
    .exec<RateLimitRow>(
      "SELECT window_started_at, failed_count, blocked_until FROM admin_login_limits WHERE subject_hash = ?",
      subject,
    )
    .toArray()[0];
  const within =
    previous !== undefined &&
    now - previous.window_started_at < LOGIN_WINDOW_MS;
  const count = (within ? previous.failed_count : 0) + 1;
  sql.exec(
    `INSERT INTO admin_login_limits
      (subject_hash, window_started_at, failed_count, blocked_until, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(subject_hash) DO UPDATE SET window_started_at=excluded.window_started_at,
       failed_count=excluded.failed_count, blocked_until=excluded.blocked_until,
       updated_at=excluded.updated_at`,
    subject,
    within ? previous.window_started_at : now,
    count,
    count >= LOGIN_MAX_FAILURES ? now + LOGIN_BLOCK_MS : 0,
    new Date(now).toISOString(),
  );
}

export async function createAdminSession(
  storage: DurableObjectStorage,
  request: Request,
  bootstrapInput: BootstrapCredential | string,
  showIdentifier: string,
): Promise<LoginResult> {
  if (!hasSameOrigin(request)) return { ok: false, status: 403 };
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { ok: false, status: 400 };
  }
  const bootstrap =
    typeof bootstrapInput === "string"
      ? { username: "admin", password: bootstrapInput }
      : bootstrapInput;
  if (
    typeof bootstrapInput === "string" &&
    isRecord(body) &&
    typeof body.secret === "string"
  ) {
    body = { username: "admin", password: body.secret };
  }
  if (
    !isRecord(body) ||
    typeof body.username !== "string" ||
    typeof body.password !== "string" ||
    body.username.length > 120 ||
    body.password.length > 1024
  )
    return { ok: false, status: 400 };
  const credential = await ensureCredential(storage, bootstrap);
  const subject = await loginSubjectHash(request, body.username);
  const timestamp = Date.now();
  if (isRateLimited(storage.sql, subject, timestamp))
    return { ok: false, status: 429 };
  const supplied = await passwordVerifier(
    body.password,
    credential.salt,
    credential.iterations,
  );
  if (
    !sameSecret(body.username, credential.username) ||
    !sameBytes(supplied, credential.verifier)
  ) {
    storage.transactionSync(() =>
      recordFailure(storage.sql, subject, timestamp),
    );
    recordAuditEvent(storage.sql, showIdentifier, {
      type: "admin.login_failed",
      actor: "system",
    });
    return { ok: false, status: 401 };
  }
  const token = generateOpaqueToken();
  const hash = await tokenHash(token);
  const expiresAt = timestamp + SESSION_LIFETIME_SECONDS * 1000;
  const existing = parseCookie(request, adminSessionCookieName());
  const existingHash = isOpaqueToken(existing)
    ? await tokenHash(existing)
    : null;
  storage.transactionSync(() => {
    storage.sql.exec(
      "DELETE FROM admin_login_limits WHERE subject_hash = ?",
      subject,
    );
    if (existingHash)
      storage.sql.exec(
        "DELETE FROM admin_sessions WHERE token_hash = ?",
        existingHash,
      );
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

export async function rotateAdminCredential(
  storage: DurableObjectStorage,
  currentSessionHash: ArrayBuffer,
  username: string,
  password: string,
): Promise<boolean> {
  const clean = username.replace(/\s+/gu, " ").trim();
  if (
    clean.length === 0 ||
    clean.length > 120 ||
    password.length < 12 ||
    password.length > 1024
  )
    return false;
  const salt = randomSalt();
  const verifier = await passwordVerifier(
    password,
    salt,
    ADMIN_PBKDF2_ITERATIONS,
  );
  storage.transactionSync(() => {
    storage.sql.exec(
      `INSERT INTO admin_credentials (singleton, username, salt, verifier, iterations, updated_at)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET username=excluded.username, salt=excluded.salt,
         verifier=excluded.verifier, iterations=excluded.iterations, updated_at=excluded.updated_at`,
      clean,
      salt.buffer,
      verifier,
      ADMIN_PBKDF2_ITERATIONS,
      new Date().toISOString(),
    );
    storage.sql.exec(
      "DELETE FROM admin_sessions WHERE token_hash != ?",
      currentSessionHash,
    );
  });
  return true;
}

export async function readAdminSession(
  sql: SqlStorage,
  request: Request,
): Promise<AdminSession | null> {
  const token = parseCookie(request, adminSessionCookieName());
  if (!isOpaqueToken(token)) return null;
  const hash = await tokenHash(token);
  const row = sql
    .exec<SessionRow>(
      "SELECT expires_at FROM admin_sessions WHERE token_hash = ?",
      hash,
    )
    .toArray()[0];
  return row && row.expires_at > Date.now()
    ? { tokenHash: hash, expiresAt: row.expires_at }
    : null;
}

export function isAdminSessionHashActive(
  sql: SqlStorage,
  hash: ArrayBuffer,
): boolean {
  return (
    (sql
      .exec<SessionRow>(
        "SELECT expires_at FROM admin_sessions WHERE token_hash = ?",
        hash,
      )
      .toArray()[0]?.expires_at ?? 0) > Date.now()
  );
}

export async function destroyAdminSession(
  storage: DurableObjectStorage,
  request: Request,
): Promise<string> {
  const session = await readAdminSession(storage.sql, request);
  if (session)
    storage.sql.exec(
      "DELETE FROM admin_sessions WHERE token_hash = ?",
      session.tokenHash,
    );
  return expiredCookieHeader(
    adminSessionCookieName(),
    isSecureRequest(request),
  );
}
