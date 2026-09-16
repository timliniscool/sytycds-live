import {
  actId,
  INHERITED_APPEARANCE,
  type ActAppearance,
  type ActPresentation,
  type AdminAct,
  type PerformanceVisualMode,
} from "../shared/domain";
import { isThemeId } from "../shared/themes";
import { isRecord } from "../shared/trust";
import { retireUnreferencedAssets } from "./media-cleanup";
import { syncSimpleCues } from "./simple-flow";

const TEXT_LIMITS = {
  performerName: 160,
  schoolYear: 80,
  actName: 160,
  actType: 100,
  publicDescription: 2_000,
  internalNotes: 4_000,
} as const;

const MAX_FONT_FAMILY = 120;

export interface ActInput {
  performerName: string;
  schoolYear: string;
  actName: string;
  actType: string;
  publicDescription: string;
  internalNotes: string;
  publicImageAssetId?: string | null;
  showDescriptionToAudience: boolean;
  showImageToAudience: boolean;
  presentation: ActPresentation;
  appearance: ActAppearance;
}

const ASSET_ID = /^asset-[A-Za-z0-9-]{1,128}$/u;

function optionalAssetId(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "string" && ASSET_ID.test(value) ? value : undefined;
}

/**
 * Accepts both vocabularies: the operator-facing `performanceVisualMode`
 * (AUTOMATIC / IMAGE / VIDEO) and the stored `performanceMode` (DEFAULT /
 * CUSTOM). The visual mode is authoritative when both are present; the asset's
 * real kind is checked against it before anything is saved.
 */
function parsePresentation(
  value: unknown,
  publicImageAssetId: string | null,
): ActPresentation | null {
  const source = isRecord(value) ? value : {};
  const performanceAssetId = optionalAssetId(source.performanceAssetId);
  const backingAudioAssetId = optionalAssetId(source.backingAudioAssetId);
  const actImageAssetId =
    source.actImageAssetId === undefined
      ? publicImageAssetId
      : optionalAssetId(source.actImageAssetId);
  if (
    performanceAssetId === undefined ||
    backingAudioAssetId === undefined ||
    actImageAssetId === undefined
  )
    return null;
  let visualMode: PerformanceVisualMode;
  if (
    source.performanceVisualMode === "AUTOMATIC" ||
    source.performanceVisualMode === "IMAGE" ||
    source.performanceVisualMode === "VIDEO"
  ) {
    visualMode = source.performanceVisualMode;
  } else if (source.performanceVisualMode !== undefined) {
    return null;
  } else {
    visualMode = source.performanceMode === "CUSTOM" ? "IMAGE" : "AUTOMATIC";
  }
  // A custom performance visual without a file is the default screen; saying
  // so here keeps an impossible state out of the database entirely.
  const custom = visualMode !== "AUTOMATIC" && performanceAssetId !== null;
  return {
    actImageAssetId,
    performanceMode: custom ? "CUSTOM" : "DEFAULT",
    performanceVisualMode: custom ? visualMode : "AUTOMATIC",
    performanceAssetId: custom ? performanceAssetId : null,
    performanceFit: source.performanceFit === "cover" ? "cover" : "contain",
    backingAudioAssetId,
    backingAudioStart:
      source.backingAudioStart === "PERFORMANCE" ? "PERFORMANCE" : "MANUAL",
  };
}

function parseAppearance(value: unknown): ActAppearance | null {
  if (value === undefined || value === null) return { ...INHERITED_APPEARANCE };
  if (!isRecord(value)) return null;
  const themeId =
    value.themeId === null ||
    value.themeId === undefined ||
    value.themeId === ""
      ? null
      : isThemeId(value.themeId)
        ? value.themeId
        : undefined;
  const fontRaw = value.fontFamily;
  const fontFamily =
    fontRaw === null || fontRaw === undefined || fontRaw === ""
      ? null
      : typeof fontRaw === "string"
        ? fontRaw.replace(/\s+/gu, " ").trim()
        : undefined;
  if (
    themeId === undefined ||
    fontFamily === undefined ||
    (fontFamily !== null &&
      (fontFamily.length === 0 || fontFamily.length > MAX_FONT_FAMILY))
  )
    return null;
  return { themeId, fontFamily };
}

