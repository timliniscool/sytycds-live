import type {
  AdminRanking,
  PublicAct,
  PublicResults,
  RankingEntry,
  RankingExclusionReason,
  ResultsStage,
} from "./domain";

/** One act as the ranking sees it: identity plus its frozen final score, if any. */
export interface RankingInput {
  act: PublicAct;
  /** Only a finalised score ranks. Provisional live values never enter here. */
  finalScore: number | null;
  /** Why this act has no frozen score yet, for the operator's missing list. */
  reason?: RankingExclusionReason;
  missingJudgeSlots?: readonly number[];
}

/**
 * The single documented equality policy for ranking. Frozen final scores are
 * IEEE-754 doubles produced by one formula version, so equality is exact on the
 * stored value: two acts rank together only when their stored numbers are the
 * same number. Rounded display strings are never compared, so 8.004 and 8.0044
 * are two ranks even though both read "8.00" on the projector.
 */
export function sameFinalScore(left: number, right: number): boolean {
  return left === right;
}

/**
 * Dense ("1223") ranking over frozen final scores: equal scores share a rank
 * and the next distinct score takes the very next rank number. Five acts tied
 * at the top are all rank 1 and the next distinct score is rank 2. Running
 * order only fixes the display sequence inside a tie group, so the output is
 * deterministic.
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
  let rank = 0;
  eligible.forEach((input, index) => {
    const previous = eligible[index - 1];
    const next = eligible[index + 1];
    const sameAsPrevious =
      previous !== undefined &&
      sameFinalScore(previous.finalScore, input.finalScore);
    if (!sameAsPrevious) rank += 1;
    ranked.push({
      actId: input.act.id,
      rank,
      tied:
        sameAsPrevious ||
        (next !== undefined &&
          sameFinalScore(next.finalScore, input.finalScore)),
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
      .sort((left, right) => left.act.order - right.act.order)
      .map((input) => ({
        act: input.act,
        reason: input.reason ?? "NOT_FINALISED",
        missingJudgeSlots: input.missingJudgeSlots ?? [],
      })),
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
 * The podium is the top three *rank numbers*, not the top three acts, so two
 * joint firsts leave one second and one third on the podium.
 */
export const PODIUM_RANKS = 3;

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
        entries: ranked.filter((entry) => entry.rank <= PODIUM_RANKS),
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
