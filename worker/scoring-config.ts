import { judgeId } from "../shared/domain";
import { isRecord } from "../shared/trust";
import { generateOpaqueToken, tokenHash } from "./security";
import type { JudgeLinkIssue } from "./judge-lifecycle";

export const RESET_SCORING_CONFIRMATION = "RESET SCORING";

export interface ScoringConfigurationInput {
  judgeCount: number;
  audienceWeight: number;
  reset: boolean;
  confirm: string | null;
}

export function parseScoringConfiguration(
  value: unknown,
): ScoringConfigurationInput | null {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.judgeCount) ||
    (value.judgeCount as number) < 1 ||
    (value.judgeCount as number) > 8 ||
    typeof value.audienceWeight !== "number" ||
    !Number.isFinite(value.audienceWeight) ||
    value.audienceWeight < 0 ||
    value.audienceWeight > 1
  )
    return null;
  return {
    judgeCount: value.judgeCount as number,
    audienceWeight: value.audienceWeight,
    reset: value.reset === true,
    confirm: typeof value.confirm === "string" ? value.confirm : null,
  };
}

export function scoringDataExists(
  sql: SqlStorage,
  showIdentifier: string,
): boolean {
  return (
    sql
      .exec<{ present: number }>(
        `SELECT 1 AS present FROM audience_votes WHERE show_id = ?
     UNION ALL SELECT 1 FROM show_judge_submissions WHERE show_id = ?
     UNION ALL SELECT 1 FROM finalised_results_v2 WHERE show_id = ? LIMIT 1`,
        showIdentifier,
        showIdentifier,
        showIdentifier,
      )
      .toArray().length > 0
  );
}

interface JudgeRow extends Record<string, SqlStorageValue> {
  id: string;
  slot: number;
  display_name: string;
  active: number;
}

export type ScoringConfigurationResult =
  | { ok: true; issued: JudgeLinkIssue[]; scoringReset: boolean }
  | { ok: false; status: 400 | 409; reason: string };

export async function applyScoringConfiguration(
  storage: DurableObjectStorage,
  showIdentifier: string,
  input: ScoringConfigurationInput,
): Promise<ScoringConfigurationResult> {
  const locked = scoringDataExists(storage.sql, showIdentifier);
  if (
    locked &&
    (!input.reset || input.confirm !== RESET_SCORING_CONFIRMATION)
  ) {
    return {
      ok: false,
      status: 409,
      reason: "Scoring data exists; explicit scoring reset is required",
    };
  }
  const rows = storage.sql
    .exec<JudgeRow>(
      "SELECT id, slot, display_name, active FROM show_judges WHERE show_id = ? ORDER BY slot",
      showIdentifier,
    )
    .toArray();
  const additions = Math.max(
    0,
    input.judgeCount - rows.filter((row) => row.active === 1).length,
  );
  const prepared = await Promise.all(
    Array.from({ length: additions }, async () => {
      const token = generateOpaqueToken();
      return { token, hash: await tokenHash(token) };
    }),
  );

  return storage.transactionSync(() => {
    const timestamp = new Date().toISOString();
    if (locked) {
      for (const table of [
        "result_snapshots",
        "finalised_results_v2",
        "finalised_results",
        "audience_aggregates",
        "audience_votes",
        "show_judge_submissions",
        "show_judge_permissions",
        "judge_submissions",
        "judge_permissions",
      ])
        storage.sql.exec(
          `DELETE FROM ${table} WHERE show_id = ?`,
          showIdentifier,
        );
      storage.sql.exec(
        "UPDATE shows SET result_reveal_state = 'HIDDEN', audience_vote_state = 'CLOSED' WHERE id = ?",
        showIdentifier,
      );
    }
    storage.sql.exec(
      "DELETE FROM show_judge_permissions WHERE show_id = ?",
      showIdentifier,
    );
    storage.sql.exec(
      "DELETE FROM judge_permissions WHERE show_id = ?",
      showIdentifier,
    );
    storage.sql.exec(
      "UPDATE show_runtime SET results_stage = 'HIDDEN', results_revealed_groups = 0, global_judge_permission = 'CLOSED' WHERE show_id = ?",
      showIdentifier,
    );
    storage.sql.exec(
      "UPDATE shows SET audience_vote_state = 'CLOSED' WHERE id = ?",
      showIdentifier,
    );
    const active = rows.filter((row) => row.active === 1);
    const issued: JudgeLinkIssue[] = [];
    if (active.length > input.judgeCount) {
      for (const row of active.slice(input.judgeCount))
        storage.sql.exec(
          "UPDATE show_judges SET active = 0, deactivated_at = ? WHERE show_id = ? AND id = ?",
          timestamp,
          showIdentifier,
          row.id,
        );
    } else if (additions > 0) {
      const inactive = rows.filter((row) => row.active === 0);
      for (let index = 0; index < additions; index += 1) {
        const credential = prepared[index]!;
        const previous = inactive[index];
        if (previous) {
          storage.sql.exec(
            `UPDATE show_judges SET active = 1, deactivated_at = NULL,
               credential_revoked_at = NULL, token_hash = ? WHERE show_id = ? AND id = ?`,
            credential.hash,
            showIdentifier,
            previous.id,
          );
          issued.push({
            judgeId: judgeId(previous.id),
            slot: previous.slot,
            displayName: previous.display_name,
            token: credential.token,
          });
        } else {
          const slot = rows.length + index - inactive.length + 1;
          const id = `judge-${crypto.randomUUID()}`;
          const displayName = `Judge ${slot}`;
          storage.sql.exec(
            `INSERT INTO show_judges
              (id, show_id, slot, display_name, token_hash, active, created_at, deactivated_at, credential_revoked_at)
             VALUES (?, ?, ?, ?, ?, 1, ?, NULL, NULL)`,
            id,
            showIdentifier,
            slot,
            displayName,
            credential.hash,
            timestamp,
          );
          issued.push({
            judgeId: judgeId(id),
            slot,
            displayName,
            token: credential.token,
          });
        }
      }
    }
    storage.sql.exec(
      "UPDATE shows SET audience_weight = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
      input.audienceWeight,
      timestamp,
      showIdentifier,
    );
    storage.sql.exec(
      `INSERT INTO audit_events
        (show_id, command_id, actor_role, event_type, event_json, occurred_at)
       VALUES (?, NULL, 'admin', ?, ?, ?)`,
      showIdentifier,
      locked ? "scoring.reset_and_reconfigured" : "scoring.configured",
      JSON.stringify({
        judgeCount: input.judgeCount,
        audienceWeight: input.audienceWeight,
      }),
      timestamp,
    );
    return { ok: true, issued, scoringReset: locked };
  });
}
