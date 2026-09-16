import { isRecord } from "../shared/trust";
import { DEFAULT_EVENT_NAME } from "../shared/platform";
import { DEFAULT_THEME_ID, isThemeId, type ThemeId } from "../shared/themes";
import {
  DEFAULT_SHOW_FLOW_POLICY,
  type ShowFlowPolicy,
} from "../shared/domain";

export interface ShowInput {
  title: string;
  tagline: string;
  shortName: string;
  themeId: ThemeId;
  fontFamily: string;
  reactionsEnabled: boolean;
  /**
   * Absent when the caller did not send it: the stored policy is kept. A client
   * that only knows about the title must never quietly reset how GO behaves.
   */
  flowPolicy?: ShowFlowPolicy;
}

const MAX_TITLE = 120;
const MAX_TAGLINE = 160;
const MAX_SHORT_NAME = 60;
const MAX_FONT_FAMILY = 120;

export function parseFlowPolicy(value: unknown): ShowFlowPolicy | null {
  if (!isRecord(value)) return null;
  const flag = (candidate: unknown, fallback: boolean): boolean =>
    typeof candidate === "boolean" ? candidate : fallback;
  return {
    openJudgesOnScoring: flag(
      value.openJudgesOnScoring,
      DEFAULT_SHOW_FLOW_POLICY.openJudgesOnScoring,
    ),
    openVotingOnScoring: flag(
      value.openVotingOnScoring,
      DEFAULT_SHOW_FLOW_POLICY.openVotingOnScoring,
    ),
    scoreboardStep: flag(
      value.scoreboardStep,
      DEFAULT_SHOW_FLOW_POLICY.scoreboardStep,
    ),
    stopMediaOnScoring: flag(
      value.stopMediaOnScoring,
      DEFAULT_SHOW_FLOW_POLICY.stopMediaOnScoring,
    ),
  };
}

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
  const flowPolicy = parseFlowPolicy(value.flowPolicy);
  return {
    title,
    tagline,
    shortName,
    themeId,
    fontFamily,
    reactionsEnabled,
    ...(flowPolicy ? { flowPolicy } : {}),
  };
}

export const defaultShowInput = (): Required<ShowInput> => ({
  title: DEFAULT_EVENT_NAME,
  tagline: "",
  shortName: "",
  themeId: DEFAULT_THEME_ID,
  fontFamily: "system-ui",
  reactionsEnabled: true,
  flowPolicy: { ...DEFAULT_SHOW_FLOW_POLICY },
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
  const policy = "flowPolicy" in supplied ? supplied.flowPolicy : undefined;
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
      if (policy) writeFlowPolicy(storage.sql, showIdentifier, policy);
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
    writeFlowPolicy(
      storage.sql,
      showIdentifier,
      policy ?? DEFAULT_SHOW_FLOW_POLICY,
    );
    return { created: true };
  });
}

export function writeFlowPolicy(
  sql: SqlStorage,
  showIdentifier: string,
  policy: ShowFlowPolicy,
): void {
  sql.exec(
    `UPDATE shows SET flow_open_judges_on_scoring = ?, flow_open_voting_on_scoring = ?,
       flow_scoreboard_step = ?, flow_stop_media_on_scoring = ?
     WHERE id = ?`,
    policy.openJudgesOnScoring ? 1 : 0,
    policy.openVotingOnScoring ? 1 : 0,
    policy.scoreboardStep ? 1 : 0,
    policy.stopMediaOnScoring ? 1 : 0,
    showIdentifier,
  );
}
