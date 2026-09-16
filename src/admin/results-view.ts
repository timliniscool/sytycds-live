import type { AdminRanking, RankingExclusionReason } from "../../shared/domain";

/**
 * Why the ranking is empty, as one sentence naming the next thing to do.
 *
 * A disabled control that says nothing is the worst thing to meet mid-show.
 * The server already reports precisely why each act is excluded; this rolls
 * those reasons up so the operator learns the blocking fact from the panel
 * heading instead of reading the table to discover that, say, four acts are
 * scored and simply waiting for FINALISE.
 *
 * The order is deliberate: it names the reason closest to producing a ranking
 * first, because that is the action worth taking now.
 */
export function whyNothingIsEligible(ranking: AdminRanking): string {
  const acts = ranking.incomplete;
  if (acts.length === 0)
    return ranking.withdrawn.length > 0
      ? "Every act has been withdrawn, so there is nothing to rank."
      : "No act has been scored yet. Results appear here once an act is finalised.";

  const count = (reason: RankingExclusionReason) =>
    acts.filter((entry) => entry.reason === reason).length;
  const subject = (total: number) => (total === 1 ? "act is" : "acts are");

  const unfinalised = count("NOT_FINALISED");
  if (unfinalised > 0)
    return `${unfinalised} ${subject(unfinalised)} fully scored and waiting for FINALISE. Nothing can be ranked until then.`;

  if (count("JUDGES_NOT_CONFIGURED") > 0)
    return "Judges carry weight but no judge panel is configured. Add judges in Setup before results can be ranked.";

  const missingJudges = count("JUDGE_SCORE_MISSING");
  if (missingJudges > 0)
    return `${missingJudges} ${subject(missingJudges)} still waiting on judge scores. The table below names the judges.`;

  const audience = count("AUDIENCE_RESULT_INCOMPLETE");
  if (audience > 0)
    return `${audience} ${subject(audience)} missing an audience result. Open audience voting for them, or set the audience weight to zero.`;

  return "No act is eligible to be ranked yet.";
}

/** Exactly why one act is not in the ranking, in a line the operator can act on. */
export function exclusionLabel(
  reason: RankingExclusionReason,
  missingJudgeSlots: readonly number[],
): string {
  switch (reason) {
    case "NOT_FINALISED":
      return "scoring complete — press FINALISE";
    case "AUDIENCE_RESULT_INCOMPLETE":
      return "audience result incomplete";
    case "JUDGE_SCORE_MISSING":
      return missingJudgeSlots.length === 1
        ? `judge ${missingJudgeSlots[0]} has not scored`
        : `judges ${missingJudgeSlots.join(", ")} have not scored`;
    case "JUDGES_NOT_CONFIGURED":
      return "no judge panel configured";
  }
}
