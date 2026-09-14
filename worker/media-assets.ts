import {
  type CueOperation,
  type MediaAsset,
  type MediaManifestEntry,
} from "../shared/domain";

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
}

function rowToAsset(row: AssetRow, referenced: boolean): MediaAsset {
  return {
    id: row.id,
    objectKey: row.object_key,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    versionIdentifier: row.version_identifier,
    uploadedAt: row.uploaded_at,
    durationMs: row.duration_ms,
    width: row.width,
    height: row.height,
    referenced,
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

export async function uploadMediaAsset(
  storage: DurableObjectStorage,
  bucket: R2Bucket,
  showIdentifier: string,
  request: Request,
  filename: string | null,
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
  const id = `asset-${crypto.randomUUID()}`;
  const objectKey = `${showIdentifier}/${id}`;
  const object = await bucket.put(objectKey, request.body, {
    httpMetadata: {
      contentType: mimeType,
      cacheControl: "private, max-age=31536000, immutable",
    },
    customMetadata: { assetId: id },
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
      storage.sql.exec(
        `INSERT INTO media_assets (id, show_id, object_key, original_filename, mime_type, size_bytes, version_identifier, duration_ms, width, height, uploaded_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL)`,
        id,
        showIdentifier,
        objectKey,
        cleanFilename,
        mimeType,
        object.size,
        object.version,
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
    asset: {
      id,
      objectKey,
      originalFilename: cleanFilename,
      mimeType,
      sizeBytes: object.size,
      versionIdentifier: object.version,
      uploadedAt: timestamp,
      durationMs: null,
      width: null,
      height: null,
      referenced: false,
    },
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
           WHERE a.show_id = m.show_id AND a.public_image_asset_id = m.id)
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

export function listMediaAssets(
  sql: SqlStorage,
  showIdentifier: string,
): MediaAsset[] {
  return sql
    .exec<AssetRow & { referenced: number }>(
      `SELECT m.id, m.object_key, m.original_filename, m.mime_type, m.size_bytes,
              m.version_identifier, m.uploaded_at, m.duration_ms, m.width, m.height,
              EXISTS (
                SELECT 1 FROM cue_asset_references r WHERE r.asset_id = m.id
              ) OR EXISTS (
                SELECT 1 FROM acts a WHERE a.public_image_asset_id = m.id
              ) AS referenced
       FROM media_assets m
       WHERE m.show_id = ? AND m.deleted_at IS NULL
       ORDER BY m.uploaded_at DESC`,
      showIdentifier,
    )
    .toArray()
    .map((row) => rowToAsset(row, row.referenced === 1));
}

export async function deleteMediaAsset(
  storage: DurableObjectStorage,
  bucket: R2Bucket,
  showIdentifier: string,
  assetId: string,
): Promise<"deleted" | "not_found" | "referenced"> {
  const row = storage.sql
    .exec<AssetRow>(
      `SELECT id, object_key, original_filename, mime_type, size_bytes, version_identifier, uploaded_at, duration_ms, width, height
     FROM media_assets WHERE show_id = ? AND id = ? AND deleted_at IS NULL`,
      showIdentifier,
      assetId,
    )
    .toArray()[0];
  if (!row) return "not_found";
  if (
    storage.sql
      .exec<{ present: number }>(
        "SELECT 1 AS present FROM cue_asset_references WHERE asset_id = ?",
        assetId,
      )
      .toArray().length > 0
  )
    return "referenced";
  if (
    storage.sql
      .exec<{ present: number }>(
        "SELECT 1 AS present FROM acts WHERE show_id = ? AND public_image_asset_id = ? LIMIT 1",
        showIdentifier,
        assetId,
      )
      .toArray().length > 0
  )
    return "referenced";
  storage.transactionSync(() => {
    storage.sql.exec(
      "UPDATE media_assets SET deleted_at = ? WHERE id = ?",
      new Date().toISOString(),
      assetId,
    );
    storage.sql.exec(
      "UPDATE shows SET revision = revision + 1, updated_at = ? WHERE id = ?",
      new Date().toISOString(),
      showIdentifier,
    );
  });
  // Metadata becomes inaccessible first. A failed object deletion leaves only
  // an unreferenced private R2 object, never a live record pointing at a hole.
  await bucket.delete(row.object_key).catch(() => undefined);
  return "deleted";
}

function mediaKind(mime: string): "image" | "audio" | "video" | "other" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "other";
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
      `SELECT id, object_key, original_filename, mime_type, size_bytes,
      version_identifier, uploaded_at, duration_ms, width, height
     FROM media_assets WHERE show_id = ? AND id = ? AND deleted_at IS NULL`,
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
    storage.sql.exec(
      "UPDATE acts SET public_image_asset_id = ? WHERE show_id = ? AND public_image_asset_id = ?",
      uploaded.asset.id,
      showIdentifier,
      oldAssetId,
    );
    storage.sql.exec(
      "UPDATE media_assets SET deleted_at = ? WHERE id = ?",
      new Date().toISOString(),
      oldAssetId,
    );
  });
  await bucket.delete(old.object_key).catch(() => undefined);
  return uploaded;
}

export async function serveMediaAsset(
  sql: SqlStorage,
  bucket: R2Bucket,
  showIdentifier: string,
  assetId: string,
  request: Request,
): Promise<Response> {
  const asset = sql
    .exec<AssetRow>(
      `SELECT id, object_key, original_filename, mime_type, size_bytes, version_identifier, uploaded_at, duration_ms, width, height
     FROM media_assets WHERE show_id = ? AND id = ? AND deleted_at IS NULL`,
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
  const object = await bucket.get(
    asset.object_key,
    range ? { range } : undefined,
  );
  if (!object || !("body" in object))
    return Response.json({ error: "Media object missing" }, { status: 404 });
  const headers = new Headers({
    "Content-Type": asset.mime_type,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=31536000, immutable",
    ETag: `"${asset.version_identifier}"`,
  });
  if (object.range) {
    const offset =
      "suffix" in object.range
        ? asset.size_bytes - object.range.suffix
        : (object.range.offset ?? 0);
    const length = "length" in object.range ? object.range.length : object.size;
    headers.set(
      "Content-Range",
      `bytes ${offset}-${offset + length - 1}/${asset.size_bytes}`,
    );
    headers.set("Content-Length", String(length));
  } else headers.set("Content-Length", String(asset.size_bytes));
  return new Response(request.method === "HEAD" ? null : object.body, {
    status: object.range ? 206 : 200,
    headers,
  });
}
