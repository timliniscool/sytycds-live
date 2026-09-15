import { judgeId, type JudgeId } from "../shared/domain";
import { generateOpaqueToken, tokenHash } from "./security";

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
