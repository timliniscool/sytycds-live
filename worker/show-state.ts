import {
  parseAdminCommand,
  type AdminCommand,
  type AdminCommandAcknowledgement,
} from "../shared/admin-command";
import {
  actId,
  cueId,
  judgeId,
  showId,
  showRevision,
  type AdminShowProjection,
  type AdminJudgeState,
  type AudienceAggregate,
  type ActPresentation,
  type AudienceShowProjection,
  type ClientProjection,
  type ConnectionRole,
  type DisplayMode,
  type EmergencyPresentation,
  type JudgePermissionState,
  type JudgeShowProjection,
  type MediaTransportState,
  type ParsedJudgeScore,
  type PersistedCue,
  type PersistedShow,
  type ProjectorCue,
  type ProjectorShowProjection,
  type PublicAct,
  type ResultsStage,
  type ShowRuntimeState,
  type AudioCueKind,
  type CueOperation,
  type VisualCue,
  type VisualCueKind,
} from "../shared/domain";
import { rankGroups } from "../shared/ranking";
import { isThemeId, DEFAULT_THEME_ID } from "../shared/themes";
import { auditEventForCommand, recordAuditEvent } from "./audit";
import { cueValidationState } from "./cues";
import { listReferencedAssets } from "./media-assets";
import { audienceJoinUrl } from "./public-origin";
import { loadPublicResults, loadRanking } from "./rankings";
import { simpleCueForAct } from "./simple-flow";
import {
  finaliseResult,
  operationalResult,
  revealedFinalScore,
} from "./results";

export const PRIMARY_SHOW_ID = showId("primary");

export type StateChange =
  | "act"
  | "acts"
  | "display"
  | "audience_voting"
  | "judge_permission"
  | "result_reveal"
  | "results"
  | "media";

export interface ProjectionOptions {
  /** Canonical audience origin from deployment configuration, if any. */
  publicOrigin: string | null;
}

export interface CommandExecutionResult {
  acknowledgement: AdminCommandAcknowledgement;
  changes: readonly StateChange[];
}

interface ShowRow extends Record<string, SqlStorageValue> {
  id: string;
  title: string;
  tagline: string;
  short_name: string;
  theme_id: string;
  font_family: string;
  audience_weight: number;
  reactions_enabled: number;
  intermission_message: string;
  emergency_message: string;
  display_mode: string;
  audience_vote_state: string;
  result_reveal_state: string;
  active_act_id: string | null;
  revision: number;
}

interface RuntimeRow extends Record<string, SqlStorageValue> {
  previous_display_mode: string | null;
  global_judge_permission: string;
  prepared_cue_id: string | null;
  active_visual_cue_id: string | null;
  active_audio_cue_id: string | null;
  visual_transport: string;
  audio_transport: string;
  black_screen: number;
  emergency_presentation: string;
  results_stage: string;
  results_revealed_groups: number;
}

interface ActRow extends Record<string, SqlStorageValue> {
  id: string;
  order_index: number;
  performer_name: string;
  school_year: string;
  act_name: string;
  act_type: string;
  public_description: string;
  internal_notes: string;
  withdrawn_at: string | null;
  public_image_asset_id: string | null;
  show_description_to_audience: number;
  show_image_to_audience: number;
  performance_mode: string;
  performance_asset_id: string | null;
  performance_fit: string;
  backing_audio_asset_id: string | null;
  backing_audio_start: string;
}

const ACT_COLUMNS = `id, order_index, performer_name, school_year, act_name, act_type,
                public_description, internal_notes, withdrawn_at, public_image_asset_id,
                show_description_to_audience, show_image_to_audience, performance_mode,
                performance_asset_id, performance_fit, backing_audio_asset_id,
                backing_audio_start`;

interface JudgeSubmissionRow extends Record<string, SqlStorageValue> {
  id: string;
  slot: number;
  display_name: string;
  raw_input: string | null;
  parsed_classification: string | null;
  finite_value: number | null;
  effective_score: number | null;
  submitted_at: string | null;
}

interface CueRow extends Record<string, SqlStorageValue> {
  id: string;
  act_id: string;
  position: number;
  origin: string;
  visual_kind: string | null;
  visual_source_key: string | null;
  visual_title: string | null;
  audio_kind: string | null;
  audio_source_key: string | null;
  duration_ms: number | null;
  operator_label: string;
  operations_json: string;
  internal_note: string;
}

interface AggregateRow extends Record<string, SqlStorageValue> {
  act_id: string;
  vote_count: number;
  weighted_sum: number;
  total_weight: number;
  weighted_mean: number | null;
}

const DISPLAY_MODES = new Set<DisplayMode>([
  "LOBBY",
  "ACT_CARD",
  "PERFORMANCE",
  "SCOREBOARD",
  "INTERMISSION",
  "HOLD",
  "FINAL_RESULTS",
  "EMERGENCY",
]);

const TRANSPORT_STATES = new Set<MediaTransportState>([
  "STOPPED",
  "PREPARED",
  "PLAYING",
  "PAUSED",
]);

const RESULTS_STAGES = new Set<ResultsStage>([
  "HIDDEN",
  "LEADERBOARD",
  "STAGED",
  "TOP_THREE",
  "WINNER",
]);

function requireResultsStage(value: string): ResultsStage {
  if (!RESULTS_STAGES.has(value as ResultsStage)) {
    throw new Error(`Corrupt results stage in SQLite: ${value}`);
  }
  return value as ResultsStage;
}

function requireEmergencyPresentation(value: string): EmergencyPresentation {
  if (value !== "BLACK" && value !== "TEXT") {
    throw new Error(`Corrupt emergency presentation in SQLite: ${value}`);
  }
  return value;
}

function now(): string {
  return new Date().toISOString();
}

function requireDisplayMode(value: string): DisplayMode {
  if (!DISPLAY_MODES.has(value as DisplayMode)) {
    throw new Error(`Corrupt display mode in SQLite: ${value}`);
  }
  return value as DisplayMode;
}

function requireTransportState(value: string): MediaTransportState {
  if (!TRANSPORT_STATES.has(value as MediaTransportState)) {
    throw new Error(`Corrupt transport state in SQLite: ${value}`);
  }
  return value as MediaTransportState;
}

function asJudgePermission(value: string): JudgePermissionState {
  if (value !== "OPEN" && value !== "CLOSED") {
    throw new Error(`Corrupt judge permission in SQLite: ${value}`);
  }
  return value;
}

function loadShow(sql: SqlStorage, id: string): ShowRow | null {
  return (
    sql
      .exec<ShowRow>(
        `SELECT id, title, tagline, short_name, theme_id, font_family,
                audience_weight, reactions_enabled, intermission_message, emergency_message,
                display_mode, audience_vote_state, result_reveal_state,
                active_act_id, revision
         FROM shows WHERE id = ?`,
        id,
      )
      .toArray()[0] ?? null
  );
}

