/**
 * Media lifecycle across two systems.
 *
 * Uploaded bytes live in R2; everything that knows what those bytes are for
 * lives in this Durable Object's SQLite. No transaction spans both, so the
 * rule is fixed and one-directional: **the database is made correct first, and
 * R2 catches up.** A row never points at an object that is already gone, and an
 * object that should be gone is recorded as outstanding work until it actually
 * is. Nothing is ever deleted from R2 on a guess.
 *
 * "Referenced" is decided from authoritative rows only — cue references and the
 * act columns that name an asset — never from a filename or an object key.
 */

const MAX_R2_ATTEMPTS = 8;

export type CleanupReason =
  | "act_deleted"
  | "asset_deleted"
  | "asset_replaced"
  | "show_reset"
  | "orphan_sweep";

export interface CleanupOutcome {
  /** Objects this call successfully removed from R2. */
  deleted: number;
  /** Objects still outstanding, recorded for retry. */
  pending: number;
  /** True only when nothing at all remains queued for this show. */
  complete: boolean;
}

export interface OrphanReport {
  assets: readonly {
    id: string;
    objectKey: string;
    originalFilename: string;
    mimeType: string;
    sizeBytes: number;
    uploadedAt: string;
  }[];
  totalBytes: number;
  /** Objects already queued for deletion but not yet gone from R2. */
  pendingCleanup: number;
  /**
   * Objects sitting in R2 with no metadata row at all. These are the leaks an
   * orphan sweep of the database can never see, because there is nothing left
   * in the database to find.
   */
  strayObjects: readonly { key: string; sizeBytes: number }[];
  strayBytes: number;
  /** True when R2 held more objects than one sweep could list. */
  strayListingTruncated: boolean;
}

/**
 * Every asset the show still genuinely uses. An asset counts as referenced if a
 * cue references it, or if an act names it as its public image, its custom
 * performance visual or its backing audio. The act columns are checked directly
 * rather than trusting the derived cue rows to mirror them.
 */
const REFERENCED_PREDICATE = `(
  EXISTS (SELECT 1 FROM cue_asset_references r
    WHERE r.show_id = m.show_id AND r.asset_id = m.id)
  OR EXISTS (SELECT 1 FROM acts a WHERE a.show_id = m.show_id AND (
    a.public_image_asset_id = m.id
    OR a.performance_asset_id = m.id
    OR a.backing_audio_asset_id = m.id))
)`;

export function isAssetReferenced(
  sql: SqlStorage,
  showIdentifier: string,
  assetId: string,
): boolean {
  return (
    sql
      .exec<{ present: number }>(
        `SELECT 1 AS present FROM media_assets m
         WHERE m.show_id = ? AND m.id = ? AND ${REFERENCED_PREDICATE} LIMIT 1`,
        showIdentifier,
        assetId,
      )
      .toArray().length > 0
  );
}

/** Queues one object for removal from R2. Safe to call twice for the same key. */
export function queueObjectForCleanup(
  sql: SqlStorage,
  showIdentifier: string,
  objectKey: string,
  assetId: string | null,
  reason: CleanupReason,
): void {
  sql.exec(
    `INSERT INTO media_cleanup_queue
      (object_key, show_id, asset_id, reason, attempts, last_error, queued_at, last_attempted_at)
     VALUES (?, ?, ?, ?, 0, NULL, ?, NULL)
     ON CONFLICT(object_key) DO NOTHING`,
    objectKey,
    showIdentifier,
    assetId,
    reason,
    new Date().toISOString(),
  );
}

/**
 * Retires the named assets: their metadata rows go, and their objects become
 * queued cleanup work. Call inside the transaction that removed whatever was
 * referencing them, so the database is never left describing a half-deletion.
 *
 * Assets still referenced by something else are deliberately left alone — a
 * shared file must survive the deletion of one of its users.
 */
