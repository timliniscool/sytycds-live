import { calculateFinalScore } from "../shared/scoring";
import { type OperationalResult } from "../shared/domain";

interface ResultInputRow extends Record<string, SqlStorageValue> {
  slot: number;
  effective_score: number | null;
}

interface FinalisedRow extends Record<string, SqlStorageValue> {
  final_score: number;
  finalised_at: string;
}

function inputs(
  sql: SqlStorage,
  showIdentifier: string,
  actIdentifier: string,
): {
  scores: (number | null)[];
  audienceMean: number | null;
} {
  const rows = sql
    .exec<ResultInputRow>(
      `SELECT j.slot, s.effective_score
       FROM judges j LEFT JOIN judge_submissions s
         ON s.show_id = j.show_id AND s.judge_id = j.id AND s.act_id = ?
       WHERE j.show_id = ? AND j.revoked_at IS NULL ORDER BY j.slot`,
      actIdentifier,
      showIdentifier,
    )
    .toArray();
  const scores = [1, 2, 3, 4].map(
    (slot) => rows.find((row) => row.slot === slot)?.effective_score ?? null,
  );
  const audience = sql
    .exec<{ weighted_mean: number | null; vote_count: number }>(
      `SELECT weighted_mean, vote_count FROM audience_aggregates
       WHERE show_id = ? AND act_id = ?`,
      showIdentifier,
      actIdentifier,
    )
    .toArray()[0];
  return {
    scores,
    audienceMean:
      audience && audience.vote_count > 0 ? audience.weighted_mean : null,
  };
}

/** A result is always explicit about whether it can safely be used. */
export function operationalResult(
  sql: SqlStorage,
  showIdentifier: string,
  actIdentifier: string,
): OperationalResult {
  const finalised = sql
    .exec<FinalisedRow>(
      "SELECT final_score, finalised_at FROM finalised_results WHERE show_id = ? AND act_id = ?",
      showIdentifier,
      actIdentifier,
    )
    .toArray()[0];
  if (finalised)
    return {
      kind: "finalised",
      value: finalised.final_score,
      finalisedAt: finalised.finalised_at,
    };
  const { scores, audienceMean } = inputs(sql, showIdentifier, actIdentifier);
  const calculated = calculateFinalScore(scores, audienceMean);
  return calculated.kind === "complete"
    ? { kind: "provisional", value: calculated.value }
    : {
        kind: "incomplete",
        missingJudgeSlots: calculated.missingJudges,
        audienceMissing: calculated.audienceMissing,
      };
}

export type FinaliseResult =
  | { ok: true; result: Extract<OperationalResult, { kind: "finalised" }> }
  | { ok: false; reason: string };

/** Persist the exact scoring inputs and output; future implementation changes cannot rewrite history. */
export function finaliseResult(
  sql: SqlStorage,
  showIdentifier: string,
  actIdentifier: string,
): FinaliseResult {
  {
    const existing = operationalResult(sql, showIdentifier, actIdentifier);
    if (existing.kind === "finalised") return { ok: true, result: existing };
    if (existing.kind === "incomplete")
      return {
        ok: false,
        reason:
          "A final result requires at least one audience vote and all four judge submissions",
      };
    const { scores, audienceMean } = inputs(sql, showIdentifier, actIdentifier);
    if (audienceMean === null || scores.some((score) => score === null)) {
      return { ok: false, reason: "Result inputs changed while finalising" };
    }
    const timestamp = new Date().toISOString();
    sql.exec(
      `INSERT INTO finalised_results (
        show_id, act_id, audience_mean, judge_1_effective_score,
        judge_2_effective_score, judge_3_effective_score, judge_4_effective_score,
        final_score, finalised_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      showIdentifier,
      actIdentifier,
      audienceMean,
      scores[0] ?? 0,
      scores[1] ?? 0,
      scores[2] ?? 0,
      scores[3] ?? 0,
      existing.value,
      timestamp,
    );
    sql.exec(
      `INSERT INTO result_snapshots (
        show_id, act_id, revision, audience_mean, judge_scores_json, final_score, captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      showIdentifier,
      actIdentifier,
      sql
        .exec<{ revision: number }>(
          "SELECT revision FROM shows WHERE id = ?",
          showIdentifier,
        )
        .one().revision,
      audienceMean,
      JSON.stringify(scores),
      existing.value,
      timestamp,
    );
    return {
      ok: true,
      result: {
        kind: "finalised",
        value: existing.value,
        finalisedAt: timestamp,
      },
    };
  }
}

export function revealedFinalScore(
  sql: SqlStorage,
  showIdentifier: string,
  actIdentifier: string | null,
  revealed: boolean,
): number | null {
  if (!revealed || !actIdentifier) return null;
  const result = operationalResult(sql, showIdentifier, actIdentifier);
  return result.kind === "finalised" ? result.value : null;
}