const RUNTIME_COLUMNS = `previous_display_mode, global_judge_permission, prepared_cue_id,
              active_visual_cue_id, active_audio_cue_id, visual_transport,
              audio_transport, black_screen, emergency_presentation,
              results_stage, results_revealed_groups`;

function readRuntime(sql: SqlStorage, id: string): RuntimeRow | undefined {
  return sql
    .exec<RuntimeRow>(
      `SELECT ${RUNTIME_COLUMNS} FROM show_runtime WHERE show_id = ?`,
      id,
    )
    .toArray()[0];
}

/** Every projection reads this; only the very first one ever writes it. */
function ensureRuntime(sql: SqlStorage, id: string): RuntimeRow {
  const existing = readRuntime(sql, id);
  if (existing) return existing;
  sql.exec(
    `INSERT OR IGNORE INTO show_runtime (
      show_id, previous_display_mode, global_judge_permission, prepared_cue_id,
      active_visual_cue_id, active_audio_cue_id, visual_transport, audio_transport,
      black_screen, updated_at
    ) VALUES (?, NULL, 'CLOSED', NULL, NULL, NULL, 'STOPPED', 'STOPPED', 0, ?)`,
    id,
    now(),
  );
  const row = readRuntime(sql, id);
  if (!row) {
    throw new Error("Unable to initialise show runtime state");
  }
  return row;
}

function runtimeState(id: string, row: RuntimeRow): ShowRuntimeState {
  return {
    showId: showId(id),
    previousDisplayMode: row.previous_display_mode
      ? requireDisplayMode(row.previous_display_mode)
      : null,
    globalJudgePermission: asJudgePermission(row.global_judge_permission),
    preparedCueId: row.prepared_cue_id ? cueId(row.prepared_cue_id) : null,
    activeVisualCueId: row.active_visual_cue_id
      ? cueId(row.active_visual_cue_id)
      : null,
    activeAudioCueId: row.active_audio_cue_id
      ? cueId(row.active_audio_cue_id)
      : null,
    visualTransport: requireTransportState(row.visual_transport),
    audioTransport: requireTransportState(row.audio_transport),
    blackScreen: row.black_screen === 1,
    emergencyPresentation: requireEmergencyPresentation(
      row.emergency_presentation,
    ),
    resultsStage: requireResultsStage(row.results_stage),
    resultsRevealedGroups: row.results_revealed_groups,
  };
}

function persistedShow(row: ShowRow): PersistedShow {
  return {
    id: showId(row.id),
    title: row.title,
    tagline: row.tagline,
    shortName: row.short_name,
    themeId: isThemeId(row.theme_id) ? row.theme_id : DEFAULT_THEME_ID,
    fontFamily: row.font_family,
    audienceWeight: row.audience_weight,
    reactionsEnabled: row.reactions_enabled === 1,
    intermissionMessage: row.intermission_message,
    emergencyMessage: row.emergency_message,
    displayMode: requireDisplayMode(row.display_mode),
    audienceVoteState: row.audience_vote_state === "OPEN" ? "OPEN" : "CLOSED",
    resultRevealState:
      row.result_reveal_state === "REVEALED" ? "REVEALED" : "HIDDEN",
    activeActId: row.active_act_id ? actId(row.active_act_id) : null,
    revision: showRevision(row.revision),
  };
}

function toPublicAct(row: ActRow): PublicAct {
  return {
    id: actId(row.id),
    order: row.order_index,
    performerName: row.performer_name,
    schoolYear: row.school_year,
    actName: row.act_name,
    actType: row.act_type,
    publicDescription: row.public_description,
    publicImageAssetId: row.public_image_asset_id,
    withdrawn: row.withdrawn_at !== null,
  };
}

/**
 * The audience slice of an act. Optional copy and artwork are opt-in per act
 * and are *removed here*, on the server, rather than sent and hidden: a phone
 * that never receives the description cannot leak it, and a hall of phones
 * never downloads artwork the act did not publish.
 */
function toAudienceAct(row: ActRow): PublicAct {
  const act = toPublicAct(row);
  return {
    ...act,
    publicDescription:
      row.show_description_to_audience === 1 ? act.publicDescription : "",
    publicImageAssetId:
      row.show_image_to_audience === 1
        ? (act.publicImageAssetId ?? null)
        : null,
  };
}

function toActPresentation(row: ActRow): ActPresentation {
  return {
    performanceMode: row.performance_mode === "CUSTOM" ? "CUSTOM" : "DEFAULT",
    performanceAssetId: row.performance_asset_id,
    performanceFit: row.performance_fit === "cover" ? "cover" : "contain",
    backingAudioAssetId: row.backing_audio_asset_id,
    backingAudioStart:
      row.backing_audio_start === "PERFORMANCE" ? "PERFORMANCE" : "MANUAL",
  };
}

function toCue(
  sql: SqlStorage,
  showIdentifier: string,
  row: CueRow,
): PersistedCue {
  let operations: CueOperation[] = [];
  let hasExplicitOperations = false;
  try {
    const candidate: unknown = JSON.parse(row.operations_json);
    if (Array.isArray(candidate)) {
      operations = candidate as CueOperation[];
      hasExplicitOperations = candidate.length > 0;
    }
  } catch {
    // A legacy cue is represented from its old non-executable columns below.
  }
  if (operations.length === 0) {
    if (row.visual_kind)
      operations.push({
        kind: "visual",
        visual: {
          kind: row.visual_kind as VisualCueKind,
          sourceKey: row.visual_source_key,
          title: row.visual_title,
        },
      });
    if (row.audio_kind && row.audio_source_key)
      operations.push({
        kind: "audio",
        action: "LOAD",
        assetId: row.audio_source_key,
      });
  }
  // The legacy columns mirror the first visual operation but carry no fit
  // policy, so the operation itself is the source of the visual where present.
  const visualOperation = operations.find(
    (operation): operation is Extract<CueOperation, { kind: "visual" }> =>
      operation.kind === "visual",
  );
  const legacyVisual: VisualCue | null = row.visual_kind
    ? {
        kind: row.visual_kind as VisualCueKind,
        sourceKey: row.visual_source_key,
        title: row.visual_title,
      }
    : null;
  return {
    id: cueId(row.id),
    showId: showId(showIdentifier),
    actId: actId(row.act_id),
    position: row.position,
    origin: row.origin === "SIMPLE" ? "SIMPLE" : "MANUAL",
    visual:
      visualOperation?.visual ?? (hasExplicitOperations ? null : legacyVisual),
    audio: row.audio_kind
      ? {
          kind: row.audio_kind as AudioCueKind,
          sourceKey: row.audio_source_key ?? "",
        }
      : null,
    durationMs: row.duration_ms,
    operatorLabel: row.operator_label,
    operations,
    internalNote: row.internal_note,
    validationState: cueValidationState(sql, showIdentifier, operations),
  };
}

function loadAct(
  sql: SqlStorage,
  showIdentifier: string,
  id: string,
): ActRow | null {
  return (
    sql
      .exec<ActRow>(
        `SELECT ${ACT_COLUMNS} FROM acts WHERE show_id = ? AND id = ?`,
        showIdentifier,
        id,
      )
      .toArray()[0] ?? null
  );
}

