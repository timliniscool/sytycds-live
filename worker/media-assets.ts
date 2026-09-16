import {
  actId,
  cueId,
  type CueOperation,
  type MediaAsset,
  type MediaAssetReference,
  type MediaKind,
  type MediaManifestEntry,
  type MediaReadiness,
} from "../shared/domain";
import { isRecord } from "../shared/trust";
import {
  isAssetReferenced,
  queueObjectForCleanup,
  TEST_SHOW_OBJECT_PREFIX,
} from "./media-cleanup";

const MAX_MEDIA_BYTES = 2 * 1024 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "video/mp4",
  "video/webm",
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);

interface AssetRow extends Record<string, SqlStorageValue> {
  id: string;
  object_key: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  version_identifier: string;
  uploaded_at: string;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  act_id: string | null;
  generated_test: number;
}

const ASSET_COLUMNS = `id, object_key, original_filename, mime_type, size_bytes,
  version_identifier, uploaded_at, duration_ms, width, height, act_id, generated_test`;

export function mediaKind(mime: string): MediaKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "other";
}

function readiness(row: AssetRow): MediaReadiness {
  const kind = mediaKind(row.mime_type);
  if (kind === "image") return row.width && row.height ? "READY" : "UPLOADED";
  if (kind === "audio" || kind === "video")
    return row.duration_ms !== null ? "READY" : "UPLOADED";
  return "UPLOADED";
}

function rowToAsset(
  row: AssetRow,
  references: readonly MediaAssetReference[],
): MediaAsset {
  return {
    id: row.id,
    kind: mediaKind(row.mime_type),
    objectKey: row.object_key,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    versionIdentifier: row.version_identifier,
    uploadedAt: row.uploaded_at,
    durationMs: row.duration_ms,
    width: row.width,
    height: row.height,
    readiness: readiness(row),
    actId: row.act_id ? actId(row.act_id) : null,
    generatedTest: row.generated_test === 1,
    references,
    referenced: references.length > 0,
  };
}

function validFilename(value: string | null): string | null {
  if (
    !value ||
    value.length > 240 ||
    value.includes("\\") ||
    value.includes("/") ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  )
    return null;
  return value;
}

function rangeFromHeader(
  value: string | null,
  size: number,
): R2Range | undefined {
  if (!value) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value);
  if (!match) return undefined;
  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (startText === "" && endText !== "") {
    const suffix = Number(endText);
    return Number.isSafeInteger(suffix) && suffix > 0
      ? { suffix: Math.min(suffix, size) }
      : undefined;
  }
  const offset = Number(startText);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= size)
    return undefined;
  if (endText === "") return { offset };
  const end = Number(endText);
  return Number.isSafeInteger(end) && end >= offset
    ? { offset, length: Math.min(end, size - 1) - offset + 1 }
    : undefined;
}

export interface UploadOptions {
  /** The act whose media library receives the file; null for a show asset. */
  actId?: string | null;
}

function actExists(
  sql: SqlStorage,
  showIdentifier: string,
  actIdentifier: string,
): boolean {
  return (
    sql
      .exec<{ present: number }>(
        "SELECT 1 AS present FROM acts WHERE show_id = ? AND id = ?",
        showIdentifier,
        actIdentifier,
      )
      .toArray().length > 0
  );
}

export interface MediaAssetRecord {
  id: string;
  objectKey: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  versionIdentifier: string;
  actId: string | null;
  durationMs?: number | null;
  width?: number | null;
  height?: number | null;
  generatedTest?: boolean;
  testShowId?: string | null;
}

/**
 * The one place a media row is written. Uploads and the test-show generator
 * both come through here, so every asset carries the same ownership and test
 * metadata whatever produced it. Call inside a transaction.
 */
