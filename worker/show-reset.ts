import { isRecord } from "../shared/trust";

/** The exact phrase an operator must type; nothing shorter is accepted. */
export const RESET_CONFIRMATION = "RESET SHOW";

export function isResetConfirmed(value: unknown): boolean {
  return isRecord(value) && value.confirm === RESET_CONFIRMATION;
}

/**
 * Erases the show and everything under it, returning the coordinator to the
 * state of a fresh deployment. Operator sessions survive so the person who
 * pressed the button is still signed in to create the next show. Media bytes
 * are deleted from R2 after the rows are gone; a failed object delete leaves
 * an orphaned object, never a dangling row.
 */
export async function resetShow(
  storage: DurableObjectStorage,
  bucket: R2Bucket,
  showIdentifier: string,
): Promise<{ deletedObjects: number }> {
  const objectKeys = storage.transactionSync(() => {
    const keys = storage.sql
      .exec<{ object_key: string }>(
        "SELECT object_key FROM media_assets WHERE show_id = ?",
        showIdentifier,
      )
      .toArray()
      .map((row) => row.object_key);
    // Children before parents; every table here references the show.
    for (const table of [
      "audit_events",
      "command_log",
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
      "projector_sessions",
      "show_judges",
      "judges",
      "acts",
      "show_runtime",
      "shows",
    ]) {
      storage.sql.exec(
        `DELETE FROM ${table} WHERE ${table === "shows" ? "id" : "show_id"} = ?`,
        showIdentifier,
      );
    }
    return keys;
  });
  let deletedObjects = 0;
  for (const key of objectKeys) {
    try {
      await bucket.delete(key);
      deletedObjects += 1;
    } catch {
      // Orphaned bytes are harmless; the reset itself has already happened.
    }
  }
  return { deletedObjects };
}