function activeAct(sql: SqlStorage, show: ShowRow): ActRow | null {
  if (!show.active_act_id) {
    return null;
  }
  const act = loadAct(sql, show.id, show.active_act_id);
  if (!act) {
    throw new Error("Current act violates the show-state invariant");
  }
  return act;
}

function cueForCurrentAct(
  sql: SqlStorage,
  show: ShowRow,
  selectedCueId: string,
): CueRow | null {
  if (!show.active_act_id) {
    return null;
  }
  return (
    sql
      .exec<CueRow>(
        `SELECT id, act_id, position, origin, visual_kind, visual_source_key, visual_title,
                audio_kind, audio_source_key, duration_ms, operator_label, operations_json, internal_note
         FROM cues WHERE show_id = ? AND act_id = ? AND id = ?`,
        show.id,
        show.active_act_id,
        selectedCueId,
      )
      .toArray()[0] ?? null
  );
}

function runtimeUpdate(
  sql: SqlStorage,
  showIdentifier: string,
  assignments: string,
  ...bindings: SqlStorageValue[]
): void {
  sql.exec(
    `UPDATE show_runtime SET ${assignments}, updated_at = ? WHERE show_id = ?`,
    ...bindings,
    now(),
    showIdentifier,
  );
}

function bumpRevision(sql: SqlStorage, show: ShowRow): number {
  const revision = show.revision + 1;
  sql.exec(
    "UPDATE shows SET revision = ?, updated_at = ? WHERE id = ?",
    revision,
    now(),
    show.id,
  );
  return revision;
}

function result(
  commandId: AdminCommand["commandId"] | null,
  status: AdminCommandAcknowledgement["status"],
  revision: number,
  reason?: string,
): AdminCommandAcknowledgement {
  return {
    commandId,
    status,
    revision: showRevision(revision),
    ...(reason ? { reason } : {}),
  };
}

function commandFingerprint(command: AdminCommand): string {
  return JSON.stringify(command);
}

function parseStoredAcknowledgement(
  value: string,
): AdminCommandAcknowledgement {
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Object.hasOwn(parsed, "status") ||
    !Object.hasOwn(parsed, "revision") ||
    !Object.hasOwn(parsed, "commandId")
  ) {
    throw new Error("Corrupt command acknowledgement in SQLite");
  }
  const record = parsed as Record<string, unknown>;
  const validStatuses = new Set([
    "accepted",
    "rejected",
    "stale",
    "invalid",
    "unauthorised",
    "conflict",
  ]);
  if (
    typeof record.commandId !== "string" ||
    typeof record.revision !== "number" ||
    typeof record.status !== "string" ||
    !validStatuses.has(record.status)
  ) {
    throw new Error("Invalid command acknowledgement in SQLite");
  }
  return {
    commandId: record.commandId as AdminCommand["commandId"],
    revision: showRevision(record.revision),
    status: record.status as AdminCommandAcknowledgement["status"],
    ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
  };
}

function recordCommand(
  sql: SqlStorage,
  showIdentifier: string,
  command: AdminCommand,
  acknowledgement: AdminCommandAcknowledgement,
): void {
  const timestamp = now();
  sql.exec(
    `INSERT INTO command_log (
      show_id, command_id, actor_role, outcome_json, created_at, request_fingerprint
    ) VALUES (?, ?, 'admin', ?, ?, ?)`,
    showIdentifier,
    command.commandId,
    JSON.stringify(acknowledgement),
    timestamp,
    commandFingerprint(command),
  );
  recordAuditEvent(
    sql,
    showIdentifier,
    auditEventForCommand(command, acknowledgement),
  );
}

function selectedActForDirection(
  sql: SqlStorage,
  show: ShowRow,
  direction: "next" | "previous",
): ActRow | null {
  if (!show.active_act_id && direction === "previous") {
    return null;
  }
  const current = activeAct(sql, show);
  const comparator = direction === "next" ? ">" : "<";
  const sort = direction === "next" ? "ASC" : "DESC";
  const currentOrder = current?.order_index ?? -1;
  // A withdrawn act is skipped by NEXT/PREVIOUS; it can still be selected
  // deliberately, which is how an operator reviews it.
  return (
    sql
      .exec<ActRow>(
        `SELECT ${ACT_COLUMNS}
         FROM acts WHERE show_id = ? AND order_index ${comparator} ?
           AND withdrawn_at IS NULL
         ORDER BY order_index ${sort} LIMIT 1`,
        show.id,
        currentOrder,
      )
      .toArray()[0] ?? null
  );
}

function assertActiveAct(show: ShowRow): string | null {
  return show.active_act_id;
}

function judgeHasSubmitted(
  sql: SqlStorage,
  showIdentifier: string,
  actIdentifier: string,
  judgeIdentifier: string,
): boolean {
  return (
    sql
      .exec<{ present: number }>(
        `SELECT 1 AS present FROM show_judge_submissions
         WHERE show_id = ? AND act_id = ? AND judge_id = ?`,
        showIdentifier,
        actIdentifier,
        judgeIdentifier,
      )
      .toArray().length > 0
  );
}

function judgeExists(
  sql: SqlStorage,
  showIdentifier: string,
  id: string,
): boolean {
  return (
    sql
      .exec<{ present: number }>(
        "SELECT 1 AS present FROM show_judges WHERE show_id = ? AND id = ? AND active = 1",
        showIdentifier,
        id,
      )
      .toArray().length > 0
  );
}

function setJudgePermission(
  sql: SqlStorage,
  showIdentifier: string,
  actIdentifier: string,
  judgeIdentifier: string,
  permission: JudgePermissionState,
): void {
  sql.exec(
    `INSERT INTO show_judge_permissions (
      show_id, act_id, judge_id, permission_state, updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(show_id, act_id, judge_id) DO UPDATE SET
      permission_state = excluded.permission_state,
      updated_at = excluded.updated_at`,
    showIdentifier,
    actIdentifier,
    judgeIdentifier,
    permission,
    now(),
  );
}

function isSafeDisplayMode(mode: DisplayMode): boolean {
  return mode !== "HOLD" && mode !== "EMERGENCY";
}

/**
 * HOLD and EMERGENCY are overlays: the show underneath is preserved so the
 * operator can return to it. EMERGENCY additionally pauses anything audible,
 * which is runtime state the same RESUME control brings back; nothing
 * persistent is touched.
 */
