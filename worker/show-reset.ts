import { DEFAULT_SHOW_FLOW_POLICY } from "../shared/domain";
import { defaultJudgeName } from "../shared/judges";
import { DEFAULT_EVENT_NAME } from "../shared/platform";
import { DEFAULT_THEME_ID } from "../shared/themes";
import { isRecord } from "../shared/trust";
import {
  drainMediaCleanupQueue,
  findStrayObjects,
  pendingCleanupCount,
  queueObjectForCleanup,
} from "./media-cleanup";
import { applyScoringConfiguration } from "./scoring-config";
import { writeFlowPolicy } from "./show-config";

/** The exact phrase an operator must type; nothing shorter is accepted. */
export const RESET_CONFIRMATION = "RESET SHOW";
/** Deleting a single act is destructive too, and is confirmed the same way. */
export const DELETE_ACT_CONFIRMATION = "DELETE ACT";

/** The default panel a reset restores: four judges, named by slot. */
export const DEFAULT_JUDGE_COUNT = 4;
export const DEFAULT_AUDIENCE_WEIGHT = 0.5;

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
  /** Projector sessions revoked; the display returns to its pairing screen. */
  projectorSessionsRevoked: number;
}

/**
 * Removes everything that belongs to *running* an event, leaving the show row
 * itself in place: acts, cues, media (queued for R2 cleanup), votes, judge
 * submissions and permissions, frozen results, the current act, display,
 * voting and reveal state, the show-flow step, the pairing code, the command
 * log and any test-show record. Configuration is untouched here; `resetShow`
 * restores that separately and the test-show generator deliberately keeps it.
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
 * Returns the event to the true default show.
 *
 * **Policy — what RESET ENTIRE SHOW means.** Everything about *this event*
 * goes: the running order, cues, uploaded and generated media, votes, judge
 * scores, frozen results and rankings, the current act, display, voting and
 * reveal state, the show-flow step, the projector pairing (codes *and*
 * sessions, so a display in the hall re-pairs deliberately), the event name,
 * short name and tagline, the theme and typeface, the judge panel, the
 * audience/judge weighting, the GO policy, the public intermission and
 * emergency text and the test-show record. What comes back is the product's
 * default show: "So You Think You Can Do Stuff", four judges named Judge 1–4,
 * 50:50 weighting, the default theme and the system typeface.
 *
 * **Deliberately untouched:** the administrator account and its sessions,
 * deployment secrets, Cloudflare configuration, cached typefaces (shared
 * platform cache, not show data) and the application itself. This is a reset
 * of the show, not a factory reset of the installation.
 *
 * **Failure safety.** The database and R2 cannot commit together, so the order
 * is fixed: make the database correct in one transaction (which also records
 * every object that must leave R2), restore the default judge panel, then work
 * the queue and sweep the show's own storage namespaces for objects nothing
 * describes. If R2 refuses, the objects stay queued and `mediaCleanupComplete`
 * is false — the reset itself has still fully happened.
 */
export async function resetShow(
  storage: DurableObjectStorage,
  bucket: R2Bucket,
  showIdentifier: string,
): Promise<ShowResetResult> {
  const { clearedActs, projectorSessionsRevoked } = storage.transactionSync(
    () => {
      const acts = clearShowData(storage.sql, showIdentifier);
      const revoked = storage.sql.exec(
        "DELETE FROM projector_sessions WHERE show_id = ?",
        showIdentifier,
      ).rowsWritten;
      // The judge panel is show configuration: it goes, and the default panel
      // is issued afresh below. Submissions and permissions are already gone.
      storage.sql.exec(
        "DELETE FROM show_judges WHERE show_id = ?",
        showIdentifier,
      );
      storage.sql.exec("DELETE FROM judges WHERE show_id = ?", showIdentifier);
      storage.sql.exec(
        `UPDATE shows SET title = ?, tagline = '', short_name = '', theme_id = ?,
           font_family = 'system-ui', audience_weight = ?, reactions_enabled = 1,
           intermission_message = '', emergency_message = '', updated_at = ?
         WHERE id = ?`,
        DEFAULT_EVENT_NAME,
        DEFAULT_THEME_ID,
        DEFAULT_AUDIENCE_WEIGHT,
        new Date().toISOString(),
        showIdentifier,
      );
      writeFlowPolicy(storage.sql, showIdentifier, DEFAULT_SHOW_FLOW_POLICY);
      return { clearedActs: acts, projectorSessionsRevoked: revoked };
    },
  );

  // Four judges, named by slot, with fresh credentials the operator issues
  // from the console when needed. No scoring data exists, so this cannot lock.
  const judges = await applyScoringConfiguration(storage, showIdentifier, {
    judgeNames: Array.from({ length: DEFAULT_JUDGE_COUNT }, (_, index) =>
      defaultJudgeName(index + 1),
    ),
    audienceWeight: DEFAULT_AUDIENCE_WEIGHT,
    reset: false,
    confirm: null,
  });
  if (!judges.ok) {
    throw new Error(
      `Default judge panel could not be restored: ${judges.reason}`,
    );
  }

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
