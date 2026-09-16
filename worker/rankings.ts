import {
  actId,
  INHERITED_APPEARANCE,
  type AdminRanking,
  type PublicResults,
  type RankingExclusionReason,
  type ResultsStage,
} from "../shared/domain";
import { publicResultsFor, rankActs } from "../shared/ranking";
import { actIdentity } from "../shared/act-identity";
import { operationalResult } from "./results";

interface RankingRow extends Record<string, SqlStorageValue> {
  id: string;
  order_index: number;
  performer_name: string;
  group_name: string;
  performer_display_mode: string;
  school_year: string;
  act_name: string;
  act_type: string;
  public_description: string;
  withdrawn_at: string | null;
  final_score: number | null;
  frozen_performer_name: string | null;
  frozen_performer_subtitle: string | null;
  frozen_act_name: string | null;
  frozen_school_year: string | null;
  frozen_act_type: string | null;
}

/**
 * Rankings read only frozen results. Live aggregates and provisional values are
 * deliberately not joined here: a completed show ranks on frozen numbers, so a
 * stray late vote can never reorder a published leaderboard.
 *
 * The identity shown beside each rank is the frozen one too. Renaming a
 * performer after their result was finalised changes nothing about a published
 * result, and — because the score is frozen with it — cannot move a rank.
 */
export function loadRanking(
  sql: SqlStorage,
  showIdentifier: string,
): AdminRanking {
  const rows = sql
    .exec<RankingRow>(
      `SELECT a.id, a.order_index, a.performer_name, a.group_name,
              a.performer_display_mode, a.school_year, a.act_name,
              a.act_type, a.public_description, a.withdrawn_at, r.final_score,
              r.performer_name AS frozen_performer_name,
              r.performer_subtitle AS frozen_performer_subtitle,
              r.act_name AS frozen_act_name,
              r.school_year AS frozen_school_year,
              r.act_type AS frozen_act_type
       FROM acts a LEFT JOIN finalised_results_v2 r
         ON r.show_id = a.show_id AND r.act_id = a.id
       WHERE a.show_id = ? ORDER BY a.order_index`,
      showIdentifier,
    )
    .toArray();
  return rankActs(
    rows.map((row) => {
      const frozen = row.final_score !== null;
      const performers = sql
        .exec<{ id: string; display_name: string }>(
          `SELECT id, display_name FROM act_performers
           WHERE show_id = ? AND act_id = ? ORDER BY position`,
          showIdentifier,
          row.id,
        )
        .toArray()
        .map((member) => ({ id: member.id, name: member.display_name }));
      const liveIdentity = actIdentity({
        performerName: row.performer_name,
        performers,
        performerCount: performers.length || 1,
        groupName: row.group_name,
        performerDisplayMode: row.performer_display_mode as
          | "AUTOMATIC"
          | "GROUP_NAME_ONLY"
          | "GROUP_NAME_AND_MEMBERS"
          | "MEMBER_NAMES"
          | "PERFORMER_COUNT",
      });
      const exclusion =
        frozen || row.withdrawn_at !== null
          ? null
          : rankingExclusion(sql, showIdentifier, row.id);
      return {
        act: {
          id: actId(row.id),
          order: row.order_index,
          // A frozen result carries the identity it was finalised with; a live
          // act carries its current one.
          performerName: frozen
            ? (row.frozen_performer_name ?? liveIdentity.primary)
            : liveIdentity.primary,
          performers,
          performerCount: performers.length || 1,
          groupName: row.group_name,
          performerDisplayMode: row.performer_display_mode as
            | "AUTOMATIC"
            | "GROUP_NAME_ONLY"
            | "GROUP_NAME_AND_MEMBERS"
            | "MEMBER_NAMES"
            | "PERFORMER_COUNT",
          schoolYear: frozen
            ? (row.frozen_school_year ?? row.school_year)
            : row.school_year,
          actName: frozen
            ? (row.frozen_act_name ?? row.act_name)
            : row.act_name,
          actType: frozen
            ? (row.frozen_act_type ?? row.act_type)
            : row.act_type,
          publicDescription: row.public_description,
          withdrawn: row.withdrawn_at !== null,
          appearance: INHERITED_APPEARANCE,
        },
        finalScore: row.final_score,
        performerSubtitle: frozen
          ? row.frozen_performer_subtitle
          : liveIdentity.secondary,
        ...(exclusion ?? {}),
      };
    }),
  );
}

/** Turns an act's operational result into the one thing the operator must fix. */
function rankingExclusion(
  sql: SqlStorage,
  showIdentifier: string,
  actIdentifier: string,
): {
  reason: RankingExclusionReason;
  missingJudgeSlots: readonly number[];
} {
  const result = operationalResult(sql, showIdentifier, actIdentifier);
  if (result.kind !== "incomplete")
    return { reason: "NOT_FINALISED", missingJudgeSlots: [] };
  if (result.judgeConfigurationMissing)
    return { reason: "JUDGES_NOT_CONFIGURED", missingJudgeSlots: [] };
  if (result.missingJudgeSlots.length > 0)
    return {
      reason: "JUDGE_SCORE_MISSING",
      missingJudgeSlots: result.missingJudgeSlots,
    };
  return { reason: "AUDIENCE_RESULT_INCOMPLETE", missingJudgeSlots: [] };
}

export function loadPublicResults(
  sql: SqlStorage,
  showIdentifier: string,
  stage: ResultsStage,
  revealedGroups: number,
): PublicResults | null {
  if (stage === "HIDDEN") return null;
  return publicResultsFor(
    loadRanking(sql, showIdentifier).ranked,
    stage,
    revealedGroups,
  );
}