export function retireUnreferencedAssets(
  sql: SqlStorage,
  showIdentifier: string,
  reason: CleanupReason,
  candidateAssetIds?: readonly string[],
): number {
  const scope =
    candidateAssetIds === undefined
      ? null
      : candidateAssetIds.filter((id) => id.length > 0);
  if (scope !== null && scope.length === 0) return 0;
  const placeholders = scope?.map(() => "?").join(", ");
  const rows = sql
    .exec<{ id: string; object_key: string }>(
      `SELECT m.id, m.object_key FROM media_assets m
       WHERE m.show_id = ?
         ${scope ? `AND m.id IN (${placeholders})` : ""}
         AND NOT ${REFERENCED_PREDICATE}`,
      ...[showIdentifier, ...(scope ?? [])],
    )
    .toArray();
  for (const row of rows) {
    queueObjectForCleanup(sql, showIdentifier, row.object_key, row.id, reason);
    sql.exec(
      "DELETE FROM media_assets WHERE show_id = ? AND id = ?",
      showIdentifier,
      row.id,
    );
  }
  return rows.length;
}

/**
 * Works the queue. Each success removes the row; each failure records the error
 * and leaves the row for next time, so an R2 outage costs a retry rather than a
 * permanently leaked object. Called after every operation that queues work and
 * from the operator's own maintenance control.
 */
export async function drainMediaCleanupQueue(
  storage: DurableObjectStorage,
  bucket: R2Bucket,
  showIdentifier: string,
  limit = 200,
): Promise<CleanupOutcome> {
  const rows = storage.sql
    .exec<{ object_key: string; attempts: number }>(
      `SELECT object_key, attempts FROM media_cleanup_queue
       WHERE show_id = ? AND attempts < ? ORDER BY queued_at LIMIT ?`,
      showIdentifier,
      MAX_R2_ATTEMPTS,
      limit,
    )
    .toArray();
  let deleted = 0;
  for (const row of rows) {
    try {
      await bucket.delete(row.object_key);
      storage.sql.exec(
        "DELETE FROM media_cleanup_queue WHERE object_key = ?",
        row.object_key,
      );
      deleted += 1;
    } catch (error: unknown) {
      storage.sql.exec(
        `UPDATE media_cleanup_queue
           SET attempts = attempts + 1, last_error = ?, last_attempted_at = ?
         WHERE object_key = ?`,
        (error instanceof Error ? error.message : "R2 delete failed").slice(
          0,
          300,
        ),
        new Date().toISOString(),
        row.object_key,
      );
    }
  }
  const pending = pendingCleanupCount(storage.sql, showIdentifier);
  return { deleted, pending, complete: pending === 0 };
}

export function pendingCleanupCount(
  sql: SqlStorage,
  showIdentifier: string,
): number {
  return sql
    .exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM media_cleanup_queue WHERE show_id = ?",
      showIdentifier,
    )
    .one().count;
}

/**
 * Uploaded show media that nothing in the database refers to any more. These
 * are the leaks left by earlier bugs and by interrupted deletions. Platform and
 * deployment assets are not in `media_assets` at all and can never appear here.
 */
export async function findOrphanedAssets(
  sql: SqlStorage,
  bucket: R2Bucket,
  showIdentifier: string,
): Promise<OrphanReport> {
  const assets = sql
    .exec<{
      id: string;
      object_key: string;
      original_filename: string;
      mime_type: string;
      size_bytes: number;
      uploaded_at: string;
    }>(
      `SELECT m.id, m.object_key, m.original_filename, m.mime_type,
              m.size_bytes, m.uploaded_at
       FROM media_assets m
       WHERE m.show_id = ? AND NOT ${REFERENCED_PREDICATE}
       ORDER BY m.uploaded_at`,
      showIdentifier,
    )
    .toArray()
    .map((row) => ({
      id: row.id,
      objectKey: row.object_key,
      originalFilename: row.original_filename,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes,
      uploadedAt: row.uploaded_at,
    }));
  const stray = await findStrayObjects(sql, bucket, showIdentifier);
  return {
    assets,
    totalBytes: assets.reduce((sum, asset) => sum + asset.sizeBytes, 0),
    pendingCleanup: pendingCleanupCount(sql, showIdentifier),
    strayObjects: stray.objects,
    strayBytes: stray.totalBytes,
    strayListingTruncated: stray.truncated,
  };
}

