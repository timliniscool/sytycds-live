import { judgeId } from "../shared/domain";
import {
  MAX_JUDGES,
  defaultJudgeName,
  normaliseJudgeConfiguration,
} from "../shared/judges";
import { isRecord } from "../shared/trust";
import { generateOpaqueToken, tokenHash } from "./security";
import type { JudgeLinkIssue } from "./judge-lifecycle";

export const RESET_SCORING_CONFIRMATION = "RESET SCORING";

/**
 * There is one judge configuration and the panel size is part of it. The count
 * is never a separate question: it is `judgeNames.length`, derived here so the
 * console, the coordinator and the database cannot disagree about it.
 */
export interface ScoringConfigurationInput {
  judgeNames: readonly string[];
  audienceWeight: number;
  reset: boolean;
  confirm: string | null;
}

export type ScoringConfigurationParse =
  | { ok: true; input: ScoringConfigurationInput }
  | { ok: false; reason: string };

/**
 * Accepts the authoritative `judgeNames` list. A bare `judgeCount` is still
 * understood — an older client, or a caller that only wants a panel size — and
 * is expanded to the default "Judge N" labels, which are valid names.
 */
export function parseScoringConfiguration(
  value: unknown,
): ScoringConfigurationParse {
  if (!isRecord(value)) return { ok: false, reason: "Invalid request" };
  if (
    typeof value.audienceWeight !== "number" ||
    !Number.isFinite(value.audienceWeight) ||
    value.audienceWeight < 0 ||
    value.audienceWeight > 1
  ) {
    return {
      ok: false,
      reason: "Audience weight must be between 0% and 100%",
    };
  }
  const supplied = Array.isArray(value.judgeNames)
    ? value.judgeNames.every((name) => typeof name === "string")
      ? (value.judgeNames as string[])
      : null
    : Number.isSafeInteger(value.judgeCount) &&
        (value.judgeCount as number) >= 1 &&
        (value.judgeCount as number) <= MAX_JUDGES
      ? Array.from({ length: value.judgeCount as number }, (_, index) =>
          defaultJudgeName(index + 1),
        )
      : null;
  if (!supplied) {
    return { ok: false, reason: "Invalid judge configuration" };
  }
  const judges = normaliseJudgeConfiguration(supplied);
  if (!judges.ok) return { ok: false, reason: judges.reason };
  return {
    ok: true,
    input: {
      judgeNames: judges.names,
      audienceWeight: value.audienceWeight,
      reset: value.reset === true,
      confirm: typeof value.confirm === "string" ? value.confirm : null,
    },
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

/** Every scoring table, children first. Acts, cues, media and judges stay. */
const SCORING_TABLES = [
  "result_snapshots",
  "finalised_results_v2",
  "finalised_results",
  "audience_aggregates",
  "audience_votes",
  "show_judge_submissions",
  "show_judge_permissions",
  "judge_submissions",
  "judge_permissions",
] as const;

/**
 * Removes every vote, judge score, permission and finalised result for the
 * show and returns the stage to a closed, hidden scoring state. The acts, the
 * running order, media and the judge panel are untouched. Used both when the
 * judge panel is reconfigured over existing scores and by the operator's
 * explicit "reset all votes and scores".
 */
export function clearScoringData(
  sql: SqlStorage,
  showIdentifier: string,
): { audienceVotes: number; judgeScores: number; finalisedResults: number } {
  const count = (table: string) =>
    sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM ${table} WHERE show_id = ?`,
        showIdentifier,
      )
      .one().count;
  const summary = {
    audienceVotes: count("audience_votes"),
    judgeScores: count("show_judge_submissions"),
    finalisedResults: count("finalised_results_v2"),
  };
  for (const table of SCORING_TABLES)
    sql.exec(`DELETE FROM ${table} WHERE show_id = ?`, showIdentifier);
  sql.exec(
    "UPDATE shows SET result_reveal_state = 'HIDDEN', audience_vote_state = 'CLOSED' WHERE id = ?",
    showIdentifier,
  );
  sql.exec(
    `UPDATE show_runtime SET results_stage = 'HIDDEN', results_revealed_groups = 0,
       global_judge_permission = 'CLOSED', vote_close_revision = NULL, vote_closed_at = NULL
     WHERE show_id = ?`,
    showIdentifier,
  );
  return summary;
}

export const CLEAR_ACT_SCORING_CONFIRMATION = "CLEAR ACT SCORING";

/**
 * Clears the scoring of one act only: its audience votes and aggregate, judge
 * scores and permissions, and any finalised result. Every other act keeps its
 * scores. If the act is the current one, audience voting closes and a revealed
 * result is hidden, because what was on the screen no longer exists.
 */
export function clearActScoringData(
  storage: DurableObjectStorage,
  showIdentifier: string,
  actIdentifier: string,
):
  | {
      ok: true;
      audienceVotes: number;
      judgeScores: number;
      finalisedResults: number;
    }
  | { ok: false; reason: string } {
  return storage.transactionSync(() => {
    const sql = storage.sql;
    const act = sql
      .exec<{ id: string }>(
        "SELECT id FROM acts WHERE show_id = ? AND id = ?",
        showIdentifier,
        actIdentifier,
      )
      .toArray()[0];
    if (!act) return { ok: false, reason: "Act not found" };
    const count = (table: string) =>
      sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM ${table} WHERE show_id = ? AND act_id = ?`,
          showIdentifier,
          actIdentifier,
        )
        .one().count;
    const summary = {
      audienceVotes: count("audience_votes"),
      judgeScores: count("show_judge_submissions"),
      finalisedResults: count("finalised_results_v2"),
    };
    for (const table of SCORING_TABLES)
      sql.exec(
        `DELETE FROM ${table} WHERE show_id = ? AND act_id = ?`,
        showIdentifier,
        actIdentifier,
      );
    const timestamp = new Date().toISOString();
    const current = sql
      .exec<{ active_act_id: string | null }>(
        "SELECT active_act_id FROM shows WHERE id = ?",
        showIdentifier,
      )
      .toArray()[0];
    if (current?.active_act_id === actIdentifier) {
      sql.exec(
        `UPDATE shows SET result_reveal_state = 'HIDDEN', audience_vote_state = 'CLOSED'
         WHERE id = ?`,
        showIdentifier,
      );
      sql.exec(
        `UPDATE show_runtime SET vote_close_revision = NULL, vote_closed_at = NULL,
           global_judge_permission = 'CLOSED'
         WHERE show_id = ?`,
        showIdentifier,
      );
    }
    sql.exec(
      "UPDATE shows SET revision = revision + 1, updated_at = ? WHERE id = ?",
      timestamp,
      showIdentifier,
    );
    return { ok: true, ...summary };
  });
}

