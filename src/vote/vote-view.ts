import type {
  AudienceScore,
  AudienceShowProjection,
  PublicAct,
  PublicResults,
} from "../../shared/domain";
import type { RealtimeConnectionState } from "../realtime/RealtimeClient";

/** Why the server refused a vote. Each one needs a different thing said to the voter. */
export type VoteRejection =
  | "VOTING_CLOSED"
  | "ALREADY_VOTED"
  | "WRONG_ACT"
  | "INVALID_SCORE"
  | "BAD_REQUEST"
  | "NETWORK";

export type VoteSubmission =
  | { kind: "idle" }
  | { kind: "selected"; score: AudienceScore }
  | { kind: "confirming"; score: AudienceScore }
  | { kind: "submitting"; score: AudienceScore }
  | { kind: "locked"; score: number | null }
  | { kind: "rejected"; reason: VoteRejection; score: AudienceScore };

export type VoteView =
  | { kind: "CONNECTING" }
  | { kind: "UNAVAILABLE"; detail: string }
  | { kind: "LOBBY" }
  | { kind: "ACT"; act: PublicAct }
  | { kind: "VOTING"; act: PublicAct }
  | { kind: "LOCKED"; act: PublicAct | null; score: number | null }
  | { kind: "CLOSED"; act: PublicAct }
  | { kind: "INTERMISSION"; message: string }
  | { kind: "HOLD" }
  | { kind: "EMERGENCY"; message: string }
  | {
      kind: "RESULTS";
      act: PublicAct | null;
      revealedResult: number | null;
      publicResults: PublicResults | null;
    };

export interface VoteInputs {
  connection: RealtimeConnectionState;
  projection: AudienceShowProjection | null;
  submission: VoteSubmission;
  /** Set once this phone has seen voting open for the current act. */
  sawVotingOpen: boolean;
}

/**
 * One place decides what a phone shows, so the component only renders. Voting
 * and the projector's display mode are independent, and this ordering encodes
 * which one the voter needs to see when both are saying something.
 */
export function deriveVoteView(inputs: VoteInputs): VoteView {
  const { connection, projection, submission, sawVotingOpen } = inputs;

  if (connection === "INCOMPATIBLE") {
    return {
      kind: "UNAVAILABLE",
      detail: "This page is out of date. Reload to keep voting.",
    };
  }
  if (connection === "UNAUTHORISED") {
    return { kind: "UNAVAILABLE", detail: "Voting is not open on this link." };
  }
  if (!projection) {
    return { kind: "CONNECTING" };
  }

  const act = projection.activeAct;
  if (submission.kind === "locked") {
    return { kind: "LOCKED", act, score: submission.score };
  }
  if (projection.show.audienceVoteState === "OPEN" && act) {
    return { kind: "VOTING", act };
  }
  switch (projection.show.displayMode) {
    case "FINAL_RESULTS":
      return {
        kind: "RESULTS",
        act,
        revealedResult: projection.revealedResult,
        publicResults: projection.publicResults,
      };
    case "INTERMISSION":
      return {
        kind: "INTERMISSION",
        message: projection.show.intermissionMessage,
      };
    case "HOLD":
      return { kind: "HOLD" };
    case "EMERGENCY":
      return { kind: "EMERGENCY", message: projection.show.emergencyMessage };
    default:
      break;
  }
  if (!act) {
    return { kind: "LOBBY" };
  }
  return sawVotingOpen ? { kind: "CLOSED", act } : { kind: "ACT", act };
}

/**
 * Closing audience voting must never submit anything. Selecting a score is a
 * purely local choice; only LOCK IN, confirmed, may start a submission. So when
 * the operator closes voting, a selected-but-not-locked score is discarded and
 * the phone moves to "voting closed" with nothing sent.
 *
 * A submission already in flight is deliberately left alone: the server has it
 * and is the only thing that decides whether it counted, so this phone waits
 * for that answer rather than inventing one.
 */
export function discardUnlockedSelection(
  submission: VoteSubmission,
): VoteSubmission {
  return submission.kind === "selected" || submission.kind === "confirming"
    ? { kind: "idle" }
    : submission;
}

/** The connection states worth interrupting a voter about. */
export function connectionNotice(
  connection: RealtimeConnectionState,
): string | null {
  switch (connection) {
    case "RECONNECTING":
      return "Reconnecting…";
    case "DEGRADED":
      return "Connection lost. Retrying…";
    default:
      return null;
  }
}

export function rejectionMessage(reason: VoteRejection): string {
  switch (reason) {
    case "VOTING_CLOSED":
      return "Voting closed before your score was submitted.";
    case "WRONG_ACT":
      return "The act changed before your score arrived.";
    case "INVALID_SCORE":
      return "That score was not accepted. Choose 0 to 10.";
    case "NETWORK":
      return "Your phone lost the connection. Try again.";
    case "ALREADY_VOTED":
      return "This phone has already voted for this act.";
    case "BAD_REQUEST":
      return "Something went wrong. Try again.";
  }
}

export const AUDIENCE_SCORES: readonly AudienceScore[] = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
];