export function parseActInput(value: unknown): ActInput | null {
  if (!isRecord(value)) return null;
  const fields = Object.keys(TEXT_LIMITS) as (keyof typeof TEXT_LIMITS)[];
  if (!fields.every((field) => typeof value[field] === "string")) return null;
  const publicImageAssetId = optionalAssetId(value.publicImageAssetId);
  if (publicImageAssetId === undefined) return null;
  const presentation = parsePresentation(
    value.presentation,
    publicImageAssetId,
  );
  if (!presentation) return null;
  const appearance = parseAppearance(value.appearance);
  if (!appearance) return null;
  const candidate: ActInput = {
    performerName: (value.performerName as string).trim(),
    schoolYear: (value.schoolYear as string).trim(),
    actName: (value.actName as string).trim(),
    actType: (value.actType as string).trim(),
    publicDescription: (value.publicDescription as string).trim(),
    internalNotes: (value.internalNotes as string).trim(),
    // The act image is one field with two spellings; the presentation's wins.
    publicImageAssetId: presentation.actImageAssetId,
    showDescriptionToAudience: value.showDescriptionToAudience === true,
    showImageToAudience: value.showImageToAudience === true,
    presentation,
    appearance,
  };
  if (
    candidate.performerName.length === 0 ||
    candidate.actName.length === 0 ||
    candidate.actType.length === 0
  )
    return null;
  return fields.every((field) => candidate[field].length <= TEXT_LIMITS[field])
    ? candidate
    : null;
}

/** The stored performance mode plus the asset's kind, as the operator sees it. */
function visualModeFor(
  sql: SqlStorage,
  showIdentifier: string,
  presentation: ActPresentation,
): PerformanceVisualMode {
  if (
    presentation.performanceMode !== "CUSTOM" ||
    !presentation.performanceAssetId
  )
    return "AUTOMATIC";
  const mime = sql
    .exec<{ mime_type: string }>(
      "SELECT mime_type FROM media_assets WHERE show_id = ? AND id = ? AND deleted_at IS NULL",
      showIdentifier,
      presentation.performanceAssetId,
    )
    .toArray()[0]?.mime_type;
  return mime?.startsWith("video/")
    ? "VIDEO"
    : mime?.startsWith("image/")
      ? "IMAGE"
      : "AUTOMATIC";
}

