import { isRecord } from "../shared/trust";

export interface ShowInput {
  title: string;
  tagline: string;
}

const MAX_TITLE = 120;
const MAX_TAGLINE = 160;

export function parseShowInput(value: unknown): ShowInput | null {
  if (
    !isRecord(value) ||
    typeof value.title !== "string" ||
    typeof value.tagline !== "string"
  ) {
    return null;
  }
  const title = value.title.replace(/\s+/gu, " ").trim();
  const tagline = value.tagline.replace(/\s+/gu, " ").trim();
  if (title.length === 0 || title.length > MAX_TITLE) return null;
  if (tagline.length > MAX_TAGLINE) return null;
  return { title, tagline };
}

/**
 * Creates the one show on first use or renames it later. Creation is the only
 * moment display, voting and reveal state take their defaults; a rename never
 * touches them, so it is safe during a live show.
 */
export function upsertShow(
  storage: DurableObjectStorage,
  showIdentifier: string,
  input: ShowInput,
): { created: boolean } {
  return storage.transactionSync(() => {
    const timestamp = new Date().toISOString();
    const existing = storage.sql
      .exec<{ present: number }>(
        "SELECT 1 AS present FROM shows WHERE id = ?",
        showIdentifier,
      )
      .toArray()[0];
    if (existing) {
      storage.sql.exec(
        `UPDATE shows SET title = ?, tagline = ?, revision = revision + 1, updated_at = ?
         WHERE id = ?`,
        input.title,
        input.tagline,
        timestamp,
        showIdentifier,
      );
      return { created: false };
    }
    storage.sql.exec(
      `INSERT INTO shows (
        id, title, tagline, display_mode, audience_vote_state, result_reveal_state,
        active_act_id, revision, created_at, updated_at
      ) VALUES (?, ?, ?, 'LOBBY', 'CLOSED', 'HIDDEN', NULL, 0, ?, ?)`,
      showIdentifier,
      input.title,
      input.tagline,
      timestamp,
      timestamp,
    );
    return { created: true };
  });
}