/**
 * The show's own object namespace. Uploads are keyed `<showId>/<assetId>`, and
 * nothing else is: cached typefaces live under `fonts/`, and platform and
 * deployment assets are not in R2 at all. Sweeping this prefix therefore cannot
 * reach anything that is not this show's uploaded media.
 */
export function showObjectPrefix(showIdentifier: string): string {
  return `${showIdentifier}/`;
}

/** One page of listing at a time; a show with thousands of files still works. */
const LIST_PAGE = 1000;
const MAX_LIST_PAGES = 20;

/**
 * Objects in R2 that no metadata row describes.
 *
 * The database-side sweep above finds rows nothing references. This finds the
 * opposite and more dangerous case: bytes whose row is already gone, left by an
 * interrupted delete or by an older version of this code that removed the row
 * and then swallowed the R2 failure. Nothing in the database can reveal them,
 * so the only way to find them is to ask R2 what it actually holds.
 *
 * A key is *known* if any `media_assets` row claims it — including a
 * soft-deleted row — or if it is already queued for cleanup. Everything else
 * under the show's prefix is stray.
 */
export async function findStrayObjects(
  sql: SqlStorage,
  bucket: R2Bucket,
  showIdentifier: string,
): Promise<{
  objects: { key: string; sizeBytes: number }[];
  totalBytes: number;
  truncated: boolean;
}> {
  const known = new Set<string>([
    ...sql
      .exec<{ object_key: string }>(
        "SELECT object_key FROM media_assets WHERE show_id = ?",
        showIdentifier,
      )
      .toArray()
      .map((row) => row.object_key),
    ...sql
      .exec<{ object_key: string }>(
        "SELECT object_key FROM media_cleanup_queue WHERE show_id = ?",
        showIdentifier,
      )
      .toArray()
      .map((row) => row.object_key),
  ]);

  const objects: { key: string; sizeBytes: number }[] = [];
  let cursor: string | undefined;
  let truncated = false;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const listing = await bucket.list({
      prefix: showObjectPrefix(showIdentifier),
      limit: LIST_PAGE,
      ...(cursor ? { cursor } : {}),
    });
    for (const object of listing.objects) {
      if (!known.has(object.key))
        objects.push({ key: object.key, sizeBytes: object.size });
    }
    if (!listing.truncated) break;
    cursor = listing.cursor;
    truncated = page === MAX_LIST_PAGES - 1;
  }
  return {
    objects,
    totalBytes: objects.reduce((sum, object) => sum + object.sizeBytes, 0),
    truncated,
  };
}

/**
 * The destructive half of the sweep, in both directions: retires database rows
 * nothing references, queues R2 objects nothing describes, then works the queue.
 */
export async function cleanOrphanedAssets(
  storage: DurableObjectStorage,
  bucket: R2Bucket,
  showIdentifier: string,
): Promise<CleanupOutcome & { retired: number; strays: number }> {
  const retired = storage.transactionSync(() =>
    retireUnreferencedAssets(storage.sql, showIdentifier, "orphan_sweep"),
  );
  const stray = await findStrayObjects(storage.sql, bucket, showIdentifier);
  storage.transactionSync(() => {
    for (const object of stray.objects) {
      queueObjectForCleanup(
        storage.sql,
        showIdentifier,
        object.key,
        null,
        "orphan_sweep",
      );
    }
  });
  const outcome = await drainMediaCleanupQueue(storage, bucket, showIdentifier);
  return { ...outcome, retired, strays: stray.objects.length };
}
