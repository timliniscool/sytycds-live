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
  type AudienceAggregate,
  type AudienceShowProjection,
  type ClientProjection,
  type ConnectionRole,
  type DisplayMode,
  type JudgePermissionState,
  type JudgeShowProjection,
  type MediaTransportState,
  type PersistedCue,
  type PersistedShow,
  type ProjectorShowProjection,
  type PublicAct,
  type ShowRuntimeState,
  type AudioCueKind,
  type CueOperation,
  type VisualCueKind,
} from "../shared/domain";
import {
  finaliseResult,
  operationalResult,
  revealedFinalScore,
} from "./results";

export const PRIMARY_SHOW_ID = showId("primary");

export type StateChange =
  | "act"
  | "display"
  | "audience_voting"
  | "judge_permission"
  | "result_reveal"
  | "media";

export interface CommandExecutionResult {
  acknowledgement: AdminCommandAcknowledgement;
  changes: readonly StateChange[];
}

interface ShowRow extends Record<string, SqlStorageValue> {
  id: string;
  title: string;
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
}

interface CueRow extends Record<string, SqlStorageValue> {
  id: string;
  act_id: string;
  position: number;
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
        `SELECT id, title, display_mode, audience_vote_state, result_reveal_state,
                active_act_id, revision
         FROM shows WHERE id = ?`,
        id,
      )
      .toArray()[0] ?? null
  );
}

function ensureRuntime(sql: SqlStorage, id: string): RuntimeRow {
  sql.exec(
    `INSERT OR IGNORE INTO show_runtime (
      show_id, previous_display_mode, global_judge_permission, prepared_cue_id,
      active_visual_cue_id, active_audio_cue_id, visual_transport, audio_transport,
      black_screen, updated_at
    ) VALUES (?, NULL, 'CLOSED', NULL, NULL, NULL, 'STOPPED', 'STOPPED', 0, ?)`,
    id,
    now(),
  );

  const row = sql
    .exec<RuntimeRow>(
      `SELECT previous_display_mode, global_judge_permission, prepared_cue_id,
              active_visual_cue_id, active_audio_cue_id, visual_transport,
              audio_transport, black_screen
       FROM show_runtime WHERE show_id = ?`,
      id,
    )
    .toArray()[0];
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
  };
}

function persistedShow(row: ShowRow): PersistedShow {
  return {
    id: showId(row.id),
    title: row.title,
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
  };
}

