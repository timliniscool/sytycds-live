import { audienceWeight, isValidAudienceScore } from "../shared/scoring";
import { isRecord } from "../shared/trust";
import { isVoteMilestone, recordAuditEvent } from "./audit";
import {
  actId,
  VOTE_CLOSE_GRACE_MS,
  type AudienceAggregate,
  type AudienceScore,
  type ShowRevision,
} from "../shared/domain";
import {
  cookieHeader,
  generateOpaqueToken,
  isOpaqueToken,
  isSecureRequest,
  parseCookie,
  tokenHash,
  voterCookieName,
} from "./security";

const VOTER_COOKIE_LIFETIME_SECONDS = 180 * 24 * 60 * 60;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;

interface ShowRow extends Record<string, SqlStorageValue> {
  active_act_id: string | null;
  audience_vote_state: string;
  revision: number;
  vote_close_revision: string | null;
  vote_closed_at: number | null;
}

interface AggregateRow extends Record<string, SqlStorageValue> {
  vote_count: number;
  weighted_sum: number;
  total_weight: number;
  weighted_mean: number | null;
}

export interface VoterIdentity {
  hash: ArrayBuffer;
  setCookie?: string;
}

export type VoteFailureCode =
  | "VOTING_CLOSED"
  | "ALREADY_VOTED"
  | "WRONG_ACT"
  | "INVALID_SCORE"
  | "BAD_REQUEST";

export type AudienceVoteResult =
  | { ok: true; revision: ShowRevision; aggregate: AudienceAggregate }
  | { ok: false; code: VoteFailureCode };

export interface AudienceVoteRequest {
  actIdentifier: string;
  score: AudienceScore;
  /**
   * Present when this submission is the phone's automatic response to the
   * operator closing voting: it names the close it is answering. Absent for
   * an ordinary LOCK IN.
   */
  closeRevision?: string;
}

export async function resolveVoterIdentity(
  request: Request,
): Promise<VoterIdentity> {
  const existing = parseCookie(request, voterCookieName());
  if (isOpaqueToken(existing)) {
    // An opaque but altered token is intentionally a different anonymous browser
    // identity. Anonymous web voting cannot prevent deliberate cookie replacement.
    return { hash: await tokenHash(existing) };
  }
  const token = generateOpaqueToken();
  return {
    hash: await tokenHash(token),
    setCookie: cookieHeader({
      name: voterCookieName(),
      value: token,
      maxAgeSeconds: VOTER_COOKIE_LIFETIME_SECONDS,
      sameSite: "Lax",
      secure: isSecureRequest(request),
    }),
  };
}

export async function existingVoterIdentityHash(
  request: Request,
): Promise<ArrayBuffer | null> {
  const token = parseCookie(request, voterCookieName());
  return isOpaqueToken(token) ? tokenHash(token) : null;
}

export function parseAudienceVoteRequest(
  value: unknown,
): ({ ok: true } & AudienceVoteRequest) | { ok: false; code: VoteFailureCode } {
  if (
    !isRecord(value) ||
    typeof value.actId !== "string" ||
    !IDENTIFIER.test(value.actId)
  ) {
    return { ok: false, code: "BAD_REQUEST" };
  }
  if (!isValidAudienceScore(value.score)) {
    return { ok: false, code: "INVALID_SCORE" };
  }
  if (
    value.closeRevision !== undefined &&
    (typeof value.closeRevision !== "string" ||
      !IDENTIFIER.test(value.closeRevision))
  ) {
    return { ok: false, code: "BAD_REQUEST" };
  }
  return {
    ok: true,
    actIdentifier: value.actId,
    score: value.score,
    ...(typeof value.closeRevision === "string"
      ? { closeRevision: value.closeRevision }
      : {}),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error && /UNIQUE constraint failed/u.test(error.message)
  );
}

/**
 * Whether a submission that arrived after CLOSE may still count. Only a phone
 * answering *this* close, for *this* act, inside the grace window qualifies;
 * an ordinary late LOCK IN never does, and a later act or a re-opened and
 * re-closed vote supersedes the identifier entirely.
 */
export function withinCloseGrace(
  show: Pick<ShowRow, "vote_close_revision" | "vote_closed_at">,
  request: AudienceVoteRequest,
  now: number,
): boolean {
  return (
    request.closeRevision !== undefined &&
    show.vote_close_revision !== null &&
    show.vote_closed_at !== null &&
    request.closeRevision === show.vote_close_revision &&
    now - show.vote_closed_at >= 0 &&
    now - show.vote_closed_at <= VOTE_CLOSE_GRACE_MS
  );
}