function enterOverrideMode(
  sql: SqlStorage,
  show: ShowRow,
  runtime: RuntimeRow,
  mode: "HOLD" | "EMERGENCY",
  presentation: EmergencyPresentation | null,
): readonly StateChange[] {
  const currentMode = requireDisplayMode(show.display_mode);
  const previousMode = isSafeDisplayMode(currentMode)
    ? currentMode
    : runtime.previous_display_mode;
  runtimeUpdate(sql, show.id, "previous_display_mode = ?", previousMode);
  sql.exec("UPDATE shows SET display_mode = ? WHERE id = ?", mode, show.id);
  if (mode === "HOLD") return ["display"];

  const changes: StateChange[] = ["display"];
  if (presentation) {
    runtimeUpdate(sql, show.id, "emergency_presentation = ?", presentation);
  }
  if (
    runtime.visual_transport === "PLAYING" ||
    runtime.audio_transport === "PLAYING"
  ) {
    runtimeUpdate(
      sql,
      show.id,
      "visual_transport = ?, audio_transport = ?",
      runtime.visual_transport === "PLAYING"
        ? "PAUSED"
        : runtime.visual_transport,
      runtime.audio_transport === "PLAYING"
        ? "PAUSED"
        : runtime.audio_transport,
    );
    changes.push("media");
  }
  return changes;
}

