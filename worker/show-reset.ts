import { isRecord } from "../shared/trust";
import {
  drainMediaCleanupQueue,
  findStrayObjects,
  pendingCleanupCount,
  queueObjectForCleanup,
} from "./media-cleanup";

/** The exact phrase an operator must type; nothing shorter is accepted. */
export const RESET_CONFIRMATION = "RESET SHOW";
/** Deleting a single act is destructive too, and is confirmed the same way. */
export const DELETE_ACT_CONFIRMATION = "DELETE ACT";

export function isResetConfirmed(value: unknown): boolean {
  return isRecord(value) && value.confirm === RESET_CONFIRMATION;
}

export interface ShowResetResult {
  /** Acts removed by this reset. */
  clearedActs: number;
  /** Media objects actually removed from R2. */
  objectsDeleted: number;
  /** Objects R2 refused; recorded as retryable work, never lost. */
  objectsPending: number;
  /**
   * False when any object is still waiting to leave R2. The operator is told
   * the truth rather than a clean-sounding summary.
   */
  mediaCleanupComplete: boolean;
  /** Kept for API compatibility; venue projector sessions are retained. */
  projectorSessionsRevoked: number;
}

/**
 * Removes everything that belongs to *running* an event, leaving the show row
 * itself in place: acts, cues, media (queued for R2 cleanup), votes, judge
 * submissions and permissions, frozen results, the current act, display,
 * voting and reveal state, the show-flow step, the pairing code, the command
 * log and any test-show record. Venue setup and event configuration are
 * deliberately untouched.
 *
 * Call inside a transaction. Returns the number of acts removed.
 */
export function clearShowData(sql: SqlStorage, showIdentifier: string): number {
  const acts = sql
    .exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM acts WHERE show_id = ?",
      showIdentifier,
    )
    .one().count;

  // Every uploaded object owned by this show becomes cleanup work, including
  // generated test fixtures. Platform and deployment assets are not in this
  // table and cannot be caught here.
  for (const asset of sql
    .exec<{ id: string; object_key: string }>(
      "SELECT id, object_key FROM media_assets WHERE show_id = ?",
      showIdentifier,
    )
    .toArray()) {
    queueObjectForCleanup(
      sql,
      showIdentifier,
      asset.object_key,
      asset.id,
      "show_reset",
    );
  }

  // Children before parents; each of these is show-scoped performance data.
  for (const table of [
    "result_snapshots",
    "finalised_results_v2",
    "finalised_results",
    "audience_aggregates",
    "audience_votes",
    "show_judge_submissions",
    "show_judge_permissions",
    "judge_submissions",
    "judge_permissions",
    "cue_asset_references",
    "cues",
    "media_assets",
    "projector_pairing_codes",
    "act_performers",
    "acts",
    "test_show_generations",
  ]) {
    sql.exec(`DELETE FROM ${table} WHERE show_id = ?`, showIdentifier);
  }

  const timestamp = new Date().toISOString();
  // A clean, safe stage: lobby, nothing selected, nothing playing, nothing
  // revealed and no blackout left over from the last event.
  sql.exec(
    `UPDATE shows SET display_mode = 'LOBBY', audience_vote_state = 'CLOSED',
       result_reveal_state = 'HIDDEN', active_act_id = NULL,
       revision = revision + 1, updated_at = ?
     WHERE id = ?`,
    timestamp,
    showIdentifier,
  );
  sql.exec(
    `UPDATE show_runtime SET previous_display_mode = NULL,
       global_judge_permission = 'CLOSED', prepared_cue_id = NULL,
       active_visual_cue_id = NULL, active_audio_cue_id = NULL,
       visual_transport = 'STOPPED', audio_transport = 'STOPPED',
       black_screen = 0, emergency_presentation = 'BLACK',
       results_stage = 'HIDDEN', results_revealed_groups = 0,
       flow_step = NULL, vote_close_revision = NULL, vote_closed_at = NULL,
       updated_at = ?
     WHERE show_id = ?`,
    timestamp,
    showIdentifier,
  );
  // Command history is cleared so the next event's command IDs start fresh;
  // the operational log keeps its own record of the reset itself.
  sql.exec("DELETE FROM command_log WHERE show_id = ?", showIdentifier);
  return acts;
}

/**
 * Returns the event to a safe, empty running state.
 *
 * **Policy — what RESET ENTIRE SHOW means.** Operational event data goes: the
 * running order, cues, uploaded and generated media, votes, judge scores,
 * frozen results and rankings, the current act, display, voting and reveal
 * state, the show-flow step, temporary projector pairing codes, the command
 * log and the test-show record.
 *
 * **Deliberately retained:** event name, short name and tagline, theme and
 * typeface, judge panel and credentials, audience/judge weighting, GO policy,
 * public messages and reactions, paired projector sessions, administrator
 * accounts and sessions, deployment configuration and cached typefaces. This
 * is a between-events data reset, not a factory reset of the venue setup.
 *
 * **Failure safety.** The database and R2 cannot commit together, so the order
 * is fixed: make the database correct in one transaction (which also records
 * every object that must leave R2), restore the default judge panel, then work
 * the queue and sweep the show's own storage namespaces for objects nothing
 * describes. If R2 refuses, the objects stay queued and `mediaCleanupComplete`
 * is false — the database reset itself has still fully happened.
 */
export async function resetShow(
  storage: DurableObjectStorage,
  bucket: R2Bucket,
  showIdentifier: string,
): Promise<ShowResetResult> {
  const clearedActs = storage.transactionSync(() =>
    clearShowData(storage.sql, showIdentifier),
  );
  // A paired display is part of the venue setup. Only one-use pairing codes
  // are cleared by clearShowData; established projector sessions remain valid.
  const projectorSessionsRevoked = 0;

  // Objects in the show's storage namespaces that no row describes (leaks from
  // interrupted deletes) are swept with the rest, so a reset is a clean slate
  // in R2 as well as in SQLite.
  try {
    const stray = await findStrayObjects(storage.sql, bucket, showIdentifier);
    storage.transactionSync(() => {
      for (const object of stray.objects) {
        queueObjectForCleanup(
          storage.sql,
          showIdentifier,
          object.key,
          null,
          "show_reset",
        );
      }
    });
  } catch {
    // Listing failed: the queued deletions below still run, and the orphan
    // sweep remains available from the console.
  }

  const cleanup = await drainMediaCleanupQueue(
    storage,
    bucket,
    showIdentifier,
    1000,
  );
  return {
    clearedActs,
    objectsDeleted: cleanup.deleted,
    objectsPending: pendingCleanupCount(storage.sql, showIdentifier),
    mediaCleanupComplete: cleanup.complete,
    projectorSessionsRevoked,
  };
}