/** The complete hot path: no historical vote scan and one durable transaction. */
export function submitAudienceVote(
  storage: DurableObjectStorage,
  showIdentifier: string,
  voterHash: ArrayBuffer,
  request: AudienceVoteRequest,
  now: number = Date.now(),
): AudienceVoteResult {
  return storage.transactionSync(() => {
    const show = storage.sql
      .exec<ShowRow>(
        `SELECT s.active_act_id, s.audience_vote_state, s.revision,
                r.vote_close_revision, r.vote_closed_at
         FROM shows s LEFT JOIN show_runtime r ON r.show_id = s.id
         WHERE s.id = ?`,
        showIdentifier,
      )
      .toArray()[0];
    if (!show) {
      return { ok: false, code: "BAD_REQUEST" };
    }
    if (
      show.audience_vote_state !== "OPEN" &&
      !withinCloseGrace(show, request, now)
    ) {
      return { ok: false, code: "VOTING_CLOSED" };
    }
    if (!show.active_act_id || show.active_act_id !== request.actIdentifier) {
      return { ok: false, code: "WRONG_ACT" };
    }
    const weight = audienceWeight(request.score);
    try {
      storage.sql.exec(
        `INSERT INTO audience_votes (
          show_id, act_id, voter_id_hash, score, weight, weighted_score, received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        showIdentifier,
        request.actIdentifier,
        voterHash,
        request.score,
        weight,
        request.score * weight,
        new Date(now).toISOString(),
      );
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        return { ok: false, code: "ALREADY_VOTED" };
      }
      throw error;
    }
    const timestamp = new Date(now).toISOString();
    // The upsert hands back the updated aggregate, so the hot path is one
    // insert, one upsert and one revision bump with no read-back.
    const aggregate = storage.sql
      .exec<AggregateRow>(
        `INSERT INTO audience_aggregates (
          show_id, act_id, vote_count, weighted_sum, total_weight, weighted_mean, updated_at
        ) VALUES (?, ?, 1, ?, ?, ?, ?)
        ON CONFLICT(show_id, act_id) DO UPDATE SET
          vote_count = audience_aggregates.vote_count + 1,
          weighted_sum = audience_aggregates.weighted_sum + excluded.weighted_sum,
          total_weight = audience_aggregates.total_weight + excluded.total_weight,
          weighted_mean = (audience_aggregates.weighted_sum + excluded.weighted_sum) /
            (audience_aggregates.total_weight + excluded.total_weight),
          updated_at = excluded.updated_at
        RETURNING vote_count, weighted_sum, total_weight, weighted_mean`,
        showIdentifier,
        request.actIdentifier,
        request.score * weight,
        weight,
        request.score,
        timestamp,
      )
      .one();
    const revision = show.revision + 1;
    storage.sql.exec(
      "UPDATE shows SET revision = ?, updated_at = ? WHERE id = ?",
      revision,
      timestamp,
      showIdentifier,
    );
    // Milestones only: one line per order of magnitude, not one per vote.
    if (isVoteMilestone(aggregate.vote_count)) {
      recordAuditEvent(storage.sql, showIdentifier, {
        type: "audience.milestone",
        actor: "system",
        data: {
          actId: request.actIdentifier,
          voteCount: aggregate.vote_count,
        },
      });
    }
    return {
      ok: true,
      revision: revision as ShowRevision,
      aggregate: {
        showId: showIdentifier as AudienceAggregate["showId"],
        actId: actId(request.actIdentifier),
        voteCount: aggregate.vote_count,
        weightedSum: aggregate.weighted_sum,
        totalWeight: aggregate.total_weight,
        weightedMean: aggregate.weighted_mean,
      },
    };
  });
}

/**
 * Returns this browser's own accepted score for an act, so a reload restores
 * the locked state instead of appearing to offer a second vote.
 */
export function audienceVoteScore(
  sql: SqlStorage,
  showIdentifier: string,
  actIdentifier: string,
  voterHash: ArrayBuffer,
): number | null {
  const row = sql
    .exec<{ score: number }>(
      `SELECT score FROM audience_votes
       WHERE show_id = ? AND act_id = ? AND voter_id_hash = ?`,
      showIdentifier,
      actIdentifier,
      voterHash,
    )
    .toArray()[0];
  return row ? row.score : null;
}
