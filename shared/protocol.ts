import type {
  AdminCommand,
  AdminCommandAcknowledgement,
} from "./admin-command";
import { parseAdminCommand } from "./admin-command";
import {
  commandId,
  isAudienceScore,
  PROTOCOL_VERSION,
  showRevision,
  type AudienceAggregate,
  type AudienceScore,
  type AudienceVoteState,
  type ClientProjection,
  type CommandId,
  type CueId,
  type JudgePermissionState,
  type JudgeRawInput,
  type ProtocolVersion,
  type PublicAct,
  type ResultRevealState,
  type ShowRevision,
} from "./domain";
import { isJudgeRawInput, isRecord } from "./trust";

export interface ProtocolEnvelope {
  protocolVersion: ProtocolVersion;
}

export interface RevisionedServerMessage extends ProtocolEnvelope {
  revision: ShowRevision;
}

export type RequestedConnectionRole =
  "admin" | "projector" | "audience" | "judge";

export interface ClientHello extends ProtocolEnvelope {
  type: "hello";
  requestedRole: RequestedConnectionRole;
  /** Required for fail-closed admin/projector roles and private judge links. */
  credential?: string;
}

export interface AdminCommandMessage extends ProtocolEnvelope {
  type: "admin_command";
  command: AdminCommand;
}

export interface AudienceVoteMessage extends ProtocolEnvelope {
  type: "audience_vote";
  commandId: CommandId;
  score: AudienceScore;
}

export interface JudgeSubmitMessage extends ProtocolEnvelope {
  type: "judge_submit";
  commandId: CommandId;
  input: JudgeRawInput;
}

export interface ProjectorAcknowledgement extends ProtocolEnvelope {
  type: "projector_ack";
  commandId: CommandId;
  succeeded: boolean;
  detail?: string;
}

export interface ResyncRequest extends ProtocolEnvelope {
  type: "resync_request";
  lastRevision: ShowRevision;
}

export type ClientMessage =
  | ClientHello
  | AdminCommandMessage
  | AudienceVoteMessage
  | JudgeSubmitMessage
  | ProjectorAcknowledgement
  | ResyncRequest;

export interface SnapshotMessage extends RevisionedServerMessage {
  type: "snapshot";
  projection: ClientProjection;
}

export type ShowStatePatch =
  | {
      kind: "active_act";
      activeActId: string | null;
      activeAct: PublicAct | null;
    }
  | { kind: "display"; displayMode: string; blackScreen: boolean }
  | {
      kind: "media";
      preparedCueId: CueId | null;
      activeVisualCueId: CueId | null;
      activeAudioCueId: CueId | null;
      visualTransport: string;
      audioTransport: string;
      blackScreen: boolean;
    }
  | { kind: "result_reveal"; state: ResultRevealState };

export interface StatePatchMessage extends RevisionedServerMessage {
  type: "state_patch";
  patches: readonly ShowStatePatch[];
}

export interface AggregateUpdateMessage extends RevisionedServerMessage {
  type: "aggregate_update";
  aggregate: AudienceAggregate;
}

export interface VotingStateUpdateMessage extends RevisionedServerMessage {
  type: "voting_state_update";
  state: AudienceVoteState;
}

export interface JudgePermissionUpdateMessage extends RevisionedServerMessage {
  type: "judge_permission_update";
  state: JudgePermissionState;
}

export interface JudgeSubmissionUpdateMessage extends RevisionedServerMessage {
  type: "judge_submission_update";
  accepted: boolean;
  locked: boolean;
  reason?: "VOTING_CLOSED" | "WRONG_ACT" | "INVALID_SCORE" | "TOO_LONG";
}

export interface MediaCommandMessage extends RevisionedServerMessage {
  type: "media_command";
  executionId: CommandId;
  commandId: CommandId;
  action:
    | "prepare"
    | "play"
    | "pause"
    | "resume"
    | "stop"
    | "restart"
    | "replay"
    | "seek"
    | "next"
    | "previous"
    | "black";
  cueId: CueId | null;
  positionMs?: number;
}

export interface ResultRevealMessage extends RevisionedServerMessage {
  type: "result_reveal";
  state: ResultRevealState;
}

export interface CommandAcknowledgementMessage extends RevisionedServerMessage {
  type: "command_ack";
  acknowledgement: AdminCommandAcknowledgement;
}

export interface ProjectorAcknowledgementMessage extends RevisionedServerMessage {
  type: "projector_acknowledgement";
  commandId: CommandId;
  succeeded: boolean;
  detail?: string;
}

export interface ConnectionCountMessage extends RevisionedServerMessage {
  type: "connection_count";
  audience: number;
  judgeIds: readonly string[];
}

export interface ProtocolErrorMessage extends RevisionedServerMessage {
  type: "protocol_error";
  code:
    | "invalid_message"
    | "unauthorised"
    | "incompatible_protocol"
    | "unsupported_action";
  detail: string;
}

export interface ForceResyncMessage extends RevisionedServerMessage {
  type: "force_resync";
  reason: "revision_gap" | "server_restart" | "role_changed";
}

export type ServerMessage =
  | SnapshotMessage
  | StatePatchMessage
  | AggregateUpdateMessage
  | VotingStateUpdateMessage
  | JudgePermissionUpdateMessage
  | JudgeSubmissionUpdateMessage
  | MediaCommandMessage
  | ResultRevealMessage
  | CommandAcknowledgementMessage
  | ProjectorAcknowledgementMessage
  | ConnectionCountMessage
  | ProtocolErrorMessage
  | ForceResyncMessage;

