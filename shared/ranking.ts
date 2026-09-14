import type {
  AdminRanking,
  PublicAct,
  PublicResults,
  RankingEntry,
  ResultsStage,
} from "./domain";

/** One act as the ranking sees it: identity plus its frozen final score, if any. */
export interface RankingInput {
  act: PublicAct;
  /** Only a finalised score ranks. Provisional live values never enter here. */
  finalScore: number | null;
}

/**
 * Competition ("1224") ranking over frozen final scores. Equality is exact on
 * the stored value: two acts that finalised to the same number are a tie and
 * are never separated by an invented rule. Running order only fixes the
 * display sequence inside a tie group, so the output is deterministic.
 */
export function rankActs(inputs: readonly RankingInput[]): AdminRanking {
  const eligible = inputs.filter(
    (input): input is RankingInput & { finalScore: number } =>
      !input.act.withdrawn && input.finalScore !== null,
  );
  eligible.sort(
    (left, right) =>
      right.finalScore - left.finalScore || left.act.order - right.act.order,
  );

  const ranked: RankingEntry[] = [];
  eligible.forEach((input, index) => {
    const previous = eligible[index - 1];
    const rank =
      previous && previous.finalScore === input.finalScore
        ? (ranked[index - 1]?.rank ?? index + 1)
        : index + 1;
    const next = eligible[index + 1];
    const tied =
      (previous !== undefined && previous.finalScore === input.finalScore) ||
      (next !== undefined && next.finalScore === input.finalScore);
    ranked.push({
      actId: input.act.id,
      rank,
      tied,
      finalScore: input.finalScore,
      performerName: input.act.performerName,
      actName: input.act.actName,
      schoolYear: input.act.schoolYear,
      actType: input.act.actType,
    });
  });

  return {
    ranked,
    incomplete: inputs
      .filter((input) => !input.act.withdrawn && input.finalScore === null)
      .map((input) => input.act)
      .sort((left, right) => left.order - right.order),
    withdrawn: inputs
      .filter((input) => input.act.withdrawn)
      .map((input) => input.act)
      .sort((left, right) => left.order - right.order),
  };
}

/** Distinct ranks in ascending order; a tie group is one element. */
export function rankGroups(ranked: readonly RankingEntry[]): number[] {
  return [...new Set(ranked.map((entry) => entry.rank))].sort(
    (left, right) => left - right,
  );
}

/**
 * The server-side projection boundary for rankings. Everything the public may
 * not see yet is absent from the result, not merely flagged.
 */
export function publicResultsFor(
  ranked: readonly RankingEntry[],
  stage: ResultsStage,
  revealedGroups: number,
): PublicResults | null {
  if (stage === "HIDDEN") return null;
  const groups = rankGroups(ranked);
  switch (stage) {
    case "LEADERBOARD":
      return {
        stage,
        entries: ranked,
        pendingGroups: 0,
        totalGroups: groups.length,
      };
    case "STAGED": {
      const shown = Math.min(Math.max(revealedGroups, 0), groups.length);
      // Reveal proceeds from last place upwards; a tie group appears whole.
      const visibleRanks = new Set(groups.slice(groups.length - shown));
      return {
        stage,
        entries: ranked.filter((entry) => visibleRanks.has(entry.rank)),
        pendingGroups: groups.length - shown,
        totalGroups: groups.length,
      };
    }
    case "TOP_THREE":
      return {
        stage,
        entries: ranked.filter((entry) => entry.rank <= 3),
        pendingGroups: 0,
        totalGroups: groups.length,
      };
    case "WINNER":
      return {
        stage,
        entries: ranked.filter((entry) => entry.rank === 1),
        pendingGroups: 0,
        totalGroups: groups.length,
      };
  }
}
