import { isRecord } from "../shared/trust";
import {
  drainMediaCleanupQueue,
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
}

/**
 * Returns the event to a clean, ready-to-run state without making the operator
 * set it up from nothing again.
 *
 * **Policy — what a show reset means here.** It clears everything that belongs
 * to *running the event*: acts, cues, uploaded show media, votes, judge
 * submissions, finalised results and ranking snapshots, the current act, the
 * display, voting and reveal state, and the projector pairing code. What the
 * operator configured *before* the event survives, because re-entering it is
 * pure friction and none of it is performance data: the event name and tagline,
 * the theme and typeface, the public intermission and emergency text, the judge
 * panel with its links, and the audience/judge weighting.
 *
 * Deliberately untouched: the administrator account, deployment secrets,
 * Cloudflare configuration, and every platform asset. This is not a factory
 * reset and does not pretend to be one.
 *
 * Paired projectors keep their sessions. A display that is physically in the
 * hall and already trusted should not have to be re-paired because the running
 * order was cleared; revoking a display remains its own deliberate control.
 *
 * **Failure safety.** The database and R2 cannot commit together, so the order
 * is fixed: stop anything live, make the database correct in one transaction
 * (which also records every object that must leave R2), then work that queue.
 * If R2 refuses, the objects stay queued and `mediaCleanupComplete` is false —
 * the reset itself has still fully happened, and the outstanding work is
 * retryable rather than leaked.
 */
export async function resetShow(
  storage: DurableObjectStorage,
  bucket: R2Bucket,
  showIdentifier: string,
): Promise<ShowResetResult> {
  const clearedActs = storage.transactionSync(() => {
    const acts = storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM acts WHERE show_id = ?",
        showIdentifier,
      )
      .one().count;

    // Every uploaded object owned by this show becomes cleanup work. Platform
    // and deployment assets are not in this table and cannot be caught here.
    for (const asset of storage.sql
      .exec<{ id: string; object_key: string }>(
        "SELECT id, object_key FROM media_assets WHERE show_id = ?",
        showIdentifier,
      )
      .toArray()) {
      queueObjectForCleanup(
        storage.sql,
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
      "acts",
    ]) {
      storage.sql.exec(
        `DELETE FROM ${table} WHERE show_id = ?`,
        showIdentifier,
      );
    }

    const timestamp = new Date().toISOString();
    // A clean, safe stage: lobby, nothing selected, nothing playing, nothing
    // revealed and no blackout left over from the last event.
    storage.sql.exec(
      `UPDATE shows SET display_mode = 'LOBBY', audience_vote_state = 'CLOSED',
         result_reveal_state = 'HIDDEN', active_act_id = NULL,
         revision = revision + 1, updated_at = ?
       WHERE id = ?`,
      timestamp,
      showIdentifier,
    );
    storage.sql.exec(
      `UPDATE show_runtime SET previous_display_mode = NULL,
         global_judge_permission = 'CLOSED', prepared_cue_id = NULL,
         active_visual_cue_id = NULL, active_audio_cue_id = NULL,
         visual_transport = 'STOPPED', audio_transport = 'STOPPED',
         black_screen = 0, emergency_presentation = 'BLACK',
         results_stage = 'HIDDEN', results_revealed_groups = 0, updated_at = ?
       WHERE show_id = ?`,
      timestamp,
      showIdentifier,
    );
    // Command history is cleared so the next event's command IDs start fresh;
    // the operational log keeps its own record of the reset itself.
    storage.sql.exec(
      "DELETE FROM command_log WHERE show_id = ?",
      showIdentifier,
    );
    return acts;
  });

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
  };
}
