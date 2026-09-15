/**
 * Simple Show Flow: the ordinary operator configures an act, not a media
 * command list. An act says what the hall sees during the performance and what
 * it hears, and this module turns that into the same cue rows the advanced
 * engine has always executed.
 *
 * Derivation is one-way and idempotent. A derived cue is marked `SIMPLE`, is
 * regenerated whenever the act's presentation changes, and always sits first in
 * the stack. Cues the operator wrote by hand are `MANUAL` and are never read,
 * rewritten or reordered relative to each other by anything here.
 */

import type { CueOperation } from "../shared/domain";

export const SIMPLE_CUE_LABEL = "PERFORMANCE";

/** Positions are shifted through a high range so UNIQUE never trips mid-move. */
const POSITION_OFFSET = 1_000_000;

interface ActPresentationRow extends Record<string, SqlStorageValue> {
  performance_mode: string;
  performance_asset_id: string | null;
  performance_fit: string;
  backing_audio_asset_id: string | null;
  backing_audio_start: string;
}

export interface SimpleCueSummary {
  id: string;
  hasVisual: boolean;
  hasAudio: boolean;
  /** Backing audio starts with the performance rather than on GO. */
  autoStartAudio: boolean;
}

function assetMimeType(
  sql: SqlStorage,
  showIdentifier: string,
  assetId: string,
): string | null {
  return (
    sql
      .exec<{ mime_type: string }>(
        "SELECT mime_type FROM media_assets WHERE show_id = ? AND id = ? AND deleted_at IS NULL",
        showIdentifier,
        assetId,
      )
      .toArray()[0]?.mime_type ?? null
  );
}

/**
 * The operations an act's presentation asks for, or an empty list when the act
 * uses the automatic screen with no backing track — in which case no cue row is
 * needed at all and the projector simply draws the performance graphic.
 */
export function simpleCueOperations(
  sql: SqlStorage,
  showIdentifier: string,
  act: ActPresentationRow,
): CueOperation[] {
  const operations: CueOperation[] = [];
  if (act.performance_mode === "CUSTOM" && act.performance_asset_id) {
    const mimeType = assetMimeType(
      sql,
      showIdentifier,
      act.performance_asset_id,
    );
    if (mimeType?.startsWith("video/")) {
      operations.push({
        kind: "visual",
        visual: {
          kind: "VIDEO",
          sourceKey: act.performance_asset_id,
          title: null,
        },
      });
    } else if (mimeType?.startsWith("image/")) {
      operations.push({
        kind: "visual",
        visual: {
          kind: "IMAGE",
          sourceKey: act.performance_asset_id,
          title: null,
          // Contain is the default everywhere: the whole image, its own aspect
          // ratio, letterboxed against the theme rather than cropped.
          ...(act.performance_fit === "cover" ? { fit: "cover" as const } : {}),
        },
      });
    }
  }
  if (act.backing_audio_asset_id) {
    const mimeType = assetMimeType(
      sql,
      showIdentifier,
      act.backing_audio_asset_id,
    );
    if (mimeType?.startsWith("audio/") || mimeType?.startsWith("video/")) {
      operations.push({
        kind: "audio",
        action: "LOAD",
        assetId: act.backing_audio_asset_id,
      });
    }
  }
  return operations;
}

function readAct(
  sql: SqlStorage,
  showIdentifier: string,
  actIdentifier: string,
): ActPresentationRow | null {
  return (
    sql
      .exec<ActPresentationRow>(
        `SELECT performance_mode, performance_asset_id, performance_fit,
                backing_audio_asset_id, backing_audio_start
         FROM acts WHERE show_id = ? AND id = ?`,
        showIdentifier,
        actIdentifier,
      )
      .toArray()[0] ?? null
  );
}

/**
 * Brings the act's derived cue into line with its presentation. Call inside the
 * transaction that changed the act; it rewrites only `SIMPLE` rows.
 */