function toCue(showIdentifier: string, row: CueRow): PersistedCue {
  let operations: CueOperation[] = [];
  try {
    const candidate: unknown = JSON.parse(row.operations_json);
    if (Array.isArray(candidate)) operations = candidate as CueOperation[];
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
  return {
    id: cueId(row.id),
    showId: showId(showIdentifier),
    actId: actId(row.act_id),
    position: row.position,
    visual: row.visual_kind
      ? {
          kind: row.visual_kind as VisualCueKind,
          sourceKey: row.visual_source_key,
          title: row.visual_title,
        }
      : null,
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
        `SELECT id, order_index, performer_name, school_year, act_name, act_type,
                public_description, internal_notes
         FROM acts WHERE show_id = ? AND id = ?`,
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
        `SELECT id, act_id, position, visual_kind, visual_source_key, visual_title,
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
  sql.exec(
    `INSERT INTO audit_events (
      show_id, command_id, actor_role, event_type, event_json, occurred_at
    ) VALUES (?, ?, 'admin', ?, ?, ?)`,
    showIdentifier,
    command.commandId,
    `admin.${command.type.toLowerCase()}`,
    JSON.stringify({ status: acknowledgement.status }),
    timestamp,
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
  return (
    sql
      .exec<ActRow>(
        `SELECT id, order_index, performer_name, school_year, act_name, act_type,
                public_description, internal_notes
         FROM acts WHERE show_id = ? AND order_index ${comparator} ?
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
        `SELECT 1 AS present FROM judge_submissions
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
        "SELECT 1 AS present FROM judges WHERE show_id = ? AND id = ? AND revoked_at IS NULL",
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
    `INSERT INTO judge_permissions (
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

function executeTransition(
  sql: SqlStorage,
  show: ShowRow,
  runtime: RuntimeRow,
  command: AdminCommand,
): { accepted: boolean; reason?: string; changes: readonly StateChange[] } {
  const activeActId = assertActiveAct(show);
  switch (command.type) {
    case "SELECT_ACT":
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
    case "NEXT_ACT": {
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
      const currentMode = requireDisplayMode(show.display_mode);
      const previousMode = isSafeDisplayMode(currentMode)
        ? currentMode
        : runtime.previous_display_mode;
      if (command.mode === "HOLD" || command.mode === "EMERGENCY") {
        runtimeUpdate(sql, show.id, "previous_display_mode = ?", previousMode);
      }
      sql.exec(
        "UPDATE shows SET display_mode = ? WHERE id = ?",
        command.mode,
        show.id,
      );
      return { accepted: true, changes: ["display"] };
    }
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
          "SELECT id FROM judges WHERE show_id = ? AND revoked_at IS NULL ORDER BY slot",
          show.id,
        )
        .toArray();
      if (judges.length !== 4) {
        return {
          accepted: false,
          reason: "Exactly four active judges are required",
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
          `UPDATE judge_permissions SET permission_state = 'CLOSED', updated_at = ?
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
      runtimeUpdate(
        sql,
        show.id,
        `prepared_cue_id = ?, active_visual_cue_id = ?, active_audio_cue_id = ?,
         visual_transport = ?, audio_transport = ?, black_screen = 0`,
        cue.id,
        cue.visual_kind ? cue.id : null,
        cue.audio_kind ? cue.id : null,
        cue.visual_kind ? "PLAYING" : runtime.visual_transport,
        cue.audio_kind ? "PLAYING" : runtime.audio_transport,
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
    case "STOP_MEDIA":
      runtimeUpdate(
        sql,
        show.id,
        `active_visual_cue_id = NULL, active_audio_cue_id = NULL,
         visual_transport = 'STOPPED', audio_transport = 'STOPPED', black_screen = 0`,
      );
      return { accepted: true, changes: ["media"] };
    case "REPLAY_MEDIA":
      if (!runtime.active_visual_cue_id && !runtime.active_audio_cue_id) {
        return {
          accepted: false,
          reason: "There is no active media to replay",
          changes: [],
        };
      }
      runtimeUpdate(
        sql,
        show.id,
        "visual_transport = ?, audio_transport = ?, black_screen = 0",
        runtime.active_visual_cue_id ? "PLAYING" : "STOPPED",
        runtime.active_audio_cue_id ? "PLAYING" : "STOPPED",
      );
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
        "visual_transport = ?, audio_transport = ?, black_screen = 0",
        runtime.active_visual_cue_id ? "PLAYING" : "STOPPED",
        runtime.active_audio_cue_id ? "PLAYING" : "STOPPED",
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
    case "BLACK_SCREEN":
      runtimeUpdate(sql, show.id, "black_screen = 1");
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
      `SELECT id, act_id, position, visual_kind, visual_source_key, visual_title,
              audio_kind, audio_source_key, duration_ms, operator_label, operations_json, internal_note
       FROM cues WHERE show_id = ? AND act_id = ? ORDER BY position`,
      showIdentifier,
      actIdentifier,
    )
    .toArray()
    .map((row) => toCue(showIdentifier, row));
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
      `SELECT permission_state FROM judge_permissions
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
): ClientProjection | null {
  const show = loadShow(storage.sql, showIdentifier);
  if (!show) {
    return null;
  }
  const runtime = ensureRuntime(storage.sql, show.id);
  const persisted = persistedShow(show);
  const active = activeAct(storage.sql, show);
  const publicActive = active ? toPublicAct(active) : null;

  if (role.kind === "audience") {
    const projection: AudienceShowProjection = {
      role: "audience",
      show: {
        title: persisted.title,
        activeActId: persisted.activeActId,
        audienceVoteState: persisted.audienceVoteState,
        revision: persisted.revision,
      },
      activeAct: publicActive,
      revealedResult: revealedFinalScore(
        storage.sql,
        show.id,
        show.active_act_id,
        persisted.resultRevealState === "REVEALED",
      ),
    };
    return projection;
  }

  if (role.kind === "projector") {
    const projection: ProjectorShowProjection = {
      role: "projector",
      show: {
        title: persisted.title,
        displayMode: persisted.displayMode,
        activeActId: persisted.activeActId,
        revision: persisted.revision,
      },
      activeAct: publicActive,
      activeCues: active ? loadCues(storage.sql, show.id, active.id) : [],
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
      },
      revealedResult: revealedFinalScore(
        storage.sql,
        show.id,
        show.active_act_id,
        persisted.resultRevealState === "REVEALED",
      ),
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
             FROM judge_submissions WHERE show_id = ? AND act_id = ? AND judge_id = ?`,
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
            parsed:
              submission.parsed_classification === "FINITE"
                ? {
                    classification: "FINITE",
                    finiteValue: submission.finite_value ?? 0,
                  }
                : submission.parsed_classification === "POSITIVE_INFINITY"
                  ? { classification: "POSITIVE_INFINITY", finiteValue: null }
                  : { classification: "NEGATIVE_INFINITY", finiteValue: null },
            effectiveScore: submission.effective_score,
            submittedAt: submission.submitted_at,
          }
        : null,
    };
    return projection;
  }

  const acts = storage.sql
    .exec<ActRow>(
      `SELECT id, order_index, performer_name, school_year, act_name, act_type,
              public_description, internal_notes
       FROM acts WHERE show_id = ? ORDER BY order_index`,
      show.id,
    )
    .toArray()
    .map((row) => ({
      ...toPublicAct(row),
      internalNotes: row.internal_notes,
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
  };
  return projection;
}
