import type { AdminCommand } from "../shared/admin-command";
import type { AdminCommandAcknowledgement } from "../shared/admin-command";
import type { AuditEvent } from "../shared/domain";

export type AuditData = Readonly<
  Record<string, string | number | boolean | null>
>;

export interface AuditInput {
  type: string;
  actor: AuditEvent["actor"];
  commandId?: string | null;
  data?: AuditData;
}

const MAX_PAGE = 100;
/** Vote counts worth a line in the log; everything in between is noise. */
const VOTE_MILESTONES = new Set([1, 10, 25, 50, 100, 250, 500, 1000]);

interface AuditRow extends Record<string, SqlStorageValue> {
  id: number;
  command_id: string | null;
  actor_role: string;
  event_type: string;
  event_json: string;
  occurred_at: string;
}

/**
 * Appends one event. The log is operational history, not a transaction log:
 * a failure to write it must never fail the operation it describes, so it is
 * best-effort and swallows its own errors (a missing show row, for instance).
 */
export function recordAuditEvent(
  sql: SqlStorage,
  showIdentifier: string,
  event: AuditInput,
): void {
  try {
    sql.exec(
      `INSERT INTO audit_events (
        show_id, command_id, actor_role, event_type, event_json, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      showIdentifier,
      event.commandId ?? null,
      event.actor,
      event.type,
      JSON.stringify(event.data ?? {}),
      new Date().toISOString(),
    );
  } catch {
    // Deliberately ignored; see above.
  }
}

export function isVoteMilestone(count: number): boolean {
  return VOTE_MILESTONES.has(count) || (count > 1000 && count % 500 === 0);
}

/**
 * Translates an operator command and its outcome into the one event worth
 * keeping. Accepted commands log what changed; refused ones log why, because
 * "why did nothing happen?" is the second most common question after a show.
 */
export function auditEventForCommand(
  command: AdminCommand,
  acknowledgement: AdminCommandAcknowledgement,
): AuditInput {
  const base = { actor: "admin" as const, commandId: command.commandId };
  if (acknowledgement.status !== "accepted") {
    return {
      ...base,
      type: "command.refused",
      data: {
        command: command.type,
        status: acknowledgement.status,
        reason: acknowledgement.reason ?? null,
      },
    };
  }
  switch (command.type) {
    case "SELECT_ACT":
      return { ...base, type: "act.selected", data: { actId: command.actId } };
    case "NEXT_ACT":
    case "PREVIOUS_ACT":
      return {
        ...base,
        type: "act.selected",
        data: { direction: command.type === "NEXT_ACT" ? "next" : "previous" },
      };
    case "WITHDRAW_ACT":
      return { ...base, type: "act.withdrawn", data: { actId: command.actId } };
    case "REINSTATE_ACT":
      return {
        ...base,
        type: "act.reinstated",
        data: { actId: command.actId },
      };
    case "SET_DISPLAY_MODE":
      return command.mode === "EMERGENCY"
        ? { ...base, type: "emergency.activated", data: { presentation: null } }
        : { ...base, type: "display.changed", data: { mode: command.mode } };
    case "ADVANCE_SHOW":
      return { ...base, type: "flow.advanced", data: {} };
    case "SET_SHOW_STEP":
      return { ...base, type: "flow.step", data: { step: command.step } };
    case "ACTIVATE_EMERGENCY":
      return {
        ...base,
        type: "emergency.activated",
        data: { presentation: command.presentation },
      };
    case "RESTORE_DISPLAY":
      return { ...base, type: "display.restored", data: {} };
    case "OPEN_AUDIENCE_VOTING":
      return { ...base, type: "voting.opened", data: {} };
    case "CLOSE_AUDIENCE_VOTING":
      return { ...base, type: "voting.closed", data: {} };
    case "OPEN_ALL_JUDGES":
    case "CLOSE_ALL_JUDGES":
      return {
        ...base,
        type: "judges.permission",
        data: {
          scope: "all",
          state: command.type === "OPEN_ALL_JUDGES" ? "OPEN" : "CLOSED",
        },
      };
    case "OPEN_JUDGE":
    case "CLOSE_JUDGE":
      return {
        ...base,
        type: "judges.permission",
        data: {
          scope: "one",
          judgeId: command.judgeId,
          state: command.type === "OPEN_JUDGE" ? "OPEN" : "CLOSED",
        },
      };
    case "FINALISE_RESULT":
      return { ...base, type: "result.finalised", data: {} };
    case "REVEAL_RESULT":
      return { ...base, type: "result.revealed", data: {} };
    case "HIDE_RESULT":
      return { ...base, type: "result.hidden", data: {} };
    case "SET_RESULTS_STAGE":
      return {
        ...base,
        type: "results.stage",
        data: { stage: command.stage },
      };
    case "REVEAL_NEXT_RESULT":
      return { ...base, type: "results.revealed_next", data: {} };
    case "RESET_RESULTS_REVEAL":
      return { ...base, type: "results.reset", data: {} };
    case "SET_INTERMISSION_MESSAGE":
    case "SET_EMERGENCY_MESSAGE":
      return {
        ...base,
        type: "message.updated",
        data: {
          which:
            command.type === "SET_INTERMISSION_MESSAGE"
              ? "intermission"
              : "emergency",
          length: command.text.length,
        },
      };
    case "PREPARE_CUE":
    case "NEXT_CUE":
    case "PREVIOUS_CUE":
      return {
        ...base,
        type: "cue.prepared",
        data: {
          cueId: command.type === "PREPARE_CUE" ? command.cueId : null,
          via: command.type,
        },
      };
    case "PLAY_CUE":
      return {
        ...base,
        type: "cue.played",
        data: { cueId: command.cueId ?? null },
      };
    case "PAUSE_MEDIA":
    case "RESUME_MEDIA":
    case "STOP_MEDIA":
    case "STOP_ALL_MEDIA":
    case "RESTART_MEDIA":
    case "REPLAY_MEDIA":
    case "BLACK_SCREEN":
      return {
        ...base,
        type: "media.transport",
        data: { action: command.type },
      };
    case "SEEK_MEDIA":
      return {
        ...base,
        type: "media.transport",
        data: { action: command.type, positionMs: command.positionMs },
      };
  }
}

function toEvent(row: AuditRow): AuditEvent {
  let data: AuditData = {};
  try {
    const parsed: unknown = JSON.parse(row.event_json);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
      data = parsed as AuditData;
  } catch {
    // An unreadable payload still leaves the event visible by type and time.
  }
  return {
    id: row.id,
    at: row.occurred_at,
    type: row.event_type,
    actor: row.actor_role as AuditEvent["actor"],
    commandId: row.command_id,
    data,
  };
}

/** Newest first, bounded, keyed by ID so paging is stable while events arrive. */
export function listAuditEvents(
  sql: SqlStorage,
  showIdentifier: string,
  beforeId: number | null,
  limit: number,
): { events: AuditEvent[]; nextBefore: number | null } {
  const page = Math.min(Math.max(limit, 1), MAX_PAGE);
  const rows = (
    beforeId === null
      ? sql.exec<AuditRow>(
          `SELECT id, command_id, actor_role, event_type, event_json, occurred_at
           FROM audit_events WHERE show_id = ? ORDER BY id DESC LIMIT ?`,
          showIdentifier,
          page + 1,
        )
      : sql.exec<AuditRow>(
          `SELECT id, command_id, actor_role, event_type, event_json, occurred_at
           FROM audit_events WHERE show_id = ? AND id < ? ORDER BY id DESC LIMIT ?`,
          showIdentifier,
          beforeId,
          page + 1,
        )
  ).toArray();
  const events = rows.slice(0, page).map(toEvent);
  return {
    events,
    nextBefore: rows.length > page ? (events.at(-1)?.id ?? null) : null,
  };
}