export type ClientMessageParseResult =
  { ok: true; message: ClientMessage } | { ok: false; reason: string };

export type ServerMessageParseResult =
  | { ok: true; message: ServerMessage }
  | { ok: false; reason: string; incompatible: boolean };

const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;

function parseCommandIdentifier(value: unknown): CommandId | null {
  return typeof value === "string" && IDENTIFIER.test(value)
    ? commandId(value)
    : null;
}

function parseObjectPayload(payload: string | ArrayBuffer): unknown {
  if (typeof payload !== "string") {
    return null;
  }
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
}

/** Parses compact untrusted WebSocket JSON into the single client-message union. */
export function parseClientMessage(
  payload: string | ArrayBuffer,
): ClientMessageParseResult {
  const value = parseObjectPayload(payload);
  if (
    !isRecord(value) ||
    value.protocolVersion !== PROTOCOL_VERSION ||
    typeof value.type !== "string"
  ) {
    return { ok: false, reason: "Malformed or incompatible protocol message" };
  }

  switch (value.type) {
    case "hello":
      return typeof value.requestedRole === "string" &&
        ["admin", "projector", "audience", "judge"].includes(
          value.requestedRole,
        ) &&
        (value.credential === undefined || typeof value.credential === "string")
        ? {
            ok: true,
            message: {
              type: "hello",
              protocolVersion: PROTOCOL_VERSION,
              requestedRole: value.requestedRole as RequestedConnectionRole,
              ...(typeof value.credential === "string"
                ? { credential: value.credential }
                : {}),
            },
          }
        : { ok: false, reason: "Invalid connection hello" };
    case "admin_command": {
      const parsedCommand = parseAdminCommand(value.command);
      return parsedCommand.ok
        ? {
            ok: true,
            message: {
              type: "admin_command",
              protocolVersion: PROTOCOL_VERSION,
              command: parsedCommand.command,
            },
          }
        : { ok: false, reason: parsedCommand.reason };
    }
    case "audience_vote": {
      const voteCommandId = parseCommandIdentifier(value.commandId);
      return voteCommandId && isAudienceScore(value.score)
        ? {
            ok: true,
            message: {
              type: "audience_vote",
              protocolVersion: PROTOCOL_VERSION,
              commandId: voteCommandId,
              score: value.score,
            },
          }
        : { ok: false, reason: "Invalid audience vote" };
    }
    case "judge_submit": {
      const submitCommandId = parseCommandIdentifier(value.commandId);
      return submitCommandId && isJudgeRawInput(value.input)
        ? {
            ok: true,
            message: {
              type: "judge_submit",
              protocolVersion: PROTOCOL_VERSION,
              commandId: submitCommandId,
              input: value.input,
            },
          }
        : { ok: false, reason: "Invalid judge submission" };
    }
    case "projector_ack": {
      const acknowledgementCommandId = parseCommandIdentifier(value.commandId);
      return acknowledgementCommandId &&
        typeof value.succeeded === "boolean" &&
        (value.detail === undefined || typeof value.detail === "string")
        ? {
            ok: true,
            message: {
              type: "projector_ack",
              protocolVersion: PROTOCOL_VERSION,
              commandId: acknowledgementCommandId,
              succeeded: value.succeeded,
              ...(typeof value.detail === "string"
                ? { detail: value.detail }
                : {}),
            },
          }
        : { ok: false, reason: "Invalid projector acknowledgement" };
    }
    case "resync_request":
      return typeof value.lastRevision === "number" &&
        Number.isSafeInteger(value.lastRevision) &&
        value.lastRevision >= 0
        ? {
            ok: true,
            message: {
              type: "resync_request",
              protocolVersion: PROTOCOL_VERSION,
              lastRevision: showRevision(value.lastRevision),
            },
          }
        : { ok: false, reason: "Invalid resync request" };
    default:
      return { ok: false, reason: "Unknown protocol message" };
  }
}

export function serialiseServerMessage(message: ServerMessage): string {
  return JSON.stringify(message);
}

/**
 * Server messages are generated by this application, but clients still parse
 * defensively so a stale deployment cannot corrupt local synchronisation.
 */
export function parseServerMessage(payload: string): ServerMessageParseResult {
  let value: unknown;
  try {
    value = JSON.parse(payload) as unknown;
  } catch {
    return {
      ok: false,
      reason: "Server sent invalid JSON",
      incompatible: false,
    };
  }
  if (!isRecord(value) || typeof value.protocolVersion !== "number") {
    return {
      ok: false,
      reason: "Server message lacks protocol version",
      incompatible: false,
    };
  }
  if (value.protocolVersion !== PROTOCOL_VERSION) {
    return {
      ok: false,
      reason: "Server protocol is incompatible",
      incompatible: true,
    };
  }
  if (
    typeof value.type !== "string" ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0
  ) {
    return {
      ok: false,
      reason: "Server message is malformed",
      incompatible: false,
    };
  }

  // Protocol messages are serialised only from the typed Worker union. The
  // structural checks above protect the transport boundary; per-type handling
  // is intentionally local to the consumer to avoid a second schema hierarchy.
  return { ok: true, message: value as unknown as ServerMessage };
}
