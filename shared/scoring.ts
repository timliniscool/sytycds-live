import {
  evaluateMathExpression,
  isSimpleValue,
  parseMathExpression,
  type MathNode,
} from "./math-expression";
import {
  isAudienceScore,
  type AudienceScore,
  type EffectiveJudgeScore,
  type ParsedJudgeScore,
} from "./domain";

export const AUDIENCE_WEIGHTS: Readonly<Record<AudienceScore, number>> = {
  0: 0.5,
  1: 0.75,
  2: 0.95,
  3: 1,
  4: 0.9,
  5: 0.7,
  6: 0.9,
  7: 1,
  8: 0.95,
  9: 0.75,
  10: 0.5,
};

export interface ScoringAggregate {
  count: number;
  weightedSum: number;
  totalWeight: number;
  weightedMean: number | null;
}

export const emptyScoringAggregate = (): ScoringAggregate => ({
  count: 0,
  weightedSum: 0,
  totalWeight: 0,
  weightedMean: null,
});

export function audienceWeight(score: AudienceScore): number {
  return AUDIENCE_WEIGHTS[score];
}

export function addAudienceScore(
  aggregate: ScoringAggregate,
  score: AudienceScore,
): ScoringAggregate {
  const weight = audienceWeight(score);
  const weightedSum = aggregate.weightedSum + score * weight;
  const totalWeight = aggregate.totalWeight + weight;
  return {
    count: aggregate.count + 1,
    weightedSum,
    totalWeight,
    weightedMean: weightedSum / totalWeight,
  };
}

export const isValidAudienceScore = isAudienceScore;

export const JUDGE_TAPER_K = 0.1053605156578263;
export const JUDGE_TAPER_P = 0.3259064530714697;
export const MAX_JUDGE_INPUT_LENGTH = 128;

const FINITE_NUMBER = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/;
const PI = /^[+-]?(?:pi|π)$/iu;
const POSITIVE_INFINITY = /^\+?(?:inf|infinity)$/iu;
const NEGATIVE_INFINITY = /^-(?:inf|infinity)$/iu;

export type JudgeScoreParseResult =
  | { ok: true; parsed: ParsedJudgeScore }
  | { ok: false; reason: "INVALID" | "TOO_LONG"; detail: string };

/**
 * Parses a judge's entry. Plain numbers, π and ∞ take the fast path; anything
 * else is read by the closed expression language in `math-expression.ts`,
 * which never evaluates code. A value that overflows to ±∞ is classified as
 * infinite on purpose, so "10^400" counts the same as "infinity"; NaN is
 * refused rather than stored.
 */
export function parseJudgeScore(raw: string): JudgeScoreParseResult {
  if (raw.length > MAX_JUDGE_INPUT_LENGTH) {
    return { ok: false, reason: "TOO_LONG", detail: "That entry is too long" };
  }
  const value = raw.trim();
  if (value.length === 0) {
    return { ok: false, reason: "INVALID", detail: "Enter a score" };
  }
  if (POSITIVE_INFINITY.test(value)) {
    return {
      ok: true,
      parsed: { classification: "POSITIVE_INFINITY", finiteValue: null },
    };
  }
  if (NEGATIVE_INFINITY.test(value)) {
    return {
      ok: true,
      parsed: { classification: "NEGATIVE_INFINITY", finiteValue: null },
    };
  }
  if (PI.test(value)) {
    return {
      ok: true,
      parsed: {
        classification: "FINITE",
        finiteValue: value.startsWith("-") ? -Math.PI : Math.PI,
      },
    };
  }
  if (FINITE_NUMBER.test(value)) {
    const finiteValue = Number(value);
    return Number.isFinite(finiteValue)
      ? { ok: true, parsed: { classification: "FINITE", finiteValue } }
      : {
          ok: false,
          reason: "INVALID",
          detail: "That number is too large to store",
        };
  }
  const parsed = parseMathExpression(value);
  if (!parsed.ok)
    return { ok: false, reason: "INVALID", detail: parsed.detail };
  const evaluated = evaluateMathExpression(parsed.node);
  if (!evaluated.ok)
    return { ok: false, reason: "INVALID", detail: evaluated.detail };
  return { ok: true, parsed: classifyValue(evaluated.value) };
}

