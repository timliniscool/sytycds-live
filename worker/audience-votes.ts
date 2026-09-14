import { audienceWeight, isValidAudienceScore } from "../shared/scoring";
import { isRecord } from "../shared/trust";
import {
  actId,
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

export function parseAudienceVoteRequest(
  value: unknown,
):
  | { ok: true; actIdentifier: string; score: AudienceScore }
  | { ok: false; code: VoteFailureCode } {
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
  return { ok: true, actIdentifier: value.actId, score: value.score };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error && /UNIQUE constraint failed/u.test(error.message)
  );
}

/** The complete hot path: no historical vote scan and one durable transaction. */
export function submitAudienceVote(
  storage: DurableObjectStorage,
  showIdentifier: string,
  voterHash: ArrayBuffer,
  request: { actIdentifier: string; score: AudienceScore },
): AudienceVoteResult {
  return storage.transactionSync(() => {
    const show = storage.sql
      .exec<ShowRow>(
        `SELECT active_act_id, audience_vote_state, revision
         FROM shows WHERE id = ?`,
        showIdentifier,
      )
      .toArray()[0];
    if (!show) {
      return { ok: false, code: "BAD_REQUEST" };
    }
    if (show.audience_vote_state !== "OPEN") {
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
        new Date().toISOString(),
      );
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        return { ok: false, code: "ALREADY_VOTED" };
      }
      throw error;
    }
    storage.sql.exec(
      `INSERT INTO audience_aggregates (
        show_id, act_id, vote_count, weighted_sum, total_weight, weighted_mean, updated_at
      ) VALUES (?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(show_id, act_id) DO UPDATE SET
        vote_count = audience_aggregates.vote_count + 1,
        weighted_sum = audience_aggregates.weighted_sum + excluded.weighted_sum,
        total_weight = audience_aggregates.total_weight + excluded.total_weight,
        weighted_mean = (audience_aggregates.weighted_sum + excluded.weighted_sum) /
          (audience_aggregates.total_weight + excluded.total_weight),
        updated_at = excluded.updated_at`,
      showIdentifier,
      request.actIdentifier,
      request.score * weight,
      weight,
      request.score,
      new Date().toISOString(),
    );
    const revision = show.revision + 1;
    storage.sql.exec(
      "UPDATE shows SET revision = ?, updated_at = ? WHERE id = ?",
      revision,
      new Date().toISOString(),
      showIdentifier,
    );
    const aggregate = storage.sql
      .exec<AggregateRow>(
        `SELECT vote_count, weighted_sum, total_weight, weighted_mean
         FROM audience_aggregates WHERE show_id = ? AND act_id = ?`,
        showIdentifier,
        request.actIdentifier,
      )
      .one();
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