function executeTransition(
  sql: SqlStorage,
  show: ShowRow,
  runtime: RuntimeRow,
  command: AdminCommand,
): { accepted: boolean; reason?: string; changes: readonly StateChange[] } {
  const activeActId = assertActiveAct(show);
  switch (command.type) {
    case "SELECT_ACT":
      if (show.audience_vote_state === "OPEN") {
        return {
          accepted: false,
          reason: "Close audience voting before changing the current act",
          changes: [],
        };
      }
      if (!loadAct(sql, show.id, command.actId)) {
        return {
          accepted: false,
          reason: "Act does not belong to this show",
          changes: [],
        };
      }
      sql.exec(
        "UPDATE shows SET active_act_id = ?, result_reveal_state = 'HIDDEN' WHERE id = ?",
        command.actId,
        show.id,
      );
      return { accepted: true, changes: ["act"] };
    case "WITHDRAW_ACT": {
      const act = loadAct(sql, show.id, command.actId);
      if (!act) {
        return {
          accepted: false,
          reason: "Act does not belong to this show",
          changes: [],
        };
      }
      if (act.id === show.active_act_id) {
        return {
          accepted: false,
          reason: "Select a different act before withdrawing the current one",
          changes: [],
        };
      }
      if (act.withdrawn_at !== null) {
        return { accepted: true, changes: [] };
      }
      sql.exec(
        "UPDATE acts SET withdrawn_at = ?, updated_at = ? WHERE show_id = ? AND id = ?",
        now(),
        now(),
        show.id,
        act.id,
      );
      return { accepted: true, changes: ["acts", "results"] };
    }
    case "REINSTATE_ACT": {
      const act = loadAct(sql, show.id, command.actId);
      if (!act) {
        return {
          accepted: false,
          reason: "Act does not belong to this show",
          changes: [],
        };
      }
      if (act.withdrawn_at === null) {
        return { accepted: true, changes: [] };
      }
      sql.exec(
        "UPDATE acts SET withdrawn_at = NULL, updated_at = ? WHERE show_id = ? AND id = ?",
        now(),
        show.id,
        act.id,
      );
      return { accepted: true, changes: ["acts", "results"] };
    }
    case "NEXT_ACT": {
      if (show.audience_vote_state === "OPEN") {
        return {
          accepted: false,
          reason: "Close audience voting before changing the current act",
          changes: [],
        };
      }
      const next = selectedActForDirection(sql, show, "next");
      if (!next) {
        return { accepted: false, reason: "There is no next act", changes: [] };
      }
      sql.exec(
        "UPDATE shows SET active_act_id = ?, result_reveal_state = 'HIDDEN' WHERE id = ?",
        next.id,
        show.id,
      );
      return { accepted: true, changes: ["act"] };
    }
    case "PREVIOUS_ACT": {
      if (show.audience_vote_state === "OPEN") {
        return {
          accepted: false,
          reason: "Close audience voting before changing the current act",
          changes: [],
        };
      }
      const previous = selectedActForDirection(sql, show, "previous");
      if (!previous) {
        return {
          accepted: false,
          reason: "There is no previous act",
          changes: [],
        };
      }
      sql.exec(
        "UPDATE shows SET active_act_id = ?, result_reveal_state = 'HIDDEN' WHERE id = ?",
        previous.id,
        show.id,
      );
      return { accepted: true, changes: ["act"] };
    }
    case "SET_DISPLAY_MODE": {
      if (command.mode === "HOLD" || command.mode === "EMERGENCY") {
        return {
          accepted: true,
          changes: enterOverrideMode(sql, show, runtime, command.mode, null),
        };
      }
      sql.exec(
        "UPDATE shows SET display_mode = ? WHERE id = ?",
        command.mode,
        show.id,
      );
      // Simple Show Flow: an act configured with a custom performance visual
      // puts it up as the performance begins, and a backing track set to start
      // with the performance starts here too. An act that asked for GO waits
      // for GO. Nothing here touches the blackout override.
      const performance =
        command.mode === "PERFORMANCE" && activeActId
          ? simpleCueForAct(sql, show.id, activeActId)
          : null;
      if (
        !performance ||
        (!performance.hasVisual && !performance.autoStartAudio)
      )
        return { accepted: true, changes: ["display"] };
      runtimeUpdate(
        sql,
        show.id,
        `prepared_cue_id = ?, active_visual_cue_id = ?, active_audio_cue_id = ?,
         visual_transport = ?, audio_transport = ?`,
        performance.id,
        performance.hasVisual ? performance.id : runtime.active_visual_cue_id,
        performance.hasAudio && performance.autoStartAudio
          ? performance.id
          : runtime.active_audio_cue_id,
        performance.hasVisual ? "PLAYING" : runtime.visual_transport,
        performance.hasAudio && performance.autoStartAudio
          ? "PLAYING"
          : runtime.audio_transport,
      );
      return { accepted: true, changes: ["display", "media"] };
    }
    case "ACTIVATE_EMERGENCY":
      return {
        accepted: true,
        changes: enterOverrideMode(
          sql,
          show,
          runtime,
          "EMERGENCY",
          command.presentation,
        ),
      };
    case "SET_INTERMISSION_MESSAGE":
      sql.exec(
        "UPDATE shows SET intermission_message = ? WHERE id = ?",
        command.text,
        show.id,
      );
      return { accepted: true, changes: ["display"] };
    case "SET_EMERGENCY_MESSAGE":
      sql.exec(
        "UPDATE shows SET emergency_message = ? WHERE id = ?",
        command.text,
        show.id,
      );
      return { accepted: true, changes: ["display"] };
    case "SET_RESULTS_STAGE": {
      if (
        command.stage !== "HIDDEN" &&
        loadRanking(sql, show.id).ranked.length === 0
      ) {
        return {
          accepted: false,
          reason: "No act has a finalised result to rank yet",
          changes: [],
        };
      }
      // Leaving STAGED forgets the reveal position so the next staged run
      // starts from last place again.
      runtimeUpdate(
        sql,
        show.id,
        "results_stage = ?, results_revealed_groups = ?",
        command.stage,
        command.stage === "STAGED" ? runtime.results_revealed_groups : 0,
      );
      return { accepted: true, changes: ["results"] };
    }
    case "REVEAL_NEXT_RESULT": {
      if (runtime.results_stage !== "STAGED") {
        return {
          accepted: false,
          reason: "Staged reveal is not the active results stage",
          changes: [],
        };
      }
      const groups = rankGroups(loadRanking(sql, show.id).ranked).length;
      if (runtime.results_revealed_groups >= groups) {
        return {
          accepted: false,
          reason: "Every rank has been revealed",
          changes: [],
        };
      }
      runtimeUpdate(
        sql,
        show.id,
        "results_revealed_groups = ?",
        runtime.results_revealed_groups + 1,
      );
      return { accepted: true, changes: ["results"] };
    }
    case "RESET_RESULTS_REVEAL":
      runtimeUpdate(sql, show.id, "results_revealed_groups = 0");
      return { accepted: true, changes: ["results"] };
    case "RESTORE_DISPLAY": {
      if (
        (show.display_mode !== "HOLD" && show.display_mode !== "EMERGENCY") ||
        !runtime.previous_display_mode
      ) {
        return {
          accepted: false,
          reason: "No safe display mode is available to restore",
          changes: [],
        };
      }
      sql.exec(
        "UPDATE shows SET display_mode = ? WHERE id = ?",
        runtime.previous_display_mode,
        show.id,
      );
      runtimeUpdate(sql, show.id, "previous_display_mode = NULL");
      return { accepted: true, changes: ["display"] };
    }
    case "OPEN_AUDIENCE_VOTING":
      if (!activeActId) {
        return {
          accepted: false,
          reason: "Select an act before opening audience voting",
          changes: [],
        };
      }
      sql.exec(
        "UPDATE shows SET audience_vote_state = 'OPEN' WHERE id = ?",
        show.id,
      );
      return { accepted: true, changes: ["audience_voting"] };
    case "CLOSE_AUDIENCE_VOTING":
      sql.exec(
        "UPDATE shows SET audience_vote_state = 'CLOSED' WHERE id = ?",
        show.id,
      );
      return { accepted: true, changes: ["audience_voting"] };
    case "OPEN_ALL_JUDGES": {
      if (!activeActId) {
        return {
          accepted: false,
          reason: "Select an act before opening judge scoring",
          changes: [],
        };
      }
      const judges = sql
        .exec<{ id: string }>(
          "SELECT id FROM show_judges WHERE show_id = ? AND active = 1 ORDER BY slot",
          show.id,
        )
        .toArray();
      if (judges.length === 0 || judges.length > 8) {
        return {
          accepted: false,
          reason: "Configure between one and eight active judges first",
          changes: [],
        };
      }
      for (const judge of judges) {
        if (!judgeHasSubmitted(sql, show.id, activeActId, judge.id)) {
          setJudgePermission(sql, show.id, activeActId, judge.id, "OPEN");
        }
      }
      runtimeUpdate(sql, show.id, "global_judge_permission = 'OPEN'");
      return { accepted: true, changes: ["judge_permission"] };
    }
    case "CLOSE_ALL_JUDGES": {
      if (activeActId) {
        sql.exec(
          `UPDATE show_judge_permissions SET permission_state = 'CLOSED', updated_at = ?
           WHERE show_id = ? AND act_id = ?`,
          now(),
          show.id,
          activeActId,
        );
      }
      runtimeUpdate(sql, show.id, "global_judge_permission = 'CLOSED'");
      return { accepted: true, changes: ["judge_permission"] };
    }
    case "OPEN_JUDGE":
    case "CLOSE_JUDGE": {
      if (!activeActId) {
        return {
          accepted: false,
          reason: "Select an act before changing judge scoring",
          changes: [],
        };
      }
      if (!judgeExists(sql, show.id, command.judgeId)) {
        return {
          accepted: false,
          reason: "Judge does not belong to this show",
          changes: [],
        };
      }
      if (
        command.type === "OPEN_JUDGE" &&
        judgeHasSubmitted(sql, show.id, activeActId, command.judgeId)
      ) {
        return {
          accepted: false,
          reason: "Submitted judge scores cannot be reopened",
          changes: [],
        };
      }
      setJudgePermission(
        sql,
        show.id,
        activeActId,
        command.judgeId,
        command.type === "OPEN_JUDGE" ? "OPEN" : "CLOSED",
      );
      return { accepted: true, changes: ["judge_permission"] };
    }
    case "FINALISE_RESULT": {
      if (!activeActId) {
        return {
          accepted: false,
          reason: "Select an act before finalising a result",
          changes: [],
        };
      }
      const finalised = finaliseResult(sql, show.id, activeActId);
      return finalised.ok
        ? { accepted: true, changes: ["result_reveal"] }
        : { accepted: false, reason: finalised.reason, changes: [] };
    }
    case "REVEAL_RESULT":
      if (
        !activeActId ||
        operationalResult(sql, show.id, activeActId).kind !== "finalised"
      ) {
        return {
          accepted: false,
          reason: "Finalise a complete result before revealing it",
          changes: [],
        };
      }
      sql.exec(
        "UPDATE shows SET result_reveal_state = 'REVEALED' WHERE id = ?",
        show.id,
      );
      return { accepted: true, changes: ["result_reveal"] };
    case "HIDE_RESULT":
      sql.exec(
        "UPDATE shows SET result_reveal_state = 'HIDDEN' WHERE id = ?",
        show.id,
      );
      return { accepted: true, changes: ["result_reveal"] };
    case "PREPARE_CUE": {
      const cue = cueForCurrentAct(sql, show, command.cueId);
      if (!cue) {
        return {
          accepted: false,
          reason: "Cue does not belong to the current act",
          changes: [],
        };
      }
      runtimeUpdate(sql, show.id, "prepared_cue_id = ?", cue.id);
      return { accepted: true, changes: ["media"] };
    }
    case "PLAY_CUE": {
      const requestedCueId = command.cueId ?? runtime.prepared_cue_id;
      if (!requestedCueId) {
        return {
          accepted: false,
          reason: "Prepare or select a cue before playing",
          changes: [],
        };
      }
      const cue = cueForCurrentAct(sql, show, requestedCueId);
      if (!cue) {
        return {
          accepted: false,
          reason: "Cue does not belong to the current act",
          changes: [],
        };
      }
      const persistedCue = toCue(sql, show.id, cue);
      const visualOperation = persistedCue.operations.find(
        (operation): operation is Extract<CueOperation, { kind: "visual" }> =>
          operation.kind === "visual",
      );
      const audioOperations = persistedCue.operations.filter(
        (operation): operation is Extract<CueOperation, { kind: "audio" }> =>
          operation.kind === "audio",
      );

      // Operations are applied in order to independent visual and backing
      // audio channels. A visual-only cue never interrupts the track, while
      // audio transport cues never clear the current frame.
      let activeVisualCueId = runtime.active_visual_cue_id;
      let visualTransport = runtime.visual_transport;
      // Blackout is an output override, not part of the visual channel. Playing
      // a cue never lifts it: only the operator's own BLACK control does, so a
      // blacked-out hall cannot be uncovered by the next GO.
      let blackScreen = runtime.black_screen;
      if (visualOperation) {
        if (visualOperation.visual.kind === "CLEAR") {
          activeVisualCueId = null;
          visualTransport = "STOPPED";
        } else if (visualOperation.visual.kind === "BLACK") {
          activeVisualCueId = cue.id;
          visualTransport = "PLAYING";
          blackScreen = 1;
        } else {
          activeVisualCueId = cue.id;
          visualTransport = "PLAYING";
        }
      }

      let activeAudioCueId = runtime.active_audio_cue_id;
      let audioTransport = runtime.audio_transport;
      for (const operation of audioOperations) {
        switch (operation.action) {
          case "LOAD":
            activeAudioCueId = cue.id;
            // PREPARE_CUE performs the load-only step. GO/PLAY_CUE starts it.
            audioTransport = "PLAYING";
            break;
          case "PLAY":
            if (operation.assetId) activeAudioCueId = cue.id;
            if (activeAudioCueId) audioTransport = "PLAYING";
            break;
          case "PAUSE":
            if (activeAudioCueId) audioTransport = "PAUSED";
            break;
          case "RESUME":
          case "REPLAY":
          case "SEEK":
            if (activeAudioCueId) audioTransport = "PLAYING";
            break;
          case "STOP":
            activeAudioCueId = null;
            audioTransport = "STOPPED";
            break;
        }
      }
      runtimeUpdate(
        sql,
        show.id,
        `prepared_cue_id = ?, active_visual_cue_id = ?, active_audio_cue_id = ?,
        visual_transport = ?, audio_transport = ?, black_screen = ?`,
        cue.id,
        activeVisualCueId,
        activeAudioCueId,
        visualTransport,
        audioTransport,
        blackScreen,
      );
      return { accepted: true, changes: ["media"] };
    }
    case "PAUSE_MEDIA":
      runtimeUpdate(
        sql,
        show.id,
        "visual_transport = ?, audio_transport = ?",
        runtime.visual_transport === "PLAYING"
          ? "PAUSED"
          : runtime.visual_transport,
        runtime.audio_transport === "PLAYING"
          ? "PAUSED"
          : runtime.audio_transport,
      );
      return { accepted: true, changes: ["media"] };
    case "RESUME_MEDIA":
      runtimeUpdate(
        sql,
        show.id,
        "visual_transport = ?, audio_transport = ?",
        runtime.visual_transport === "PAUSED"
          ? "PLAYING"
          : runtime.visual_transport,
        runtime.audio_transport === "PAUSED"
          ? "PLAYING"
          : runtime.audio_transport,
      );
      return { accepted: true, changes: ["media"] };
    // STOP ends the visual channel only. A backing track deliberately survives
    // it, because a visual cue ending is not a reason to silence the hall.
    case "STOP_MEDIA":
      runtimeUpdate(
        sql,
        show.id,
        "active_visual_cue_id = NULL, visual_transport = 'STOPPED'",
      );
      return { accepted: true, changes: ["media"] };
    // STOP ALL is the panic control: every transport ends and the projector
    // returns to its display-mode graphics. It is always available.
    case "STOP_ALL_MEDIA":
      // Stops every transport. It deliberately leaves the blackout override
      // exactly as the operator set it.
      runtimeUpdate(
        sql,
        show.id,
        `active_visual_cue_id = NULL, active_audio_cue_id = NULL,
         visual_transport = 'STOPPED', audio_transport = 'STOPPED'`,
      );
      return { accepted: true, changes: ["media"] };
    // REPLAY is the emergency backing-audio action: one press restarts the
    // current track from the beginning without disturbing the visual channel.
    case "REPLAY_MEDIA":
      if (!runtime.active_audio_cue_id) {
        return {
          accepted: false,
          reason: "There is no backing audio to replay",
          changes: [],
        };
      }
      runtimeUpdate(sql, show.id, "audio_transport = 'PLAYING'");
      return { accepted: true, changes: ["media"] };
    case "RESTART_MEDIA":
      if (!runtime.active_visual_cue_id && !runtime.active_audio_cue_id) {
        return {
          accepted: false,
          reason: "There is no active media to restart",
          changes: [],
        };
      }
      runtimeUpdate(
        sql,
        show.id,
        "visual_transport = ?, audio_transport = ?",
        runtime.active_visual_cue_id ? "PLAYING" : runtime.visual_transport,
        runtime.active_audio_cue_id ? "PLAYING" : runtime.audio_transport,
      );
      return { accepted: true, changes: ["media"] };
    case "SEEK_MEDIA":
      if (!runtime.active_audio_cue_id) {
        return {
          accepted: false,
          reason: "There is no active audio transport to seek",
          changes: [],
        };
      }
      return { accepted: true, changes: ["media"] };
    case "NEXT_CUE":
    case "PREVIOUS_CUE": {
      if (!activeActId)
        return {
          accepted: false,
          reason: "Select an act before selecting a cue",
          changes: [],
        };
      const selected = runtime.prepared_cue_id
        ? sql
            .exec<{ id: string }>(
              `SELECT id FROM cues WHERE show_id = ? AND act_id = ? AND position ${command.type === "NEXT_CUE" ? ">" : "<"} (SELECT position FROM cues WHERE show_id = ? AND id = ?) ORDER BY position ${command.type === "NEXT_CUE" ? "ASC" : "DESC"} LIMIT 1`,
              show.id,
              activeActId,
              show.id,
              runtime.prepared_cue_id,
            )
            .toArray()[0]
        : sql
            .exec<{ id: string }>(
              `SELECT id FROM cues WHERE show_id = ? AND act_id = ? ORDER BY position ${command.type === "NEXT_CUE" ? "ASC" : "DESC"} LIMIT 1`,
              show.id,
              activeActId,
            )
            .toArray()[0];
      if (!selected)
        return {
          accepted: false,
          reason: `There is no ${command.type === "NEXT_CUE" ? "next" : "previous"} cue`,
          changes: [],
        };
      runtimeUpdate(sql, show.id, "prepared_cue_id = ?", selected.id);
      return { accepted: true, changes: ["media"] };
    }
    // Black screen toggles so the operator can return to the graphics with the
    // same control, and it never touches the audio transport.
    case "BLACK_SCREEN":
      runtimeUpdate(
        sql,
        show.id,
        "black_screen = ?",
        runtime.black_screen === 1 ? 0 : 1,
      );
      return { accepted: true, changes: ["media"] };
  }
}