/**
 * The operator's hard reset of every vote and score, leaving the show itself
 * as built. The revision moves so every connected surface re-derives.
 */
export function resetScoringData(
  storage: DurableObjectStorage,
  showIdentifier: string,
): { audienceVotes: number; judgeScores: number; finalisedResults: number } {
  return storage.transactionSync(() => {
    const summary = clearScoringData(storage.sql, showIdentifier);
    storage.sql.exec(
      "UPDATE shows SET revision = revision + 1, updated_at = ? WHERE id = ?",
      new Date().toISOString(),
      showIdentifier,
    );
    return summary;
  });
}

/**
 * Applies the whole judge configuration and the audience weight atomically: the
 * panel size, every judge's name and the weighting land together or not at all,
 * so a half-applied configuration can never be observed.
 */
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
      "SELECT id, slot, display_name, active FROM show_judges WHERE show_id = ? ORDER BY active DESC, slot",
      showIdentifier,
    )
    .toArray();
  const active = rows.filter((row) => row.active === 1);
  const inactive = rows.filter((row) => row.active === 0);
  // A judge who is newly added, or brought back from inactive, needs a fresh
  // credential. Tokens are generated outside the transaction because hashing
  // is asynchronous and `transactionSync` is not.
  const newCredentials = Math.max(0, input.judgeNames.length - active.length);
  const prepared = await Promise.all(
    Array.from({ length: newCredentials }, async () => {
      const token = generateOpaqueToken();
      return { token, hash: await tokenHash(token) };
    }),
  );

  return storage.transactionSync(() => {
    const timestamp = new Date().toISOString();
    if (locked) clearScoringData(storage.sql, showIdentifier);
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

    // A judge keeps the slot it was issued with for the life of the show, so a
    // link printed for "Judge 3" never silently becomes somebody else. Slots
    // are only ever handed out, never reshuffled.
    const usedSlots = new Set(rows.map((row) => row.slot));
    const takeFreeSlot = (): number => {
      for (let slot = 1; slot <= MAX_JUDGES; slot += 1) {
        if (!usedSlots.has(slot)) {
          usedSlots.add(slot);
          return slot;
        }
      }
      throw new Error("No judge slot is available");
    };

    const issued: JudgeLinkIssue[] = [];
    const configured = new Set<string>();
    let added = 0;
    input.judgeNames.forEach((displayName, index) => {
      const existing = active[index];
      if (existing) {
        storage.sql.exec(
          "UPDATE show_judges SET display_name = ? WHERE show_id = ? AND id = ?",
          displayName,
          showIdentifier,
          existing.id,
        );
        configured.add(existing.id);
        return;
      }
      const credential = prepared[added]!;
      const previous = inactive[added];
      added += 1;
      if (previous) {
        storage.sql.exec(
          `UPDATE show_judges SET display_name = ?, active = 1,
             deactivated_at = NULL, credential_revoked_at = NULL, token_hash = ?
           WHERE show_id = ? AND id = ?`,
          displayName,
          credential.hash,
          showIdentifier,
          previous.id,
        );
        configured.add(previous.id);
        issued.push({
          judgeId: judgeId(previous.id),
          slot: previous.slot,
          displayName,
          token: credential.token,
        });
        return;
      }
      const id = `judge-${crypto.randomUUID()}`;
      const slot = takeFreeSlot();
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
      configured.add(id);
      issued.push({
        judgeId: judgeId(id),
        slot,
        displayName,
        token: credential.token,
      });
    });

    // A judge outside the configured panel becomes inactive but keeps its
    // identity, its slot and its history, so shrinking is reversible.
    for (const row of rows) {
      if (configured.has(row.id) || row.active === 0) continue;
      storage.sql.exec(
        `UPDATE show_judges SET active = 0, deactivated_at = ?
         WHERE show_id = ? AND id = ?`,
        timestamp,
        showIdentifier,
        row.id,
      );
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
        judgeCount: input.judgeNames.length,
        audienceWeight: input.audienceWeight,
      }),
      timestamp,
    );
    return { ok: true, issued, scoringReset: locked };
  });
}