export function syncSimpleCues(
  sql: SqlStorage,
  showIdentifier: string,
  actIdentifier: string,
): void {
  const act = readAct(sql, showIdentifier, actIdentifier);
  if (!act) return;
  const operations = simpleCueOperations(sql, showIdentifier, act);
  const timestamp = new Date().toISOString();

  const existing = sql
    .exec<{ id: string }>(
      "SELECT id FROM cues WHERE show_id = ? AND act_id = ? AND origin = 'SIMPLE'",
      showIdentifier,
      actIdentifier,
    )
    .toArray();
  for (const cue of existing) {
    sql.exec(
      "DELETE FROM cue_asset_references WHERE show_id = ? AND cue_id = ?",
      showIdentifier,
      cue.id,
    );
    sql.exec(
      "DELETE FROM cues WHERE show_id = ? AND id = ?",
      showIdentifier,
      cue.id,
    );
  }

  const manual = sql
    .exec<{ id: string }>(
      "SELECT id FROM cues WHERE show_id = ? AND act_id = ? ORDER BY position",
      showIdentifier,
      actIdentifier,
    )
    .toArray();
  sql.exec(
    "UPDATE cues SET position = position + ? WHERE show_id = ? AND act_id = ?",
    POSITION_OFFSET,
    showIdentifier,
    actIdentifier,
  );
  // The derived cue is the act's first cue when it exists, so GO always means
  // "start this performance" without the operator hunting through the stack.
  const base = operations.length > 0 ? 1 : 0;
  manual.forEach((cue, index) => {
    sql.exec(
      "UPDATE cues SET position = ?, updated_at = ? WHERE show_id = ? AND id = ?",
      base + index,
      timestamp,
      showIdentifier,
      cue.id,
    );
  });
  if (operations.length === 0) return;

  const id = `cue-simple-${actIdentifier}`;
  const visual = operations.find(
    (operation): operation is Extract<CueOperation, { kind: "visual" }> =>
      operation.kind === "visual",
  );
  const audio = operations.find(
    (operation): operation is Extract<CueOperation, { kind: "audio" }> =>
      operation.kind === "audio",
  );
  sql.exec(
    `INSERT INTO cues (
      id, show_id, act_id, position, visual_kind, visual_source_key, visual_title,
      audio_kind, audio_source_key, duration_ms, created_at, updated_at,
      operator_label, operations_json, internal_note, origin
    ) VALUES (?, ?, ?, 0, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, '', 'SIMPLE')`,
    id,
    showIdentifier,
    actIdentifier,
    // The legacy channel columns still require a visual kind; a backing-audio
    // only cue records the harmless TITLE_CARD sentinel there, exactly as a
    // hand-authored transport cue does, and execution reads the operations.
    visual?.visual.kind ?? "TITLE_CARD",
    visual?.visual.sourceKey ?? null,
    audio ? "AUDIO" : null,
    audio?.assetId ?? null,
    timestamp,
    timestamp,
    SIMPLE_CUE_LABEL,
    JSON.stringify(operations),
  );
  for (const assetId of new Set(
    [visual?.visual.sourceKey, audio?.assetId].filter(
      (value): value is string => typeof value === "string",
    ),
  )) {
    sql.exec(
      "INSERT INTO cue_asset_references (show_id, cue_id, asset_id) VALUES (?, ?, ?)",
      showIdentifier,
      id,
      assetId,
    );
  }
}

/**
 * What entering PERFORMANCE should start for this act, if anything. The visual
 * always comes up with the performance; the backing track waits for GO unless
 * the act asked for it to start automatically.
 */
export function simpleCueForAct(
  sql: SqlStorage,
  showIdentifier: string,
  actIdentifier: string,
): SimpleCueSummary | null {
  const act = readAct(sql, showIdentifier, actIdentifier);
  if (!act) return null;
  const cue = sql
    .exec<{ id: string; operations_json: string }>(
      "SELECT id, operations_json FROM cues WHERE show_id = ? AND act_id = ? AND origin = 'SIMPLE' LIMIT 1",
      showIdentifier,
      actIdentifier,
    )
    .toArray()[0];
  if (!cue) return null;
  let operations: CueOperation[] = [];
  try {
    const parsed: unknown = JSON.parse(cue.operations_json);
    if (Array.isArray(parsed)) operations = parsed as CueOperation[];
  } catch {
    return null;
  }
  return {
    id: cue.id,
    hasVisual: operations.some((operation) => operation.kind === "visual"),
    hasAudio: operations.some((operation) => operation.kind === "audio"),
    autoStartAudio: act.backing_audio_start === "PERFORMANCE",
  };
}