/**
 * The only mutator for operator intents. It checks authority, revision and
 * idempotency before writing one transactionally consistent state transition.
 */
export function executeAdminCommand(
  storage: DurableObjectStorage,
  showIdentifier: string,
  actor: ConnectionRole,
  rawCommand: unknown,
): CommandExecutionResult {
  const parsed = parseAdminCommand(rawCommand);
  const preflightRevision =
    loadShow(storage.sql, showIdentifier)?.revision ?? 0;
  if (!parsed.ok) {
    return {
      acknowledgement: result(
        parsed.commandId,
        "invalid",
        preflightRevision,
        parsed.reason,
      ),
      changes: [],
    };
  }
  if (actor.kind !== "admin") {
    return {
      acknowledgement: result(
        parsed.command.commandId,
        "unauthorised",
        preflightRevision,
      ),
      changes: [],
    };
  }

  return storage.transactionSync(() => {
    const show = loadShow(storage.sql, showIdentifier);
    if (!show) {
      return {
        acknowledgement: result(
          parsed.command.commandId,
          "rejected",
          0,
          "Show does not exist",
        ),
        changes: [],
      };
    }
    const runtime = ensureRuntime(storage.sql, show.id);
    const fingerprint = commandFingerprint(parsed.command);
    const existing = storage.sql
      .exec<{ outcome_json: string; request_fingerprint: string }>(
        `SELECT outcome_json, request_fingerprint FROM command_log
         WHERE show_id = ? AND command_id = ?`,
        show.id,
        parsed.command.commandId,
      )
      .toArray()[0];
    if (existing) {
      if (existing.request_fingerprint !== fingerprint) {
        return {
          acknowledgement: result(
            parsed.command.commandId,
            "conflict",
            show.revision,
            "Command ID was already used for a different command",
          ),
          changes: [],
        };
      }
      return {
        acknowledgement: parseStoredAcknowledgement(existing.outcome_json),
        changes: [],
      };
    }
    if (Number(parsed.command.expectedRevision) !== show.revision) {
      const acknowledgement = result(
        parsed.command.commandId,
        "stale",
        show.revision,
        "Expected revision does not match authoritative state",
      );
      recordCommand(storage.sql, show.id, parsed.command, acknowledgement);
      return { acknowledgement, changes: [] };
    }

    const transition = executeTransition(
      storage.sql,
      show,
      runtime,
      parsed.command,
    );
    const revision = transition.accepted
      ? bumpRevision(storage.sql, show)
      : show.revision;
    const acknowledgement = result(
      parsed.command.commandId,
      transition.accepted ? "accepted" : "rejected",
      revision,
      transition.reason,
    );
    recordCommand(storage.sql, show.id, parsed.command, acknowledgement);
    return { acknowledgement, changes: transition.changes };
  });
}