/** Maps an evaluated number onto the persisted classification. */
export function classifyValue(value: number): ParsedJudgeScore {
  if (value === Infinity)
    return { classification: "POSITIVE_INFINITY", finiteValue: null };
  if (value === -Infinity)
    return { classification: "NEGATIVE_INFINITY", finiteValue: null };
  // -0 would round-trip through SQLite and JSON as 0 anyway; say so up front.
  return { classification: "FINITE", finiteValue: value === 0 ? 0 : value };
}

/**
 * How an entered score should be shown: a plain number or single constant
 * reads best exactly as typed; anything richer is typeset from its tree.
 */
export function describeJudgeEntry(
  raw: string,
): { kind: "plain"; text: string } | { kind: "expression"; node: MathNode } {
  const text = raw.trim();
  const parsed = parseMathExpression(text);
  if (!parsed.ok || isSimpleValue(parsed.node)) return { kind: "plain", text };
  return { kind: "expression", node: parsed.node };
}

export function transformJudgeScore(
  parsed: ParsedJudgeScore,
): EffectiveJudgeScore {
  if (parsed.classification === "POSITIVE_INFINITY") {
    return 15;
  }
  if (parsed.classification === "NEGATIVE_INFINITY") {
    return -5;
  }
  const x = parsed.finiteValue;
  if (x >= 0 && x <= 10) {
    return x;
  }
  if (x > 10) {
    return 10 + 5 * (1 - Math.exp(-JUDGE_TAPER_K * (x - 10) ** JUDGE_TAPER_P));
  }
  return -5 * (1 - Math.exp(-JUDGE_TAPER_K * (-x) ** JUDGE_TAPER_P));
}

export type FinalScoreResult =
  | { kind: "complete"; value: number }
  | {
      kind: "incomplete";
      missingJudges: readonly number[];
      audienceMissing: boolean;
      judgeConfigurationMissing?: boolean;
    };

export function calculateFinalScore(
  judgeScores: readonly (EffectiveJudgeScore | null | undefined)[],
  audienceMean: number | null | undefined,
  audienceAllocation = 0.5,
): FinalScoreResult {
  if (
    !Number.isFinite(audienceAllocation) ||
    audienceAllocation < 0 ||
    audienceAllocation > 1
  ) {
    throw new RangeError("Audience allocation must be between zero and one");
  }
  const judgeAllocation = 1 - audienceAllocation;
  const missingJudges = judgeScores
    .map((score, index) =>
      score === null || score === undefined ? index + 1 : null,
    )
    .filter((index): index is number => index !== null);
  const audienceMissing =
    audienceAllocation > 0 &&
    (audienceMean === null || audienceMean === undefined);
  const judgeConfigurationMissing =
    judgeAllocation > 0 && judgeScores.length === 0;
  if (
    (judgeAllocation > 0 && missingJudges.length > 0) ||
    audienceMissing ||
    judgeConfigurationMissing
  ) {
    return {
      kind: "incomplete",
      missingJudges,
      audienceMissing,
      ...(judgeConfigurationMissing ? { judgeConfigurationMissing: true } : {}),
    };
  }
  let value = 0;
  if (audienceAllocation > 0) value += audienceAllocation * audienceMean!;
  if (judgeAllocation > 0) {
    const judgeTotal = judgeScores.reduce<number>(
      (sum, score) => sum + score!,
      0,
    );
    value += judgeAllocation * (judgeTotal / judgeScores.length);
  }
  return {
    kind: "complete",
    value,
  };
}
