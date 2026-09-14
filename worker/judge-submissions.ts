import { parseJudgeScore, transformJudgeScore } from "../shared/scoring";
import { recordAuditEvent } from "./audit";
import {
  actId,
  judgeId,
  showId,
  showRevision,
  type JudgeSubmission,
  type ShowRevision,
} from "../shared/domain";

interface ShowRow extends Record<string, SqlStorageValue> {
  active_act_id: string | null;
  revision: number;
}

interface SubmissionRow extends Record<string, SqlStorageValue> {
  raw_input: string;
  parsed_classification: string;
  finite_value: number | null;
  effective_score: number;
  submitted_at: string;
}

export type JudgeSubmissionFailure =
  | "UNAUTHORISED"
  | "NO_CURRENT_ACT"
  | "VOTING_CLOSED"
  | "INVALID_SCORE"
  | "TOO_LONG";

export type JudgeSubmissionOutcome =
  | {
      ok: true;
      accepted: true;
      submission: JudgeSubmission;
      revision: ShowRevision;
    }
  | {
      ok: true;
      accepted: false;
      submission: JudgeSubmission;
      revision: ShowRevision;
    }
  | { ok: false; code: JudgeSubmissionFailure; revision: ShowRevision };

function toSubmission(
  showIdentifier: string,
  actIdentifier: string,
  judgeIdentifier: string,
  row: SubmissionRow,
): JudgeSubmission {
  const parsed =
    row.parsed_classification === "FINITE"
      ? {
          classification: "FINITE" as const,
          finiteValue: row.finite_value ?? 0,
        }
      : row.parsed_classification === "POSITIVE_INFINITY"
        ? { classification: "POSITIVE_INFINITY" as const, finiteValue: null }
        : { classification: "NEGATIVE_INFINITY" as const, finiteValue: null };
  return {
    showId: showId(showIdentifier),
    actId: actId(actIdentifier),
    judgeId: judgeId(judgeIdentifier),
    input: { raw: row.raw_input },
    parsed,
    effectiveScore: row.effective_score,
    submittedAt: row.submitted_at,
  };
}

function existingSubmission(
  sql: SqlStorage,
  showIdentifier: string,
  actIdentifier: string,
  judgeIdentifier: string,
): JudgeSubmission | null {
  const row = sql
    .exec<SubmissionRow>(
      `SELECT raw_input, parsed_classification, finite_value, effective_score, submitted_at
       FROM judge_submissions
       WHERE show_id = ? AND act_id = ? AND judge_id = ?`,
      showIdentifier,
      actIdentifier,
      judgeIdentifier,
    )
    .toArray()[0];
  return row
    ? toSubmission(showIdentifier, actIdentifier, judgeIdentifier, row)
    : null;
}

function permissionIsOpen(
  sql: SqlStorage,
  showIdentifier: string,
  actIdentifier: string,
  judgeIdentifier: string,
): boolean {
  const specific = sql
    .exec<{ permission_state: string }>(
      `SELECT permission_state FROM judge_permissions
       WHERE show_id = ? AND act_id = ? AND judge_id = ?`,
      showIdentifier,
      actIdentifier,
      judgeIdentifier,
    )
    .toArray()[0];
  if (specific) return specific.permission_state === "OPEN";
  const runtime = sql
    .exec<{ global_judge_permission: string }>(
      "SELECT global_judge_permission FROM show_runtime WHERE show_id = ?",
      showIdentifier,
    )
    .toArray()[0];
  return runtime?.global_judge_permission === "OPEN";
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error && /UNIQUE constraint failed/u.test(error.message)
  );
}

/**
 * The unique primary key is the final immutability barrier.  A duplicate
 * delivery reports the persisted score instead of replacing it.
 */
export function submitJudgeScore(
  storage: DurableObjectStorage,
  showIdentifier: string,
  judgeIdentifier: string,
  raw: string,
): JudgeSubmissionOutcome {
  return storage.transactionSync(() => {
    const show = storage.sql
      .exec<ShowRow>(
        "SELECT active_act_id, revision FROM shows WHERE id = ?",
        showIdentifier,
      )
      .toArray()[0];
    const revision = showRevision(show?.revision ?? 0);
    if (!show) return { ok: false, code: "UNAUTHORISED", revision };
    const judge = storage.sql
      .exec<{ present: number }>(
        `SELECT 1 AS present FROM judges
         WHERE show_id = ? AND id = ? AND revoked_at IS NULL`,
        showIdentifier,
        judgeIdentifier,
      )
      .toArray()[0];
    if (!judge) return { ok: false, code: "UNAUTHORISED", revision };
    if (!show.active_act_id)
      return { ok: false, code: "NO_CURRENT_ACT", revision };

    const locked = existingSubmission(
      storage.sql,
      showIdentifier,
      show.active_act_id,
      judgeIdentifier,
    );
    if (locked)
      return { ok: true, accepted: false, submission: locked, revision };
    if (
      !permissionIsOpen(
        storage.sql,
        showIdentifier,
        show.active_act_id,
        judgeIdentifier,
      )
    ) {
      return { ok: false, code: "VOTING_CLOSED", revision };
    }
    const parsed = parseJudgeScore(raw);
    if (!parsed.ok)
      return {
        ok: false,
        code: parsed.reason === "TOO_LONG" ? "TOO_LONG" : "INVALID_SCORE",
        revision,
      };

    const timestamp = new Date().toISOString();
    const effectiveScore = transformJudgeScore(parsed.parsed);
    try {
      storage.sql.exec(
        `INSERT INTO judge_submissions (
          show_id, act_id, judge_id, raw_input, parsed_classification,
          finite_value, effective_score, submitted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        showIdentifier,
        show.active_act_id,
        judgeIdentifier,
        raw,
        parsed.parsed.classification,
        parsed.parsed.finiteValue,
        effectiveScore,
        timestamp,
      );
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) throw error;
      const existing = existingSubmission(
        storage.sql,
        showIdentifier,
        show.active_act_id,
        judgeIdentifier,
      );
      if (!existing) throw error;
      return { ok: true, accepted: false, submission: existing, revision };
    }
    storage.sql.exec(
      `UPDATE judge_permissions SET permission_state = 'CLOSED', updated_at = ?
       WHERE show_id = ? AND act_id = ? AND judge_id = ?`,
      timestamp,
      showIdentifier,
      show.active_act_id,
      judgeIdentifier,
    );
    const nextRevision = show.revision + 1;
    storage.sql.exec(
      "UPDATE shows SET revision = ?, updated_at = ? WHERE id = ?",
      nextRevision,
      timestamp,
      showIdentifier,
    );
    recordAuditEvent(storage.sql, showIdentifier, {
      type: "judge.submitted",
      actor: "judge",
      data: {
        judgeId: judgeIdentifier,
        actId: show.active_act_id,
        classification: parsed.parsed.classification,
        effectiveScore,
      },
    });
    const submission: JudgeSubmission = {
      showId: showId(showIdentifier),
      actId: actId(show.active_act_id),
      judgeId: judgeId(judgeIdentifier),
      input: { raw },
      parsed: parsed.parsed,
      effectiveScore,
      submittedAt: timestamp,
    };
    return {
      ok: true,
      accepted: true,
      submission,
      revision: showRevision(nextRevision),
    };
  });
}