function loadCues(
  sql: SqlStorage,
  showIdentifier: string,
  actIdentifier: string,
): PersistedCue[] {
  return sql
    .exec<CueRow>(
      `SELECT id, act_id, position, origin, visual_kind, visual_source_key, visual_title,
              audio_kind, audio_source_key, duration_ms, operator_label, operations_json, internal_note
       FROM cues WHERE show_id = ? AND act_id = ? ORDER BY position`,
      showIdentifier,
      actIdentifier,
    )
    .toArray()
    .map((row) => toCue(sql, showIdentifier, row));
}

/**
 * Removes operator labels and backstage notes before a cue reaches the hall.
 * The safe operation list is required for transient SEEK and REPLAY actions.
 */
function toProjectorCue(cue: PersistedCue): ProjectorCue {
  return {
    id: cue.id,
    showId: cue.showId,
    actId: cue.actId,
    position: cue.position,
    origin: cue.origin,
    visual: cue.visual,
    audio: cue.audio,
    durationMs: cue.durationMs,
    operations: cue.operations,
  };
}

function parsedFromRow(
  classification: string,
  finiteValue: number | null,
): ParsedJudgeScore {
  return classification === "FINITE"
    ? { classification: "FINITE", finiteValue: finiteValue ?? 0 }
    : classification === "POSITIVE_INFINITY"
      ? { classification: "POSITIVE_INFINITY", finiteValue: null }
      : { classification: "NEGATIVE_INFINITY", finiteValue: null };
}

/** Every active judge with their submission for the current act, if any. */
function loadJudgeStates(
  sql: SqlStorage,
  show: ShowRow,
  runtime: RuntimeRow,
): AdminJudgeState[] {
  return sql
    .exec<JudgeSubmissionRow>(
      `SELECT j.id, j.slot, j.display_name, s.raw_input, s.parsed_classification,
              s.finite_value, s.effective_score, s.submitted_at
       FROM show_judges j LEFT JOIN show_judge_submissions s
         ON s.show_id = j.show_id AND s.judge_id = j.id AND s.act_id = ?
       WHERE j.show_id = ? AND j.active = 1 ORDER BY j.slot`,
      show.active_act_id ?? "",
      show.id,
    )
    .toArray()
    .map((judge): AdminJudgeState => ({
      id: judgeId(judge.id),
      slot: judge.slot,
      displayName: judge.display_name,
      permission: permissionForJudge(sql, show, runtime, judge.id),
      submission:
        judge.raw_input !== null &&
        judge.parsed_classification !== null &&
        judge.effective_score !== null &&
        judge.submitted_at !== null
          ? {
              showId: showId(show.id),
              actId: actId(show.active_act_id ?? ""),
              judgeId: judgeId(judge.id),
              input: { raw: judge.raw_input },
              parsed: parsedFromRow(
                judge.parsed_classification,
                judge.finite_value,
              ),
              effectiveScore: judge.effective_score,
              submittedAt: judge.submitted_at,
            }
          : null,
    }));
}

function loadAggregate(
  sql: SqlStorage,
  show: ShowRow,
  actIdentifier: string,
): AudienceAggregate | null {
  const row = sql
    .exec<AggregateRow>(
      `SELECT act_id, vote_count, weighted_sum, total_weight, weighted_mean
       FROM audience_aggregates WHERE show_id = ? AND act_id = ?`,
      show.id,
      actIdentifier,
    )
    .toArray()[0];
  return row
    ? {
        showId: showId(show.id),
        actId: actId(row.act_id),
        voteCount: row.vote_count,
        weightedSum: row.weighted_sum,
        totalWeight: row.total_weight,
        weightedMean: row.weighted_mean,
      }
    : null;
}

function permissionForJudge(
  sql: SqlStorage,
  show: ShowRow,
  runtime: RuntimeRow,
  requestedJudgeId: string,
): JudgePermissionState {
  if (!show.active_act_id) {
    return "CLOSED";
  }
  if (judgeHasSubmitted(sql, show.id, show.active_act_id, requestedJudgeId)) {
    return "CLOSED";
  }
  const row = sql
    .exec<{ permission_state: string }>(
      `SELECT permission_state FROM show_judge_permissions
       WHERE show_id = ? AND act_id = ? AND judge_id = ?`,
      show.id,
      show.active_act_id,
      requestedJudgeId,
    )
    .toArray()[0];
  return row
    ? asJudgePermission(row.permission_state)
    : asJudgePermission(runtime.global_judge_permission);
}

