import type {
  AudienceAggregate,
  ParsedJudgeScore,
  ScoreboardJudge,
} from "../../shared/domain";

/** Raw text longer than this is replaced by a formatted value on the wall. */
const MAX_RAW_LENGTH = 7;

export interface JudgeTile {
  name: string;
  /** The value the hall reads; `WAITING` while nothing has been submitted. */
  primary: string;
  /** The tapered score, shown only when it differs from what was typed. */
  secondary: string | null;
  waiting: boolean;
}

export function formatScore(value: number, digits = 2): string {
  return value.toFixed(digits);
}

function formatParsed(parsed: ParsedJudgeScore): string {
  switch (parsed.classification) {
    case "POSITIVE_INFINITY":
      return "∞";
    case "NEGATIVE_INFINITY":
      return "−∞";
    case "FINITE": {
      const value = parsed.finiteValue;
      if (Math.abs(value) >= 1e6 || (value !== 0 && Math.abs(value) < 1e-3)) {
        return value.toExponential(2).replace("+", "");
      }
      return value.toFixed(3).replace(/\.?0+$/u, "");
    }
  }
}

/**
 * Judges may type anything the scoring grammar accepts, so the tile shows the
 * raw text when it is short enough to read at range and a formatted value
 * otherwise. The effective score appears as context only when the taper or a
 * symbol changed what counts. A missing judge is never a zero.
 */
export function judgeTile(judge: ScoreboardJudge): JudgeTile {
  if (!judge.submission) {
    return {
      name: judge.displayName,
      primary: "WAITING",
      secondary: null,
      waiting: true,
    };
  }
  const { raw, parsed, effectiveScore } = judge.submission;
  const trimmed = raw.trim();
  const primary =
    trimmed.length <= MAX_RAW_LENGTH ? trimmed : formatParsed(parsed);
  const differs =
    parsed.classification !== "FINITE" ||
    Math.abs(parsed.finiteValue - effectiveScore) > 0.0005;
  return {
    name: judge.displayName,
    primary,
    secondary: differs ? `counts as ${formatScore(effectiveScore)}` : null,
    waiting: false,
  };
}

export interface AudienceReadout {
  score: string;
  count: number;
  hasVotes: boolean;
}

export function audienceReadout(
  aggregate: AudienceAggregate | null,
): AudienceReadout {
  if (
    !aggregate ||
    aggregate.voteCount === 0 ||
    aggregate.weightedMean === null
  ) {
    return { score: "—", count: 0, hasVotes: false };
  }
  return {
    score: formatScore(aggregate.weightedMean),
    count: aggregate.voteCount,
    hasVotes: true,
  };
}

/**
 * Representational interpolation for the audience number: the authoritative
 * value is whatever the aggregate says, and the animation only decides which
 * digits are painted on the way there.
 */
export function stepTowards(
  displayed: number,
  target: number,
  elapsedMs: number,
  durationMs: number,
): number {
  if (durationMs <= 0 || elapsedMs >= durationMs) return target;
  const progress = elapsedMs / durationMs;
  const eased = 1 - (1 - progress) ** 3;
  return displayed + (target - displayed) * eased;
}
