import {
  actId,
  type AdminRanking,
  type PublicResults,
  type ResultsStage,
} from "../shared/domain";
import { publicResultsFor, rankActs } from "../shared/ranking";

interface RankingRow extends Record<string, SqlStorageValue> {
  id: string;
  order_index: number;
  performer_name: string;
  school_year: string;
  act_name: string;
  act_type: string;
  public_description: string;
  withdrawn_at: string | null;
  final_score: number | null;
}

/**
 * Rankings read only `finalised_results`. Live aggregates and provisional
 * values are deliberately not joined here: a completed show ranks on frozen
 * numbers, and a stray late vote can never reorder a published leaderboard.
 */
export function loadRanking(
  sql: SqlStorage,
  showIdentifier: string,
): AdminRanking {
  const rows = sql
    .exec<RankingRow>(
      `SELECT a.id, a.order_index, a.performer_name, a.school_year, a.act_name,
              a.act_type, a.public_description, a.withdrawn_at, r.final_score
       FROM acts a LEFT JOIN finalised_results r
         ON r.show_id = a.show_id AND r.act_id = a.id
       WHERE a.show_id = ? ORDER BY a.order_index`,
      showIdentifier,
    )
    .toArray();
  return rankActs(
    rows.map((row) => ({
      act: {
        id: actId(row.id),
        order: row.order_index,
        performerName: row.performer_name,
        schoolYear: row.school_year,
        actName: row.act_name,
        actType: row.act_type,
        publicDescription: row.public_description,
        withdrawn: row.withdrawn_at !== null,
      },
      finalScore: row.final_score,
    })),
  );
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