/** Builds a role-specific view. Private fields never cross this boundary. */
export function projectShowState(
  storage: DurableObjectStorage,
  showIdentifier: string,
  role: ConnectionRole,
  options: ProjectionOptions = { publicOrigin: null },
): ClientProjection | null {
  const show = loadShow(storage.sql, showIdentifier);
  if (!show) {
    return null;
  }
  const runtime = ensureRuntime(storage.sql, show.id);
  const persisted = persistedShow(show);
  const active = activeAct(storage.sql, show);
  const publicActive = active ? toPublicAct(active) : null;
  const revealed = persisted.resultRevealState === "REVEALED";

  if (role.kind === "audience") {
    const projection: AudienceShowProjection = {
      role: "audience",
      show: {
        title: persisted.title,
        shortName: persisted.shortName,
        themeId: persisted.themeId,
        fontFamily: persisted.fontFamily,
        reactionsEnabled: persisted.reactionsEnabled,
        intermissionMessage: persisted.intermissionMessage,
        emergencyMessage: persisted.emergencyMessage,
        displayMode: persisted.displayMode,
        activeActId: persisted.activeActId,
        audienceVoteState: persisted.audienceVoteState,
        revision: persisted.revision,
      },
      activeAct: active ? toAudienceAct(active) : null,
      revealedResult: revealedFinalScore(
        storage.sql,
        show.id,
        show.active_act_id,
        revealed,
      ),
      publicResults: loadPublicResults(
        storage.sql,
        show.id,
        requireResultsStage(runtime.results_stage),
        runtime.results_revealed_groups,
      ),
    };
    return projection;
  }

  if (role.kind === "projector") {
    const projection: ProjectorShowProjection = {
      role: "projector",
      show: {
        title: persisted.title,
        tagline: persisted.tagline,
        shortName: persisted.shortName,
        themeId: persisted.themeId,
        fontFamily: persisted.fontFamily,
        reactionsEnabled: persisted.reactionsEnabled,
        intermissionMessage: persisted.intermissionMessage,
        emergencyMessage: persisted.emergencyMessage,
        displayMode: persisted.displayMode,
        activeActId: persisted.activeActId,
        revision: persisted.revision,
      },
      activeAct: publicActive,
      activeCues: active
        ? loadCues(storage.sql, show.id, active.id).map(toProjectorCue)
        : [],
      runtime: {
        preparedCueId: runtime.prepared_cue_id
          ? cueId(runtime.prepared_cue_id)
          : null,
        activeVisualCueId: runtime.active_visual_cue_id
          ? cueId(runtime.active_visual_cue_id)
          : null,
        activeAudioCueId: runtime.active_audio_cue_id
          ? cueId(runtime.active_audio_cue_id)
          : null,
        visualTransport: requireTransportState(runtime.visual_transport),
        audioTransport: requireTransportState(runtime.audio_transport),
        blackScreen: runtime.black_screen === 1,
        emergencyPresentation: requireEmergencyPresentation(
          runtime.emergency_presentation,
        ),
      },
      // Judge tiles carry the raw text and the tapered score; the final number
      // is withheld until revealed, so it is never in projector state early.
      scoreboard: {
        audience: active ? loadAggregate(storage.sql, show, active.id) : null,
        judges: loadJudgeStates(storage.sql, show, runtime).map((judge) => ({
          slot: judge.slot,
          displayName: judge.displayName,
          submission: judge.submission
            ? {
                raw: judge.submission.input.raw,
                parsed: judge.submission.parsed,
                effectiveScore: judge.submission.effectiveScore,
              }
            : null,
        })),
      },
      revealedResult: revealedFinalScore(
        storage.sql,
        show.id,
        show.active_act_id,
        revealed,
      ),
      publicResults: loadPublicResults(
        storage.sql,
        show.id,
        requireResultsStage(runtime.results_stage),
        runtime.results_revealed_groups,
      ),
      joinUrl: options.publicOrigin
        ? audienceJoinUrl(options.publicOrigin)
        : null,
      mediaManifest: listReferencedAssets(storage.sql, show.id),
    };
    return projection;
  }

  if (role.kind === "judge") {
    if (!judgeExists(storage.sql, show.id, role.judgeId)) {
      return null;
    }
    const submission = show.active_act_id
      ? (storage.sql
          .exec<{
            raw_input: string;
            parsed_classification: string;
            finite_value: number | null;
            effective_score: number;
            submitted_at: string;
          }>(
            `SELECT raw_input, parsed_classification, finite_value, effective_score, submitted_at
             FROM show_judge_submissions WHERE show_id = ? AND act_id = ? AND judge_id = ?`,
            show.id,
            show.active_act_id,
            role.judgeId,
          )
          .toArray()[0] ?? null)
      : null;
    const projection: JudgeShowProjection = {
      role: "judge",
      show: {
        title: persisted.title,
        shortName: persisted.shortName,
        themeId: persisted.themeId,
        fontFamily: persisted.fontFamily,
        activeActId: persisted.activeActId,
        revision: persisted.revision,
      },
      activeAct: publicActive,
      permission: permissionForJudge(storage.sql, show, runtime, role.judgeId),
      submission: submission
        ? {
            showId: showId(show.id),
            actId: actId(show.active_act_id ?? ""),
            judgeId: judgeId(role.judgeId),
            input: { raw: submission.raw_input },
            parsed: parsedFromRow(
              submission.parsed_classification,
              submission.finite_value,
            ),
            effectiveScore: submission.effective_score,
            submittedAt: submission.submitted_at,
          }
        : null,
    };
    return projection;
  }

  const acts = storage.sql
    .exec<ActRow>(
      `SELECT ${ACT_COLUMNS} FROM acts WHERE show_id = ? ORDER BY order_index`,
      show.id,
    )
    .toArray()
    .map((row) => ({
      ...toPublicAct(row),
      internalNotes: row.internal_notes,
      showDescriptionToAudience: row.show_description_to_audience === 1,
      showImageToAudience: row.show_image_to_audience === 1,
      presentation: toActPresentation(row),
      cues: loadCues(storage.sql, show.id, row.id),
    }));
  const aggregates: AudienceAggregate[] = storage.sql
    .exec<AggregateRow>(
      `SELECT act_id, vote_count, weighted_sum, total_weight, weighted_mean
       FROM audience_aggregates WHERE show_id = ?`,
      show.id,
    )
    .toArray()
    .map((row) => ({
      showId: showId(show.id),
      actId: actId(row.act_id),
      voteCount: row.vote_count,
      weightedSum: row.weighted_sum,
      totalWeight: row.total_weight,
      weightedMean: row.weighted_mean,
    }));
  const projection: AdminShowProjection = {
    role: "admin",
    show: persisted,
    acts,
    audienceAggregates: aggregates,
    runtime: runtimeState(show.id, runtime),
    results: Object.fromEntries(
      acts.map((act) => [
        act.id,
        operationalResult(storage.sql, show.id, act.id),
      ]),
    ),
    judges: loadJudgeStates(storage.sql, show, runtime),
    ranking: loadRanking(storage.sql, show.id),
  };
  return projection;
}
