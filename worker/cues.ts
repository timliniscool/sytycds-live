import { type CueOperation, type VisualCueKind } from "../shared/domain";
import { isRecord } from "../shared/trust";

const VISUAL_KINDS = new Set<VisualCueKind>([
  "TITLE_CARD",
  "IMAGE",
  "SLIDES",
  "VIDEO",
  "BLACK",
  "CLEAR",
]);
const AUDIO_ACTIONS = new Set([
  "LOAD",
  "PLAY",
  "PAUSE",
  "RESUME",
  "STOP",
  "REPLAY",
  "SEEK",
]);

export interface CueInput {
  operatorLabel: string;
  operations: readonly CueOperation[];
  internalNote: string;
}

function assetId(value: unknown): string | null {
  return typeof value === "string" && /^asset-[A-Za-z0-9-]{1,128}$/u.test(value)
    ? value
    : null;
}

export function parseCueInput(value: unknown): CueInput | null {
  if (
    !isRecord(value) ||
    typeof value.operatorLabel !== "string" ||
    typeof value.internalNote !== "string" ||
    !Array.isArray(value.operations)
  )
    return null;
  if (
    value.operatorLabel.trim().length === 0 ||
    value.operatorLabel.length > 160 ||
    value.internalNote.length > 2_000 ||
    value.operations.length === 0 ||
    value.operations.length > 12
  )
    return null;
  const operations: CueOperation[] = [];
  for (const operation of value.operations) {
    if (!isRecord(operation) || typeof operation.kind !== "string") return null;
    if (
      operation.kind === "visual" &&
      isRecord(operation.visual) &&
      typeof operation.visual.kind === "string" &&
      VISUAL_KINDS.has(operation.visual.kind as VisualCueKind) &&
      (operation.visual.sourceKey === null ||
        typeof operation.visual.sourceKey === "string") &&
      (operation.visual.title === null ||
        typeof operation.visual.title === "string")
    ) {
      const sourceKey = operation.visual.sourceKey;
      if (typeof sourceKey === "string" && !assetId(sourceKey)) return null;
      // Cropping is opt-in per cue and only meaningful for a full-frame image.
      const fit = operation.visual.fit;
      if (fit !== undefined && fit !== "contain" && fit !== "cover")
        return null;
      if (fit === "cover" && operation.visual.kind !== "IMAGE") return null;
      operations.push({
        kind: "visual",
        visual: {
          kind: operation.visual.kind as VisualCueKind,
          sourceKey,
          title: operation.visual.title,
          ...(fit === "cover" ? { fit } : {}),
        },
      });
    } else if (
      operation.kind === "audio" &&
      typeof operation.action === "string" &&
      AUDIO_ACTIONS.has(operation.action)
    ) {
      const suppliedAssetId =
        operation.assetId === undefined
          ? undefined
          : assetId(operation.assetId);
      if (operation.assetId !== undefined && !suppliedAssetId) return null;
      if (operation.action === "LOAD" && !suppliedAssetId) return null;
      const positionMs = operation.positionMs;
      if (
        positionMs !== undefined &&
        (typeof positionMs !== "number" ||
          !Number.isSafeInteger(positionMs) ||
          positionMs < 0)
      )
        return null;
      if (operation.action === "SEEK" && positionMs === undefined) return null;
      operations.push({
        kind: "audio",
        action: operation.action as Extract<
          CueOperation,
          { kind: "audio" }
        >["action"],
        ...(suppliedAssetId ? { assetId: suppliedAssetId } : {}),
        ...(typeof positionMs === "number" ? { positionMs } : {}),
      });
    } else if (
      operation.kind === "delay" &&
      typeof operation.durationMs === "number" &&
      Number.isSafeInteger(operation.durationMs) &&
      operation.durationMs >= 0 &&
      operation.durationMs <= 60_000
    ) {
      operations.push({ kind: "delay", durationMs: operation.durationMs });
    } else return null;
  }
  return {
    operatorLabel: value.operatorLabel.trim(),
    operations,
    internalNote: value.internalNote.trim(),
  };
}

function referencedAssets(operations: readonly CueOperation[]): string[] {
  return [
    ...new Set(
      operations.flatMap((operation) => {
        if (operation.kind === "visual" && operation.visual.sourceKey)
          return [operation.visual.sourceKey];
        if (operation.kind === "audio" && operation.assetId)
          return [operation.assetId];
        return [];
      }),
    ),
  ];
}

