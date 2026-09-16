import type {
  JudgeShowProjection,
  JudgeSubmission,
  PublicAct,
} from "../../shared/domain";
import { parseJudgeScore, transformJudgeScore } from "../../shared/scoring";
import type { RealtimeConnectionState } from "../realtime/RealtimeClient";

export type JudgeInputStatus = "empty" | "invalid" | "too_long" | "valid";

export interface JudgeInputPreview {
  status: JudgeInputStatus;
  /**
   * The Effective Score: the number the entry evaluates to, before the show's
   * scoring transformation. Null for infinite or unreadable entries.
   */
  evaluated: number | null;
  /** The value that will count after the transformation. */
  effectiveScore: number | null;
  /**
   * Present only when the number that will count differs from the text typed.
   * An ordinary `8` deliberately produces nothing to read.
   */
  transform: string | null;
  /** Why an entry was refused, in the judge's terms. */
  detail: string | null;
}

/** Restrained hints; the field accepts far more than these four. */
export const JUDGE_EXAMPLES: readonly string[] = [
  "8.5",
  "π",
  "1e6",
  "Infinity",
];

/**
 * Local feedback only. The coordinator re-parses and re-transforms every
 * submission, so nothing here can decide what a judge's score actually is.
 */
export function previewJudgeInput(raw: string): JudgeInputPreview {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return {
      status: "empty",
      evaluated: null,
      effectiveScore: null,
      transform: null,
      detail: null,
    };
  }
  const parsed = parseJudgeScore(raw);
  if (!parsed.ok) {
    return {
      status: parsed.reason === "TOO_LONG" ? "too_long" : "invalid",
      evaluated: null,
      effectiveScore: null,
      transform: null,
      detail: parsed.detail,
    };
  }
  const effectiveScore = transformJudgeScore(parsed.parsed);
  if (parsed.parsed.classification !== "FINITE") {
    return {
      status: "valid",
      evaluated: null,
      effectiveScore,
      transform: `counts as ${effectiveScore.toFixed(3)}`,
      detail: null,
    };
  }
  const finiteValue = parsed.parsed.finiteValue;
  if (Math.abs(effectiveScore - finiteValue) > 0.0005) {
    return {
      status: "valid",
      evaluated: finiteValue,
      effectiveScore,
      transform: `counts as ${effectiveScore.toFixed(3)}`,
      detail: null,
    };
  }
  // The taper left the value alone, so only a different spelling is worth
  // echoing back: "π" means something, "8.5" already says itself.
  if (String(finiteValue) !== trimmed) {
    return {
      status: "valid",
      evaluated: finiteValue,
      effectiveScore,
      transform: trimNumber(finiteValue),
      detail: null,
    };
  }
  return {
    status: "valid",
    evaluated: finiteValue,
    effectiveScore,
    transform: null,
    detail: null,
  };
}

function trimNumber(value: number): string {
  return value.toFixed(5).replace(/\.?0+$/u, "");
}

export type JudgeView =
  | { kind: "AUTHENTICATING" }
  | { kind: "REJECTED"; detail: string }
  | { kind: "WAITING" }
  | { kind: "CLOSED"; act: PublicAct }
  | { kind: "OPEN"; act: PublicAct }
  | { kind: "LOCKED"; act: PublicAct; submission: JudgeSubmission };

export interface JudgeInputs {
  connection: RealtimeConnectionState;
  projection: JudgeShowProjection | null;
}

export function deriveJudgeView(inputs: JudgeInputs): JudgeView {
  const { connection, projection } = inputs;
  if (connection === "UNAUTHORISED") {
    return {
      kind: "REJECTED",
      detail:
        "This judging link is not valid. Ask the operator for a new link.",
    };
  }
  if (connection === "INCOMPATIBLE") {
    return {
      kind: "REJECTED",
      detail: "This page is out of date. Reload before scoring.",
    };
  }
  if (!projection) {
    return { kind: "AUTHENTICATING" };
  }
  const act = projection.activeAct;
  if (!act) {
    return { kind: "WAITING" };
  }
  // A submitted score outranks everything: it can never be edited or replaced.
  if (projection.submission) {
    return { kind: "LOCKED", act, submission: projection.submission };
  }
  return projection.permission === "OPEN"
    ? { kind: "OPEN", act }
    : { kind: "CLOSED", act };
}
