import {
  cookieHeader,
  expiredCookieHeader,
  generateOpaqueToken,
  isOpaqueToken,
  isSecureRequest,
  parseCookie,
  projectorSessionCookieName,
  sameBytes,
  tokenHash,
} from "./security";

const CODE_LIFETIME_MS = 10 * 60 * 1000;
const SESSION_LIFETIME_SECONDS = 180 * 24 * 60 * 60;
const MAX_ATTEMPTS = 8;

interface PairingRow extends Record<string, SqlStorageValue> {
  code_hash: ArrayBuffer;
  salt: ArrayBuffer;
  expires_at: number;
  attempts: number;
}

function numericCode(): string {
  const limit = Math.floor(0x1_0000_0000 / 100_000_000) * 100_000_000;
  const values = new Uint32Array(1);
  do crypto.getRandomValues(values);
  while (values[0]! >= limit);
  return String(values[0]! % 100_000_000).padStart(8, "0");
}

function salt(): Uint8Array<ArrayBuffer> {
  const value = new Uint8Array(16);
  crypto.getRandomValues(value);
  return value;
}

async function codeHash(
  code: string,
  value: ArrayBuffer,
): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(value.byteLength + code.length);
  bytes.set(new Uint8Array(value));
  bytes.set(new TextEncoder().encode(code), value.byteLength);
  return crypto.subtle.digest("SHA-256", bytes);
}

export async function generateProjectorPairingCode(
  storage: DurableObjectStorage,
  showIdentifier: string,
): Promise<{ code: string; expiresAt: number }> {
  const code = numericCode();
  const codeSalt = salt();
  const hash = await codeHash(code, codeSalt.buffer);
  const now = Date.now();
  const expiresAt = now + CODE_LIFETIME_MS;
  storage.transactionSync(() => {
    storage.sql.exec(
      "DELETE FROM projector_pairing_codes WHERE show_id = ?",
      showIdentifier,
    );
    storage.sql.exec(
      `INSERT INTO projector_pairing_codes
        (show_id, code_hash, salt, expires_at, attempts, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
      showIdentifier,
      hash,
      codeSalt.buffer,
      expiresAt,
      new Date(now).toISOString(),
    );
  });
  return { code, expiresAt };
}

export type PairProjectorResult =
  | { ok: true; setCookie: string }
  | { ok: false; status: 400 | 401 | 429; error: string };

export async function pairProjector(
  storage: DurableObjectStorage,
  request: Request,
  showIdentifier: string,
  supplied: string,
): Promise<PairProjectorResult> {
  const code = supplied.replace(/\s/gu, "");
  if (!/^\d{8}$/u.test(code))
    return { ok: false, status: 400, error: "Enter all 8 digits" };
  const row = storage.sql
    .exec<PairingRow>(
      `SELECT code_hash, salt, expires_at, attempts FROM projector_pairing_codes
     WHERE show_id = ?`,
      showIdentifier,
    )
    .toArray()[0];
  if (!row || row.expires_at <= Date.now()) {
    if (row)
      storage.sql.exec(
        "DELETE FROM projector_pairing_codes WHERE show_id = ?",
        showIdentifier,
      );
    return { ok: false, status: 401, error: "Pairing code expired" };
  }
  if (row.attempts >= MAX_ATTEMPTS)
    return { ok: false, status: 429, error: "Too many attempts" };
  const presented = await codeHash(code, row.salt);
  if (!sameBytes(presented, row.code_hash)) {
    storage.sql.exec(
      "UPDATE projector_pairing_codes SET attempts = attempts + 1 WHERE show_id = ?",
      showIdentifier,
    );
    return {
      ok: false,
      status: row.attempts + 1 >= MAX_ATTEMPTS ? 429 : 401,
      error: "Code not accepted",
    };
  }
  const token = generateOpaqueToken();
  const hash = await tokenHash(token);
  const now = new Date().toISOString();
  try {
    storage.transactionSync(() => {
      const deleted = storage.sql.exec(
        "DELETE FROM projector_pairing_codes WHERE show_id = ? AND code_hash = ?",
        showIdentifier,
        row.code_hash,
      );
      if (deleted.rowsWritten !== 1)
        throw new Error("Pairing code was already used");
      storage.sql.exec(
        `INSERT INTO projector_sessions
          (token_hash, show_id, created_at, last_seen_at, expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
        hash,
        showIdentifier,
        now,
        now,
        Date.now() + SESSION_LIFETIME_SECONDS * 1000,
      );
    });
  } catch {
    return { ok: false, status: 401, error: "Pairing code was already used" };
  }
  return {
    ok: true,
    setCookie: cookieHeader({
      name: projectorSessionCookieName(),
      value: token,
      maxAgeSeconds: SESSION_LIFETIME_SECONDS,
      sameSite: "Strict",
      secure: isSecureRequest(request),
    }),
  };
}

export async function readProjectorSessionHash(
  sql: SqlStorage,
  request: Request,
): Promise<ArrayBuffer | null> {
  const token = parseCookie(request, projectorSessionCookieName());
  if (!isOpaqueToken(token)) return null;
  const hash = await tokenHash(token);
  const row = sql
    .exec<{ present: number }>(
      `SELECT 1 AS present FROM projector_sessions
     WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
      hash,
      Date.now(),
    )
    .toArray()[0];
  return row ? hash : null;
}

export function projectorSessionActive(
  sql: SqlStorage,
  hash: ArrayBuffer,
): boolean {
  return (
    sql
      .exec<{ present: number }>(
        "SELECT 1 AS present FROM projector_sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?",
        hash,
        Date.now(),
      )
      .toArray().length > 0
  );
}

export function revokeProjectors(
  storage: DurableObjectStorage,
  showIdentifier: string,
): number {
  storage.sql.exec(
    "DELETE FROM projector_pairing_codes WHERE show_id = ?",
    showIdentifier,
  );
  return storage.sql.exec(
    "UPDATE projector_sessions SET revoked_at = ? WHERE show_id = ? AND revoked_at IS NULL",
    new Date().toISOString(),
    showIdentifier,
  ).rowsWritten;
}

export function clearProjectorCookie(request: Request): string {
  return expiredCookieHeader(
    projectorSessionCookieName(),
    isSecureRequest(request),
  );
}

export function projectorPairingStatus(
  sql: SqlStorage,
  showIdentifier: string,
): { paired: boolean } {
  return {
    paired:
      sql
        .exec<{ present: number }>(
          "SELECT 1 AS present FROM projector_sessions WHERE show_id = ? AND revoked_at IS NULL AND expires_at > ? LIMIT 1",
          showIdentifier,
          Date.now(),
        )
        .toArray().length > 0,
  };
}