export function createAct(
  storage: DurableObjectStorage,
  showIdentifier: string,
  input: ActInput,
): AdminAct | null {
  return storage.transactionSync(() => {
    const present = storage.sql
      .exec<{ present: number }>(
        "SELECT 1 AS present FROM shows WHERE id = ?",
        showIdentifier,
      )
      .toArray()[0];
    if (!present) return null;
    const order = storage.sql
      .exec<{ next_order: number }>(
        "SELECT COALESCE(MAX(order_index) + 1, 0) AS next_order FROM acts WHERE show_id = ?",
        showIdentifier,
      )
      .one().next_order;
    if (!referencedAssetsExist(storage.sql, showIdentifier, input)) return null;
    const id = `act-${crypto.randomUUID()}`;
    const timestamp = new Date().toISOString();
    storage.sql.exec(
      `INSERT INTO acts (id, show_id, order_index, performer_name, school_year,
        act_name, act_type, public_description, internal_notes, public_image_asset_id,
        show_description_to_audience, show_image_to_audience, performance_mode,
        performance_asset_id, performance_fit, backing_audio_asset_id,
        backing_audio_start, theme_id, font_family, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      showIdentifier,
      order,
      input.performerName,
      input.schoolYear,
      input.actName,
      input.actType,
      input.publicDescription,
      input.internalNotes,
      input.publicImageAssetId ?? null,
      input.showDescriptionToAudience ? 1 : 0,
      input.showImageToAudience ? 1 : 0,
      input.presentation.performanceMode,
      input.presentation.performanceAssetId,
      input.presentation.performanceFit,
      input.presentation.backingAudioAssetId,
      input.presentation.backingAudioStart,
      input.appearance.themeId,
      input.appearance.fontFamily,
      timestamp,
      timestamp,
    );
    syncSimpleCues(storage.sql, showIdentifier, id);
    storage.sql.exec(
      "UPDATE shows SET revision = revision + 1, updated_at = ? WHERE id = ?",
      timestamp,
      showIdentifier,
    );
    return {
      id: actId(id),
      order,
      ...input,
      presentation: {
        ...input.presentation,
        performanceVisualMode: visualModeFor(
          storage.sql,
          showIdentifier,
          input.presentation,
        ),
      },
      withdrawn: false,
      cues: [],
    };
  });
}

/**
 * Every asset an act points at must exist, belong to this show and be of a kind
 * the slot can actually present, so an act can never be saved referring to
 * something the projector will fail to load in front of the hall.
 */
function referencedAssetsExist(
  sql: SqlStorage,
  showIdentifier: string,
  input: ActInput,
): boolean {
  const usable = (assetId: string, pattern: string): boolean =>
    sql
      .exec<{ present: number }>(
        `SELECT 1 AS present FROM media_assets
         WHERE show_id = ? AND id = ? AND deleted_at IS NULL AND mime_type GLOB ?`,
        showIdentifier,
        assetId,
        pattern,
      )
      .toArray().length > 0;
  if (input.publicImageAssetId && !usable(input.publicImageAssetId, "image/*"))
    return false;
  const { performanceAssetId, performanceVisualMode, backingAudioAssetId } =
    input.presentation;
  if (performanceAssetId) {
    // The declared kind must match the file: a video chosen as IMAGE, or vice
    // versa, is refused rather than silently reinterpreted.
    const pattern =
      performanceVisualMode === "VIDEO"
        ? "video/*"
        : performanceVisualMode === "IMAGE"
          ? "image/*"
          : null;
    if (!pattern || !usable(performanceAssetId, pattern)) return false;
  }
  if (
    backingAudioAssetId &&
    !usable(backingAudioAssetId, "audio/*") &&
    !usable(backingAudioAssetId, "video/*")
  )
    return false;
  return true;
}

export function editAct(
  storage: DurableObjectStorage,
  showIdentifier: string,
  requestedId: string,
  input: ActInput,
): boolean {
  return storage.transactionSync(() => {
    if (!referencedAssetsExist(storage.sql, showIdentifier, input))
      return false;
    const timestamp = new Date().toISOString();
    const updated = storage.sql.exec(
      `UPDATE acts SET performer_name = ?, school_year = ?, act_name = ?, act_type = ?,
         public_description = ?, internal_notes = ?, public_image_asset_id = ?,
         show_description_to_audience = ?, show_image_to_audience = ?,
         performance_mode = ?, performance_asset_id = ?, performance_fit = ?,
         backing_audio_asset_id = ?, backing_audio_start = ?,
         theme_id = ?, font_family = ?, updated_at = ?
       WHERE show_id = ? AND id = ?`,
      input.performerName,
      input.schoolYear,
      input.actName,
      input.actType,
      input.publicDescription,
      input.internalNotes,
      input.publicImageAssetId ?? null,
      input.showDescriptionToAudience ? 1 : 0,
      input.showImageToAudience ? 1 : 0,
      input.presentation.performanceMode,
      input.presentation.performanceAssetId,
      input.presentation.performanceFit,
      input.presentation.backingAudioAssetId,
      input.presentation.backingAudioStart,
      input.appearance.themeId,
      input.appearance.fontFamily,
      timestamp,
      showIdentifier,
      requestedId,
    );
    if (updated.rowsWritten !== 1) return false;
    syncSimpleCues(storage.sql, showIdentifier, requestedId);
    storage.sql.exec(
      "UPDATE shows SET revision = revision + 1, updated_at = ? WHERE id = ?",
      timestamp,
      showIdentifier,
    );
    return true;
  });
}

/** What deleting this act would actually destroy, in the operator's terms. */
export interface ActDeletionPreview {
  actId: string;
  actName: string;
  performerName: string;
  isCurrentAct: boolean;
  audienceVotes: number;
  judgeSubmissions: number;
  finalisedResult: boolean;
  cues: number;
  /** Files only this act uses or owns; they leave R2 with it. */
  releasedAssets: readonly {
    id: string;
    filename: string;
    sizeBytes: number;
  }[];
  /** Files another act still uses; they stay. */
  sharedAssets: readonly { id: string; filename: string }[];
  /**
   * Live conditions that must be resolved before deleting anything. These are
   * never overridable: deleting the act the hall is currently voting on is not
   * a decision a confirmation dialog should be able to authorise.
   */
  blockers: readonly string[];
}

export type ActDeletionLookup =
  | { ok: true; preview: ActDeletionPreview }
  | { ok: false; status: 404 | 409; reason: string };

export interface ActDeletionOutcome {
  preview: ActDeletionPreview;
  /** Assets retired to the cleanup queue by this deletion. */
  retiredAssets: number;
}

export type DeleteActResult =
  | { ok: true; outcome: ActDeletionOutcome }
  | { ok: false; status: 404 | 409; reason: string };

interface ActIdentityRow extends Record<string, SqlStorageValue> {
  id: string;
  order_index: number;
  act_name: string;
  performer_name: string;
  public_image_asset_id: string | null;
  performance_asset_id: string | null;
  backing_audio_asset_id: string | null;
}

const ACT_IDENTITY_COLUMNS = `id, order_index, act_name, performer_name,
       public_image_asset_id, performance_asset_id, backing_audio_asset_id`;

function countRows(
  sql: SqlStorage,
  table: string,
  showIdentifier: string,
  actIdentifier: string,
): number {
  return sql
    .exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${table} WHERE show_id = ? AND act_id = ?`,
      showIdentifier,
      actIdentifier,
    )
    .one().count;
}

/**
 * Every asset this act names directly, through one of its cues, or owns in its
 * media library. Owned-but-unused files leave with the act too: a library that
 * belongs to nobody is exactly the leak the orphan sweep exists to find.
 */
function actAssetIds(
  sql: SqlStorage,
  showIdentifier: string,
  act: ActIdentityRow,
): string[] {
  const fromCues = sql
    .exec<{ asset_id: string }>(
      `SELECT DISTINCT r.asset_id FROM cue_asset_references r
       JOIN cues c ON c.show_id = r.show_id AND c.id = r.cue_id
       WHERE r.show_id = ? AND c.act_id = ?`,
      showIdentifier,
      act.id,
    )
    .toArray()
    .map((row) => row.asset_id);
  const owned = sql
    .exec<{ id: string }>(
      "SELECT id FROM media_assets WHERE show_id = ? AND act_id = ? AND deleted_at IS NULL",
      showIdentifier,
      act.id,
    )
    .toArray()
    .map((row) => row.id);
  return [
    ...new Set(
      [
        act.public_image_asset_id,
        act.performance_asset_id,
        act.backing_audio_asset_id,
        ...fromCues,
        ...owned,
      ].filter((value): value is string => typeof value === "string"),
    ),
  ];
}

/**
 * Describes the deletion without performing it, so the operator confirms
 * against what will really happen rather than a generic warning.
 */
export function previewActDeletion(
  sql: SqlStorage,
  showIdentifier: string,
  requestedId: string,
): ActDeletionLookup {
  const act = sql
    .exec<ActIdentityRow>(
      `SELECT ${ACT_IDENTITY_COLUMNS} FROM acts WHERE show_id = ? AND id = ?`,
      showIdentifier,
      requestedId,
    )
    .toArray()[0];
  if (!act) return { ok: false, status: 404, reason: "Act not found" };
  const show = sql
    .exec<{ active_act_id: string | null; audience_vote_state: string }>(
      "SELECT active_act_id, audience_vote_state FROM shows WHERE id = ?",
      showIdentifier,
    )
    .one();
  const runtime = sql
    .exec<{ visual_transport: string; audio_transport: string }>(
      "SELECT visual_transport, audio_transport FROM show_runtime WHERE show_id = ?",
      showIdentifier,
    )
    .toArray()[0];
  const isCurrentAct = show.active_act_id === act.id;

  const blockers: string[] = [];
  if (isCurrentAct && show.audience_vote_state === "OPEN")
    blockers.push("Audience voting is open for this act. Close voting first.");
  if (
    isCurrentAct &&
    (runtime?.visual_transport === "PLAYING" ||
      runtime?.audio_transport === "PLAYING")
  )
    blockers.push("Media is playing for this act. Stop it first.");

  const released: { id: string; filename: string; sizeBytes: number }[] = [];
  const shared: { id: string; filename: string }[] = [];
  for (const assetId of actAssetIds(sql, showIdentifier, act)) {
    const asset = sql
      .exec<{ original_filename: string; size_bytes: number }>(
        "SELECT original_filename, size_bytes FROM media_assets WHERE show_id = ? AND id = ?",
        showIdentifier,
        assetId,
      )
      .toArray()[0];
    if (!asset) continue;
    const usedElsewhere =
      sql
        .exec<{ present: number }>(
          `SELECT 1 AS present FROM acts a
           WHERE a.show_id = ? AND a.id != ? AND (
             a.public_image_asset_id = ? OR a.performance_asset_id = ?
             OR a.backing_audio_asset_id = ?)
           UNION ALL
           SELECT 1 FROM cue_asset_references r
             JOIN cues c ON c.show_id = r.show_id AND c.id = r.cue_id
           WHERE r.show_id = ? AND r.asset_id = ? AND c.act_id != ?
           LIMIT 1`,
          showIdentifier,
          act.id,
          assetId,
          assetId,
          assetId,
          showIdentifier,
          assetId,
          act.id,
        )
        .toArray().length > 0;
    if (usedElsewhere)
      shared.push({ id: assetId, filename: asset.original_filename });
    else
      released.push({
        id: assetId,
        filename: asset.original_filename,
        sizeBytes: asset.size_bytes,
      });
  }

  return {
    ok: true,
    preview: {
      actId: act.id,
      actName: act.act_name,
      performerName: act.performer_name,
      isCurrentAct,
      audienceVotes: countRows(sql, "audience_votes", showIdentifier, act.id),
      judgeSubmissions: countRows(
        sql,
        "show_judge_submissions",
        showIdentifier,
        act.id,
      ),
      finalisedResult:
        countRows(sql, "finalised_results_v2", showIdentifier, act.id) > 0,
      cues: countRows(sql, "cues", showIdentifier, act.id),
      releasedAssets: released,
      sharedAssets: shared,
      blockers,
    },
  };
}

/**
 * Deletes an act and everything that belongs only to it, in one transaction.
 *
 * The act's scores are part of the act: leaving its votes, judge submissions or
 * frozen result behind would keep it in aggregates and rankings it no longer
 * belongs to. Assets shared with another act are kept; assets only this act
 * used or owned are retired and their objects queued for removal from R2.
 *
 * Deleting the current act is allowed once nothing is live: the transaction
 * clears the current act rather than refusing, because an operator removing an
 * act from the running order should not have to work out which other act to
 * select first. The operational log keeps its record of the deletion; audit
 * history is append-only and is deliberately not rewritten.
 */
export function deleteAct(
  storage: DurableObjectStorage,
  showIdentifier: string,
  requestedId: string,
): DeleteActResult {
  return storage.transactionSync((): DeleteActResult => {
    const checked = previewActDeletion(
      storage.sql,
      showIdentifier,
      requestedId,
    );
    if (!checked.ok) return checked;
    const preview = checked.preview;
    if (preview.blockers.length > 0)
      return { ok: false, status: 409, reason: preview.blockers[0]! };

    const act = storage.sql
      .exec<ActIdentityRow>(
        `SELECT ${ACT_IDENTITY_COLUMNS} FROM acts WHERE show_id = ? AND id = ?`,
        showIdentifier,
        requestedId,
      )
      .one();
    const assetIds = actAssetIds(storage.sql, showIdentifier, act);
    const timestamp = new Date().toISOString();

    storage.sql.exec(
      `DELETE FROM cue_asset_references
       WHERE show_id = ? AND cue_id IN (
         SELECT id FROM cues WHERE show_id = ? AND act_id = ?
       )`,
      showIdentifier,
      showIdentifier,
      requestedId,
    );
    // Children first; every one of these references the act.
    for (const table of [
      "cues",
      "result_snapshots",
      "finalised_results_v2",
      "finalised_results",
      "audience_aggregates",
      "audience_votes",
      "show_judge_submissions",
      "show_judge_permissions",
      "judge_submissions",
      "judge_permissions",
    ]) {
      storage.sql.exec(
        `DELETE FROM ${table} WHERE show_id = ? AND act_id = ?`,
        showIdentifier,
        requestedId,
      );
    }
    if (preview.isCurrentAct) {
      storage.sql.exec(
        `UPDATE shows SET active_act_id = NULL, result_reveal_state = 'HIDDEN'
         WHERE id = ?`,
        showIdentifier,
      );
      storage.sql.exec(
        `UPDATE show_runtime SET prepared_cue_id = NULL, active_visual_cue_id = NULL,
           active_audio_cue_id = NULL, visual_transport = 'STOPPED',
           audio_transport = 'STOPPED', flow_step = NULL,
           vote_close_revision = NULL, vote_closed_at = NULL, updated_at = ?
         WHERE show_id = ?`,
        timestamp,
        showIdentifier,
      );
    }
    // A shared file the deleted act owned becomes a show-level asset rather
    // than a dangling owner reference.
    storage.sql.exec(
      "UPDATE media_assets SET act_id = NULL WHERE show_id = ? AND act_id = ?",
      showIdentifier,
      requestedId,
    );
    storage.sql.exec(
      "DELETE FROM acts WHERE show_id = ? AND id = ?",
      showIdentifier,
      requestedId,
    );
    storage.sql.exec(
      "UPDATE acts SET order_index = order_index - 1, updated_at = ? WHERE show_id = ? AND order_index > ?",
      timestamp,
      showIdentifier,
      act.order_index,
    );
    const retiredAssets = retireUnreferencedAssets(
      storage.sql,
      showIdentifier,
      "act_deleted",
      assetIds,
    );
    storage.sql.exec(
      "UPDATE shows SET revision = revision + 1, updated_at = ? WHERE id = ?",
      timestamp,
      showIdentifier,
    );
    return { ok: true, outcome: { preview, retiredAssets } };
  });
}

/** Replacement is all-or-nothing and uses a positive temporary range to preserve the UNIQUE constraint. */
export function replaceActOrder(
  storage: DurableObjectStorage,
  showIdentifier: string,
  ids: readonly string[],
): boolean {
  return storage.transactionSync(() => {
    const existing = storage.sql
      .exec<{ id: string }>(
        "SELECT id FROM acts WHERE show_id = ? ORDER BY order_index",
        showIdentifier,
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
      "UPDATE acts SET order_index = order_index + 1000000 WHERE show_id = ?",
      showIdentifier,
    );
    ids.forEach((id, position) =>
      storage.sql.exec(
        "UPDATE acts SET order_index = ?, updated_at = ? WHERE show_id = ? AND id = ?",
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
