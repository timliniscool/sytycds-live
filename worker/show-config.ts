import { isRecord } from "../shared/trust";
import { DEFAULT_EVENT_NAME } from "../shared/platform";
import { DEFAULT_THEME_ID, isThemeId, type ThemeId } from "../shared/themes";

export interface ShowInput {
  title: string;
  tagline: string;
  shortName: string;
  themeId: ThemeId;
  fontFamily: string;
  reactionsEnabled: boolean;
}

const MAX_TITLE = 120;
const MAX_TAGLINE = 160;
const MAX_SHORT_NAME = 60;
const MAX_FONT_FAMILY = 120;

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
  const shortName =
    typeof value.shortName === "string"
      ? value.shortName.replace(/\s+/gu, " ").trim()
      : "";
  const themeId = isThemeId(value.themeId) ? value.themeId : DEFAULT_THEME_ID;
  const fontFamily =
    typeof value.fontFamily === "string"
      ? value.fontFamily.replace(/\s+/gu, " ").trim()
      : "system-ui";
  const reactionsEnabled =
    typeof value.reactionsEnabled === "boolean" ? value.reactionsEnabled : true;
  if (title.length === 0 || title.length > MAX_TITLE) return null;
  if (tagline.length > MAX_TAGLINE) return null;
  if (
    shortName.length > MAX_SHORT_NAME ||
    fontFamily.length === 0 ||
    fontFamily.length > MAX_FONT_FAMILY
  )
    return null;
  return { title, tagline, shortName, themeId, fontFamily, reactionsEnabled };
}

export const defaultShowInput = (): ShowInput => ({
  title: DEFAULT_EVENT_NAME,
  tagline: "",
  shortName: "",
  themeId: DEFAULT_THEME_ID,
  fontFamily: "system-ui",
  reactionsEnabled: true,
});

/**
 * Creates the one show on first use or renames it later. Creation is the only
 * moment display, voting and reveal state take their defaults; a rename never
 * touches them, so it is safe during a live show.
 */
export function upsertShow(
  storage: DurableObjectStorage,
  showIdentifier: string,
  supplied: ShowInput | Pick<ShowInput, "title" | "tagline">,
): { created: boolean } {
  const input: ShowInput = {
    ...defaultShowInput(),
    ...supplied,
  };
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
        `UPDATE shows SET title = ?, tagline = ?, short_name = ?,
          theme_id = ?, font_family = ?, reactions_enabled = ?,
          revision = revision + 1, updated_at = ?
         WHERE id = ?`,
        input.title,
        input.tagline,
        input.shortName,
        input.themeId,
        input.fontFamily,
        input.reactionsEnabled ? 1 : 0,
        timestamp,
        showIdentifier,
      );
      return { created: false };
    }
    storage.sql.exec(
      `INSERT INTO shows (
        id, title, tagline, short_name, theme_id, font_family,
        audience_weight, reactions_enabled, display_mode, audience_vote_state, result_reveal_state,
        active_act_id, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0.5, ?, 'LOBBY', 'CLOSED', 'HIDDEN', NULL, 0, ?, ?)`,
      showIdentifier,
      input.title,
      input.tagline,
      input.shortName,
      input.themeId,
      input.fontFamily,
      input.reactionsEnabled ? 1 : 0,
      timestamp,
      timestamp,
    );
    return { created: true };
  });
}