export function cueValidationState(
  sql: SqlStorage,
  showIdentifier: string,
  operations: readonly CueOperation[],
): "VALID" | "MISSING_MEDIA" | "INCOMPATIBLE_MEDIA" {
  for (const operation of operations) {
    const reference =
      operation.kind === "visual"
        ? operation.visual.sourceKey
        : operation.kind === "audio"
          ? operation.assetId
          : null;
    if (!reference) continue;
    const asset = sql
      .exec<{ mime_type: string }>(
        "SELECT mime_type FROM media_assets WHERE show_id = ? AND id = ? AND deleted_at IS NULL",
        showIdentifier,
        reference,
      )
      .toArray()[0];
    if (!asset) return "MISSING_MEDIA";
    let compatible = false;
    if (operation.kind === "audio")
      compatible =
        asset.mime_type.startsWith("audio/") ||
        asset.mime_type.startsWith("video/");
    if (operation.kind === "visual")
      compatible =
        operation.visual.kind === "IMAGE" || operation.visual.kind === "SLIDES"
          ? asset.mime_type.startsWith("image/")
          : operation.visual.kind === "VIDEO"
            ? asset.mime_type.startsWith("video/")
            : false;
    if (!compatible) return "INCOMPATIBLE_MEDIA";
  }
  return "VALID";
}

function legacyColumns(operations: readonly CueOperation[]): {
  visualKind: string | null;
  visualSource: string | null;
  visualTitle: string | null;
  audioKind: string | null;
  audioSource: string | null;
} {
  const visual = operations.find(
    (operation): operation is Extract<CueOperation, { kind: "visual" }> =>
      operation.kind === "visual",
  );
  const load = operations.find(
    (operation): operation is Extract<CueOperation, { kind: "audio" }> =>
      operation.kind === "audio" &&
      (operation.action === "LOAD" || operation.action === "PLAY") &&
      Boolean(operation.assetId),
  );
  return {
    // The original table required one legacy channel column. Operation-only
    // transport cues use a harmless TITLE_CARD sentinel there; execution reads
    // the validated operation list and therefore leaves the visual unchanged.
    visualKind:
      visual?.visual.kind === "CLEAR"
        ? "TITLE_CARD"
        : (visual?.visual.kind ?? (load ? null : "TITLE_CARD")),
    visualSource: visual?.visual.sourceKey ?? null,
    visualTitle: visual?.visual.title ?? null,
    audioKind: load ? "AUDIO" : null,
    audioSource: load?.assetId ?? null,
  };
}

