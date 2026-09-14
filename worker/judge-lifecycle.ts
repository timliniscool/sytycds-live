import { judgeId, type JudgeId } from "../shared/domain";
import { generateOpaqueToken, tokenHash } from "./security";
import { scoringDataExists } from "./scoring-config";

interface JudgeRow extends Record<string, SqlStorageValue> {
  id: string;
  slot: number;
  display_name: string;
  revoked_at: string | null;
  active: number;
}

export interface JudgeLinkIssue {
  judgeId: JudgeId;
  slot: number;
  displayName: string;
  token: string;
}

export interface AdminJudgeSummary {
  id: JudgeId;
  slot: number;
  displayName: string;
  active: boolean;
  configured: boolean;
  /** Raw tokens are intentionally never recoverable; rotate to issue a new link. */
  linkAvailable: false;
}

function validateLabels(labels: readonly string[]): boolean {
  return (
    labels.length >= 1 &&
    labels.length <= 8 &&
    labels.every((label) => label.trim().length > 0 && label.length <= 120)
  );
}

/**
 * Tokens are generated only for creation/rotation and never persisted raw.
 * An admin who needs a lost link must rotate it, immediately revoking the old URL.
 */
export async function createJudges(
  storage: DurableObjectStorage,
  showIdentifier: string,
  labels: readonly string[],
): Promise<JudgeLinkIssue[] | null> {
  if (!validateLabels(labels)) {
    return null;
  }
  if (scoringDataExists(storage.sql, showIdentifier)) return null;
  const issued = await Promise.all(
    labels.map(async (displayName, index) => {
      const token = generateOpaqueToken();
      return {
        judgeId: judgeId(`judge-${crypto.randomUUID()}`),
        slot: index + 1,
        displayName: displayName.trim(),
        token,
        hash: await tokenHash(token),
      };
    }),
  );
  return storage.transactionSync(() => {
    const show = storage.sql
      .exec<{ present: number }>(
        "SELECT 1 AS present FROM shows WHERE id = ?",
        showIdentifier,
      )
      .toArray()[0];
    const count = storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM show_judges WHERE show_id = ?",
        showIdentifier,
      )
      .one().count;
    if (!show || count !== 0) {
      return null;
    }
    const timestamp = new Date().toISOString();
    for (const judge of issued) {
      storage.sql.exec(
        `INSERT INTO show_judges (
          id, show_id, slot, display_name, token_hash, active, created_at,
          deactivated_at, credential_revoked_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, NULL, NULL)`,
        judge.judgeId,
        showIdentifier,
        judge.slot,
        judge.displayName,
        judge.hash,
        timestamp,
      );
    }
    return issued.map((judge) => ({
      judgeId: judge.judgeId,
      slot: judge.slot,
      displayName: judge.displayName,
      token: judge.token,
    }));
  });
}

export async function rotateJudgeToken(
  storage: DurableObjectStorage,
  showIdentifier: string,
  requestedJudgeId: string,
): Promise<JudgeLinkIssue | null> {
  const token = generateOpaqueToken();
  const hash = await tokenHash(token);
  return storage.transactionSync(() => {
    const judge = storage.sql
      .exec<JudgeRow>(
        `SELECT id, slot, display_name, credential_revoked_at AS revoked_at, active FROM show_judges
         WHERE show_id = ? AND id = ?`,
        showIdentifier,
        requestedJudgeId,
      )
      .toArray()[0];
    if (!judge) {
      return null;
    }
    storage.sql.exec(
      `UPDATE show_judges SET token_hash = ?, credential_revoked_at = NULL
       WHERE show_id = ? AND id = ?`,
      hash,
      showIdentifier,
      requestedJudgeId,
    );
    return {
      judgeId: judgeId(judge.id),
      slot: judge.slot,
      displayName: judge.display_name,
      token,
    };
  });
}

/** Temporarily disable a judge URL without deleting the stable judge identity. */
export function revokeJudge(
  storage: DurableObjectStorage,
  showIdentifier: string,
  requestedJudgeId: string,
): boolean {
  return storage.transactionSync(() => {
    const result = storage.sql.exec(
      `UPDATE show_judges SET credential_revoked_at = ?
       WHERE show_id = ? AND id = ? AND credential_revoked_at IS NULL`,
      new Date().toISOString(),
      showIdentifier,
      requestedJudgeId,
    );
    return result.rowsWritten === 1;
  });
}

export function listJudges(
  sql: SqlStorage,
  showIdentifier: string,
): AdminJudgeSummary[] {
  return sql
    .exec<JudgeRow>(
      `SELECT id, slot, display_name, credential_revoked_at AS revoked_at, active FROM show_judges
       WHERE show_id = ? ORDER BY slot`,
      showIdentifier,
    )
    .toArray()
    .map((judge) => ({
      id: judgeId(judge.id),
      slot: judge.slot,
      displayName: judge.display_name,
      active: judge.active === 1 && judge.revoked_at === null,
      configured: judge.active === 1,
      linkAvailable: false,
    }));
}

export function renameJudge(
  storage: DurableObjectStorage,
  showIdentifier: string,
  requestedJudgeId: string,
  displayName: string,
): boolean {
  const clean = displayName.replace(/\s+/gu, " ").trim();
  if (clean.length === 0 || clean.length > 120) return false;
  return storage.transactionSync(() => {
    const timestamp = new Date().toISOString();
    const result = storage.sql.exec(
      "UPDATE show_judges SET display_name = ? WHERE show_id = ? AND id = ?",
      clean,
      showIdentifier,
      requestedJudgeId,
    );
    if (result.rowsWritten !== 1) return false;
    storage.sql.exec(
      "UPDATE shows SET revision = revision + 1, updated_at = ? WHERE id = ?",
      timestamp,
      showIdentifier,
    );
    return true;
  });
}
