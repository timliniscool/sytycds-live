import { actId, type AdminAct } from "../shared/domain";
import { isRecord } from "../shared/trust";

const TEXT_LIMITS = {
  performerName: 160,
  schoolYear: 80,
  actName: 160,
  actType: 100,
  publicDescription: 2_000,
  internalNotes: 4_000,
} as const;

export interface ActInput {
  performerName: string;
  schoolYear: string;
  actName: string;
  actType: string;
  publicDescription: string;
  internalNotes: string;
  publicImageAssetId?: string | null;
}

export function parseActInput(value: unknown): ActInput | null {
  if (!isRecord(value)) return null;
  const fields = Object.keys(TEXT_LIMITS) as (keyof typeof TEXT_LIMITS)[];
  if (!fields.every((field) => typeof value[field] === "string")) return null;
  const publicImageAssetId =
    value.publicImageAssetId === null || value.publicImageAssetId === undefined
      ? null
      : typeof value.publicImageAssetId === "string" &&
          /^asset-[A-Za-z0-9-]{1,128}$/u.test(value.publicImageAssetId)
        ? value.publicImageAssetId
        : undefined;
  if (publicImageAssetId === undefined) return null;
  const candidate: ActInput = {
    performerName: (value.performerName as string).trim(),
    schoolYear: (value.schoolYear as string).trim(),
    actName: (value.actName as string).trim(),
    actType: (value.actType as string).trim(),
    publicDescription: (value.publicDescription as string).trim(),
    internalNotes: (value.internalNotes as string).trim(),
    publicImageAssetId,
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
    if (
      input.publicImageAssetId &&
      !storage.sql
        .exec<{ present: number }>(
          "SELECT 1 AS present FROM media_assets WHERE show_id = ? AND id = ? AND deleted_at IS NULL AND mime_type LIKE 'image/%'",
          showIdentifier,
          input.publicImageAssetId,
        )
        .toArray()[0]
    )
      return null;
    const id = `act-${crypto.randomUUID()}`;
    const timestamp = new Date().toISOString();
    storage.sql.exec(
      `INSERT INTO acts (id, show_id, order_index, performer_name, school_year, act_name, act_type, public_description, internal_notes, public_image_asset_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      timestamp,
      timestamp,
    );
    storage.sql.exec(
      "UPDATE shows SET revision = revision + 1, updated_at = ? WHERE id = ?",
      timestamp,
      showIdentifier,
    );
    return { id: actId(id), order, ...input, withdrawn: false, cues: [] };
  });
}

export function editAct(
  storage: DurableObjectStorage,
  showIdentifier: string,
  requestedId: string,
  input: ActInput,
): boolean {
  return storage.transactionSync(() => {
    if (
      input.publicImageAssetId &&
      !storage.sql
        .exec<{ present: number }>(
          "SELECT 1 AS present FROM media_assets WHERE show_id = ? AND id = ? AND deleted_at IS NULL AND mime_type LIKE 'image/%'",
          showIdentifier,
          input.publicImageAssetId,
        )
        .toArray()[0]
    )
      return false;
    const timestamp = new Date().toISOString();
    const updated = storage.sql.exec(
      `UPDATE acts SET performer_name = ?, school_year = ?, act_name = ?, act_type = ?, public_description = ?, internal_notes = ?, public_image_asset_id = ?, updated_at = ?
       WHERE show_id = ? AND id = ?`,
      input.performerName,
      input.schoolYear,
      input.actName,
      input.actType,
      input.publicDescription,
      input.internalNotes,
      input.publicImageAssetId ?? null,
      timestamp,
      showIdentifier,
      requestedId,
    );
    if (updated.rowsWritten !== 1) return false;
    storage.sql.exec(
      "UPDATE shows SET revision = revision + 1, updated_at = ? WHERE id = ?",
      timestamp,
      showIdentifier,
    );
    return true;
  });
}

export type DeleteActResult =
  "deleted" | "not_found" | "current_act" | "completed";

export function deleteAct(
  storage: DurableObjectStorage,
  showIdentifier: string,
  requestedId: string,
): DeleteActResult {
  return storage.transactionSync(() => {
    const show = storage.sql
      .exec<{ active_act_id: string | null }>(
        "SELECT active_act_id FROM shows WHERE id = ?",
        showIdentifier,
      )
      .toArray()[0];
    const act = storage.sql
      .exec<{ order_index: number }>(
        "SELECT order_index FROM acts WHERE show_id = ? AND id = ?",
        showIdentifier,
        requestedId,
      )
      .toArray()[0];
    if (!act) return "not_found";
    if (show?.active_act_id === requestedId) return "current_act";
    const used = storage.sql
      .exec<{ present: number }>(
        `SELECT 1 AS present FROM finalised_results_v2 WHERE show_id = ? AND act_id = ?
       UNION ALL SELECT 1 FROM audience_votes WHERE show_id = ? AND act_id = ?
       UNION ALL SELECT 1 FROM show_judge_submissions WHERE show_id = ? AND act_id = ? LIMIT 1`,
        showIdentifier,
        requestedId,
        showIdentifier,
        requestedId,
        showIdentifier,
        requestedId,
      )
      .toArray()[0];
    if (used) return "completed";
    const timestamp = new Date().toISOString();
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
    storage.sql.exec(
      "UPDATE shows SET revision = revision + 1, updated_at = ? WHERE id = ?",
      timestamp,
      showIdentifier,
    );
    return "deleted";
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