export function insertMediaAssetRecord(
  sql: SqlStorage,
  showIdentifier: string,
  record: MediaAssetRecord,
  timestamp: string = new Date().toISOString(),
): void {
  sql.exec(
    `INSERT INTO media_assets (id, show_id, object_key, original_filename, mime_type, size_bytes,
       version_identifier, duration_ms, width, height, uploaded_at, deleted_at,
       act_id, generated_test, test_show_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    record.id,
    showIdentifier,
    record.objectKey,
    record.originalFilename,
    record.mimeType,
    record.sizeBytes,
    record.versionIdentifier,
    record.durationMs ?? null,
    record.width ?? null,
    record.height ?? null,
    timestamp,
    record.actId,
    record.generatedTest ? 1 : 0,
    record.testShowId ?? null,
  );
}

export async function uploadMediaAsset(
  storage: DurableObjectStorage,
  bucket: R2Bucket,
  showIdentifier: string,
  request: Request,
  filename: string | null,
  options: UploadOptions = {},
): Promise<
  { ok: true; asset: MediaAsset } | { ok: false; status: number; error: string }
> {
  const mimeType =
    request.headers.get("Content-Type")?.split(";", 1)[0]?.toLowerCase() ?? "";
  const contentLength = Number(request.headers.get("Content-Length"));
  const cleanFilename = validFilename(filename);
  if (!ALLOWED_MIME_TYPES.has(mimeType))
    return { ok: false, status: 415, error: "Unsupported media MIME type" };
  if (
    !cleanFilename ||
    !Number.isSafeInteger(contentLength) ||
    contentLength < 1 ||
    contentLength > MAX_MEDIA_BYTES ||
    !request.body
  ) {
    return {
      ok: false,
      status: 400,
      error:
        "A valid filename, content length, and streaming body are required",
    };
  }
  const owner = options.actId ?? null;
  if (owner !== null && !actExists(storage.sql, showIdentifier, owner))
    return { ok: false, status: 404, error: "Act not found" };
  const id = `asset-${crypto.randomUUID()}`;
  const objectKey = `${showIdentifier}/${id}`;
  const object = await bucket.put(objectKey, request.body, {
    httpMetadata: {
      contentType: mimeType,
      cacheControl: "private, max-age=31536000, immutable",
    },
    customMetadata: { assetId: id, ...(owner ? { actId: owner } : {}) },
  });
  if (object.size !== contentLength) {
    await bucket.delete(objectKey);
    return {
      ok: false,
      status: 400,
      error: "Upload size did not match Content-Length",
    };
  }
  const timestamp = new Date().toISOString();
  try {
    storage.transactionSync(() => {
      insertMediaAssetRecord(
        storage.sql,
        showIdentifier,
        {
          id,
          objectKey,
          originalFilename: cleanFilename,
          mimeType,
          sizeBytes: object.size,
          versionIdentifier: object.version,
          actId: owner,
        },
        timestamp,
      );
      storage.sql.exec(
        "UPDATE shows SET revision = revision + 1, updated_at = ? WHERE id = ?",
        timestamp,
        showIdentifier,
      );
    });
  } catch (error: unknown) {
    await bucket.delete(objectKey);
    throw error;
  }
  return {
    ok: true,
    asset: rowToAsset(
      {
        id,
        object_key: objectKey,
        original_filename: cleanFilename,
        mime_type: mimeType,
        size_bytes: object.size,
        version_identifier: object.version,
        uploaded_at: timestamp,
        duration_ms: null,
        width: null,
        height: null,
        act_id: owner,
        generated_test: 0,
      },
      [],
    ),
  };
}

/**
 * Every live asset any cue references: the show-critical media set. The
 * projector caches exactly this list and keys each file by its R2 version.
 */
export function listReferencedAssets(
  sql: SqlStorage,
  showIdentifier: string,
): MediaManifestEntry[] {
  return sql
    .exec<
      Pick<AssetRow, "id" | "version_identifier" | "size_bytes" | "mime_type">
    >(
      `SELECT DISTINCT m.id, m.version_identifier, m.size_bytes, m.mime_type
       FROM media_assets m
       WHERE m.show_id = ? AND m.deleted_at IS NULL AND (
         EXISTS (SELECT 1 FROM cue_asset_references r
           WHERE r.show_id = m.show_id AND r.asset_id = m.id)
         OR EXISTS (SELECT 1 FROM acts a
           WHERE a.show_id = m.show_id AND (
             a.public_image_asset_id = m.id
             OR a.performance_asset_id = m.id
             OR a.backing_audio_asset_id = m.id))
       )
       ORDER BY m.id`,
      showIdentifier,
    )
    .toArray()
    .map((row) => ({
      id: row.id,
      version: row.version_identifier,
      sizeBytes: row.size_bytes,
      mimeType: row.mime_type,
    }));
}

/**
 * Who uses what: every act slot and every cue that names an asset, keyed by
 * asset. This is the reference model the library, the deletion preview and
 * the orphan sweep all read from; nothing infers a reference from a filename.
 */
export function assetReferences(
  sql: SqlStorage,
  showIdentifier: string,
): Map<string, MediaAssetReference[]> {
  const references = new Map<string, MediaAssetReference[]>();
  const add = (assetId: string | null, reference: MediaAssetReference) => {
    if (!assetId) return;
    const list = references.get(assetId) ?? [];
    list.push(reference);
    references.set(assetId, list);
  };
  for (const act of sql
    .exec<{
      id: string;
      public_image_asset_id: string | null;
      performance_asset_id: string | null;
      backing_audio_asset_id: string | null;
    }>(
      `SELECT id, public_image_asset_id, performance_asset_id, backing_audio_asset_id
       FROM acts WHERE show_id = ? ORDER BY order_index`,
      showIdentifier,
    )
    .toArray()) {
    const owner = actId(act.id);
    add(act.public_image_asset_id, { kind: "act_image", actId: owner });
    add(act.performance_asset_id, {
      kind: "performance_visual",
      actId: owner,
    });
    add(act.backing_audio_asset_id, { kind: "backing_audio", actId: owner });
  }
  for (const row of sql
    .exec<{ asset_id: string; cue_id: string; act_id: string }>(
      `SELECT r.asset_id, r.cue_id, c.act_id FROM cue_asset_references r
       JOIN cues c ON c.show_id = r.show_id AND c.id = r.cue_id
       WHERE r.show_id = ? ORDER BY c.act_id, c.position`,
      showIdentifier,
    )
    .toArray()) {
    add(row.asset_id, {
      kind: "cue",
      actId: actId(row.act_id),
      cueId: cueId(row.cue_id),
    });
  }
  return references;
}

/**
 * The library. With an act, returns that act's library: the files it owns plus
 * any shared file it references. Without one, every live asset of the show.
 */
export function listMediaAssets(
  sql: SqlStorage,
  showIdentifier: string,
  actIdentifier: string | null = null,
): MediaAsset[] {
  const references = assetReferences(sql, showIdentifier);
  return sql
    .exec<AssetRow>(
      `SELECT ${ASSET_COLUMNS} FROM media_assets m
       WHERE m.show_id = ? AND m.deleted_at IS NULL
       ORDER BY m.uploaded_at DESC`,
      showIdentifier,
    )
    .toArray()
    .map((row) => rowToAsset(row, references.get(row.id) ?? []))
    .filter(
      (asset) =>
        actIdentifier === null ||
        asset.actId === actIdentifier ||
        asset.references.some((reference) => reference.actId === actIdentifier),
    );
}

export function updateMediaMetadata(
  storage: DurableObjectStorage,
  showIdentifier: string,
  assetId: string,
  value: unknown,
): boolean {
  if (!isRecord(value)) return false;
  const optionalInteger = (candidate: unknown, maximum: number) =>
    candidate === null ||
    (typeof candidate === "number" &&
      Number.isSafeInteger(candidate) &&
      candidate >= 0 &&
      candidate <= maximum);
  if (
    !optionalInteger(value.durationMs, 24 * 60 * 60 * 1_000) ||
    !optionalInteger(value.width, 32_768) ||
    !optionalInteger(value.height, 32_768)
  )
    return false;
  return storage.transactionSync(() => {
    const updated = storage.sql.exec(
      `UPDATE media_assets SET duration_ms = ?, width = ?, height = ?
       WHERE show_id = ? AND id = ? AND deleted_at IS NULL`,
      value.durationMs,
      value.width,
      value.height,
      showIdentifier,
      assetId,
    );
    if (updated.rowsWritten !== 1) return false;
    storage.sql.exec(
      "UPDATE shows SET revision = revision + 1, updated_at = ? WHERE id = ?",
      new Date().toISOString(),
      showIdentifier,
    );
    return true;
  });
}

export async function deleteMediaAsset(
  storage: DurableObjectStorage,
  bucket: R2Bucket,
  showIdentifier: string,
  assetId: string,
): Promise<"deleted" | "not_found" | "referenced"> {
  const row = storage.sql
    .exec<AssetRow>(
      `SELECT ${ASSET_COLUMNS} FROM media_assets m
       WHERE show_id = ? AND id = ? AND deleted_at IS NULL`,
      showIdentifier,
      assetId,
    )
    .toArray()[0];
  if (!row) return "not_found";
  // One authoritative reference test: cues and the act columns that name an
  // asset. A file another act still uses is never deleted.
  if (isAssetReferenced(storage.sql, showIdentifier, assetId))
    return "referenced";
  storage.transactionSync(() => {
    const timestamp = new Date().toISOString();
    storage.sql.exec(
      "UPDATE media_assets SET deleted_at = ? WHERE id = ?",
      timestamp,
      assetId,
    );
    queueObjectForCleanup(
      storage.sql,
      showIdentifier,
      row.object_key,
      assetId,
      "asset_deleted",
    );
    storage.sql.exec(
      "UPDATE shows SET revision = revision + 1, updated_at = ? WHERE id = ?",
      timestamp,
      showIdentifier,
    );
  });
  // Metadata becomes inaccessible first, so a live record never points at a
  // hole. The object is queued work: if R2 refuses now, it is retried later
  // rather than leaking silently.
  await removeQueuedObject(storage, bucket, row.object_key);
  return "deleted";
}

/**
 * Deletes one queued object and clears its queue row on success. A failure is
 * recorded against the row so the operator's retry control can see it.
 */
async function removeQueuedObject(
  storage: DurableObjectStorage,
  bucket: R2Bucket,
  objectKey: string,
): Promise<boolean> {
  try {
    await bucket.delete(objectKey);
    storage.sql.exec(
      "DELETE FROM media_cleanup_queue WHERE object_key = ?",
      objectKey,
    );
    return true;
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
      objectKey,
    );
    return false;
  }
}

/** Uploads first, then atomically retargets every reference; the old bytes leave last. */
export async function replaceMediaAsset(
  storage: DurableObjectStorage,
  bucket: R2Bucket,
  showIdentifier: string,
  oldAssetId: string,
  request: Request,
  filename: string | null,
): Promise<
  { ok: true; asset: MediaAsset } | { ok: false; status: number; error: string }
> {
  const old = storage.sql
    .exec<AssetRow>(
      `SELECT ${ASSET_COLUMNS} FROM media_assets m
       WHERE show_id = ? AND id = ? AND deleted_at IS NULL`,
      showIdentifier,
      oldAssetId,
    )
    .toArray()[0];
  if (!old) return { ok: false, status: 404, error: "Media asset not found" };
  const uploaded = await uploadMediaAsset(
    storage,
    bucket,
    showIdentifier,
    request,
    filename,
    { actId: old.act_id },
  );
  if (!uploaded.ok) return uploaded;
  if (mediaKind(old.mime_type) !== mediaKind(uploaded.asset.mimeType)) {
    await deleteMediaAsset(storage, bucket, showIdentifier, uploaded.asset.id);
    return {
      ok: false,
      status: 409,
      error: "Replacement must use the same media kind",
    };
  }
  storage.transactionSync(() => {
    const cues = storage.sql
      .exec<{ id: string; operations_json: string }>(
        `SELECT c.id, c.operations_json FROM cues c
       JOIN cue_asset_references r ON r.cue_id = c.id
       WHERE r.show_id = ? AND r.asset_id = ?`,
        showIdentifier,
        oldAssetId,
      )
      .toArray();
    for (const cue of cues) {
      const parsed = JSON.parse(cue.operations_json) as CueOperation[];
      const operations = parsed.map((operation): CueOperation => {
        if (
          operation.kind === "visual" &&
          operation.visual.sourceKey === oldAssetId
        )
          return {
            ...operation,
            visual: { ...operation.visual, sourceKey: uploaded.asset.id },
          };
        if (operation.kind === "audio" && operation.assetId === oldAssetId)
          return { ...operation, assetId: uploaded.asset.id };
        return operation;
      });
      storage.sql.exec(
        `UPDATE cues SET operations_json = ?,
          visual_source_key = CASE WHEN visual_source_key = ? THEN ? ELSE visual_source_key END,
          audio_source_key = CASE WHEN audio_source_key = ? THEN ? ELSE audio_source_key END,
          updated_at = ? WHERE show_id = ? AND id = ?`,
        JSON.stringify(operations),
        oldAssetId,
        uploaded.asset.id,
        oldAssetId,
        uploaded.asset.id,
        new Date().toISOString(),
        showIdentifier,
        cue.id,
      );
    }
    storage.sql.exec(
      "DELETE FROM cue_asset_references WHERE show_id = ? AND asset_id = ?",
      showIdentifier,
      oldAssetId,
    );
    for (const cue of cues)
      storage.sql.exec(
        "INSERT OR IGNORE INTO cue_asset_references (show_id, cue_id, asset_id) VALUES (?, ?, ?)",
        showIdentifier,
        cue.id,
        uploaded.asset.id,
      );
    // Every column that can name an asset is retargeted, or replacing a file
    // would leave an act pointing at bytes that no longer exist.
    storage.sql.exec(
      `UPDATE acts SET
         public_image_asset_id = CASE WHEN public_image_asset_id = ? THEN ? ELSE public_image_asset_id END,
         performance_asset_id = CASE WHEN performance_asset_id = ? THEN ? ELSE performance_asset_id END,
         backing_audio_asset_id = CASE WHEN backing_audio_asset_id = ? THEN ? ELSE backing_audio_asset_id END
       WHERE show_id = ?`,
      oldAssetId,
      uploaded.asset.id,
      oldAssetId,
      uploaded.asset.id,
      oldAssetId,
      uploaded.asset.id,
      showIdentifier,
    );
    storage.sql.exec(
      "UPDATE media_assets SET deleted_at = ? WHERE id = ?",
      new Date().toISOString(),
      oldAssetId,
    );
  });
  // The superseded bytes are queued work, not a fire-and-forget delete: a
  // failed removal here used to leak an object nothing could ever find again.
  storage.sql.exec(
    `INSERT INTO media_cleanup_queue
      (object_key, show_id, asset_id, reason, attempts, last_error, queued_at, last_attempted_at)
     VALUES (?, ?, ?, 'asset_replaced', 0, NULL, ?, NULL)
     ON CONFLICT(object_key) DO NOTHING`,
    old.object_key,
    showIdentifier,
    oldAssetId,
    new Date().toISOString(),
  );
  await removeQueuedObject(storage, bucket, old.object_key);
  return uploaded;
}

/** Whether an object key belongs to the generated-test namespace. */
export function isTestShowObjectKey(objectKey: string): boolean {
  return objectKey.startsWith(TEST_SHOW_OBJECT_PREFIX);
}

export async function serveMediaAsset(
  sql: SqlStorage,
  bucket: R2Bucket,
  showIdentifier: string,
  assetId: string,
  request: Request,
  publiclyCacheable = false,
): Promise<Response> {
  const asset = sql
    .exec<AssetRow>(
      `SELECT ${ASSET_COLUMNS} FROM media_assets m
       WHERE show_id = ? AND id = ? AND deleted_at IS NULL`,
      showIdentifier,
      assetId,
    )
    .toArray()[0];
  if (!asset) return Response.json({ error: "Not found" }, { status: 404 });
  const range = rangeFromHeader(request.headers.get("Range"), asset.size_bytes);
  if (request.headers.has("Range") && !range)
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${asset.size_bytes}` },
    });
  const cacheable =
    publiclyCacheable && request.method === "GET" && range === undefined;
  const cacheKey = new Request(request.url, { method: "GET" });
  let edgeCache: Cache | null = null;
  if (cacheable) {
    try {
      edgeCache =
        (caches as CacheStorage & { default?: Cache }).default ??
        (await caches.open("public-act-images"));
      const cached = await edgeCache.match(cacheKey);
      if (cached) return cached;
    } catch {
      // R2 remains available if a local runtime has no CacheStorage.
    }
  }
  const object = await bucket.get(
    asset.object_key,
    range ? { range } : undefined,
  );
  if (!object || !("body" in object))
    return Response.json({ error: "Media object missing" }, { status: 404 });
  const headers = new Headers({
    "Content-Type": asset.mime_type,
    "Accept-Ranges": "bytes",
    "Cache-Control": publiclyCacheable
      ? "public, max-age=86400, immutable"
      : "private, max-age=31536000, immutable",
    ETag: `"${asset.version_identifier}"`,
  });
  // Partial only when the client asked for a range. The local R2 runtime
  // returns an empty `range` object for a whole-object read, which used to
  // produce a 206 with "bytes NaN-NaN/size"; a browser (and the projector's
  // service worker, which forwards the response) treats a 206 to a non-range
  // request as a network failure, so the hall could not load any media.
  // The offsets come from the range the client asked for, not from the
  // object's echo of it, which the local runtime leaves undefined.
  const partial = range !== undefined;
  if (partial) {
    const offset =
      "suffix" in range
        ? asset.size_bytes - Math.min(range.suffix, asset.size_bytes)
        : (range.offset ?? 0);
    const length =
      "suffix" in range
        ? Math.min(range.suffix, asset.size_bytes)
        : Math.min(
            range.length ?? asset.size_bytes - offset,
            asset.size_bytes - offset,
          );
    headers.set(
      "Content-Range",
      `bytes ${offset}-${offset + length - 1}/${asset.size_bytes}`,
    );
    headers.set("Content-Length", String(length));
  } else headers.set("Content-Length", String(asset.size_bytes));
  const response = new Response(
    request.method === "HEAD" ? null : object.body,
    {
      status: partial ? 206 : 200,
      headers,
    },
  );
  if (cacheable) {
    try {
      await edgeCache?.put(cacheKey, response.clone());
    } catch {
      // A cache failure must never turn a public act image into an error.
    }
  }
  return response;
}