export function createCue(
  storage: DurableObjectStorage,
  showIdentifier: string,
  actIdentifier: string,
  input: CueInput,
): string | null {
  return storage.transactionSync(() => {
    if (
      !storage.sql
        .exec<{ present: number }>(
          "SELECT 1 AS present FROM acts WHERE show_id = ? AND id = ?",
          showIdentifier,
          actIdentifier,
        )
        .toArray()[0]
    )
      return null;
    const assets = referencedAssets(input.operations);
    if (
      cueValidationState(storage.sql, showIdentifier, input.operations) !==
      "VALID"
    )
      return null;
    const id = `cue-${crypto.randomUUID()}`;
    const position = storage.sql
      .exec<{ position: number }>(
        "SELECT COALESCE(MAX(position) + 1, 0) AS position FROM cues WHERE show_id = ? AND act_id = ?",
        showIdentifier,
        actIdentifier,
      )
      .one().position;
    const timestamp = new Date().toISOString();
    const legacy = legacyColumns(input.operations);
    storage.sql.exec(
      `INSERT INTO cues (id, show_id, act_id, position, visual_kind, visual_source_key, visual_title, audio_kind, audio_source_key, duration_ms, created_at, updated_at, operator_label, operations_json, internal_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      id,
      showIdentifier,
      actIdentifier,
      position,
      legacy.visualKind,
      legacy.visualSource,
      legacy.visualTitle,
      legacy.audioKind,
      legacy.audioSource,
      timestamp,
      timestamp,
      input.operatorLabel,
      JSON.stringify(input.operations),
      input.internalNote,
    );
    for (const asset of assets)
      storage.sql.exec(
        "INSERT INTO cue_asset_references (show_id, cue_id, asset_id) VALUES (?, ?, ?)",
        showIdentifier,
        id,
        asset,
      );
    storage.sql.exec(
      "UPDATE shows SET revision = revision + 1, updated_at = ? WHERE id = ?",
      timestamp,
      showIdentifier,
    );
    return id;
  });
}

export function editCue(
  storage: DurableObjectStorage,
  showIdentifier: string,
  requestedId: string,
  input: CueInput,
): boolean {
  return storage.transactionSync(() => {
    const cue = storage.sql
      .exec<{ act_id: string }>(
        "SELECT act_id FROM cues WHERE show_id = ? AND id = ?",
        showIdentifier,
        requestedId,
      )
      .toArray()[0];
    if (
      !cue ||
      cueValidationState(storage.sql, showIdentifier, input.operations) !==
        "VALID"
    )
      return false;
    const timestamp = new Date().toISOString();
    const legacy = legacyColumns(input.operations);
    storage.sql.exec(
      `UPDATE cues SET visual_kind = ?, visual_source_key = ?, visual_title = ?, audio_kind = ?, audio_source_key = ?, operator_label = ?, operations_json = ?, internal_note = ?, updated_at = ? WHERE show_id = ? AND id = ?`,
      legacy.visualKind,
      legacy.visualSource,
      legacy.visualTitle,
      legacy.audioKind,
      legacy.audioSource,
      input.operatorLabel,
      JSON.stringify(input.operations),
      input.internalNote,
      timestamp,
      showIdentifier,
      requestedId,
    );
    storage.sql.exec(
      "DELETE FROM cue_asset_references WHERE show_id = ? AND cue_id = ?",
      showIdentifier,
      requestedId,
    );
    for (const asset of referencedAssets(input.operations))
      storage.sql.exec(
        "INSERT INTO cue_asset_references (show_id, cue_id, asset_id) VALUES (?, ?, ?)",
        showIdentifier,
        requestedId,
        asset,
      );
    storage.sql.exec(
      "UPDATE shows SET revision = revision + 1, updated_at = ? WHERE id = ?",
      timestamp,
      showIdentifier,
    );
    return true;
  });
}

export function duplicateCue(
  storage: DurableObjectStorage,
  showIdentifier: string,
  requestedId: string,
): string | null {
  const cue = storage.sql
    .exec<{
      act_id: string;
      operator_label: string;
      operations_json: string;
      internal_note: string;
    }>(
      "SELECT act_id, operator_label, operations_json, internal_note FROM cues WHERE show_id = ? AND id = ?",
      showIdentifier,
      requestedId,
    )
    .toArray()[0];
  if (!cue) return null;
  let operations: unknown;
  try {
    operations = JSON.parse(cue.operations_json);
  } catch {
    return null;
  }
  return createCue(
    storage,
    showIdentifier,
    cue.act_id,
    parseCueInput({
      operatorLabel: `${cue.operator_label} copy`,
      operations,
      internalNote: cue.internal_note,
    }) ?? { operatorLabel: "", operations: [], internalNote: "" },
  );
}

export function deleteCue(
  storage: DurableObjectStorage,
  showIdentifier: string,
  requestedId: string,
): boolean {
  return storage.transactionSync(() => {
    const cue = storage.sql
      .exec<{ act_id: string; position: number }>(
        "SELECT act_id, position FROM cues WHERE show_id = ? AND id = ?",
        showIdentifier,
        requestedId,
      )
      .toArray()[0];
    if (!cue) return false;
    const timestamp = new Date().toISOString();
    storage.sql.exec(
      "DELETE FROM cue_asset_references WHERE show_id = ? AND cue_id = ?",
      showIdentifier,
      requestedId,
    );
    storage.sql.exec(
      "DELETE FROM cues WHERE show_id = ? AND id = ?",
      showIdentifier,
      requestedId,
    );
    storage.sql.exec(
      "UPDATE cues SET position = position - 1, updated_at = ? WHERE show_id = ? AND act_id = ? AND position > ?",
      timestamp,
      showIdentifier,
      cue.act_id,
      cue.position,
    );
    storage.sql.exec(
      "UPDATE shows SET revision = revision + 1, updated_at = ? WHERE id = ?",
      timestamp,
      showIdentifier,
    );
    return true;
  });
}

export function replaceCueOrder(
  storage: DurableObjectStorage,
  showIdentifier: string,
  actIdentifier: string,
  ids: readonly string[],
): boolean {
  return storage.transactionSync(() => {
    const existing = storage.sql
      .exec<{ id: string }>(
        "SELECT id FROM cues WHERE show_id = ? AND act_id = ? ORDER BY position",
        showIdentifier,
        actIdentifier,
      )
      .toArray()
      .map((row) => row.id);
    if (
      existing.length !== ids.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !existing.includes(id))
    )
      return false;
    const timestamp = new Date().toISOString();
    storage.sql.exec(
      "UPDATE cues SET position = position + 1000000 WHERE show_id = ? AND act_id = ?",
      showIdentifier,
      actIdentifier,
    );
    ids.forEach((id, position) =>
      storage.sql.exec(
        "UPDATE cues SET position = ?, updated_at = ? WHERE show_id = ? AND id = ?",
        position,
        timestamp,
        showIdentifier,
        id,
      ),
    );
    storage.sql.exec(
      "UPDATE shows SET revision = revision + 1, updated_at = ? WHERE id = ?",
      timestamp,
      showIdentifier,
    );
    return true;
  });
}
