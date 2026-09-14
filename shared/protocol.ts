import type {
  AdminCommand,
  AdminCommandAcknowledgement,
} from "./admin-command";
import { parseAdminCommand } from "./admin-command";
import {
  commandId,
  PROTOCOL_VERSION,
  showRevision,
  type AudienceAggregate,
  type AudienceVoteState,
  type ClientProjection,
  type CommandId,
  type CueId,
  type EmergencyPresentation,
  type JudgePermissionState,
  type JudgeRawInput,
  type MediaCacheSummary,
  type MediaPlaybackState,
  type ProtocolVersion,
  type PublicAct,
  type PublicResults,
  type ResultRevealState,
  type ShowRevision,
} from "./domain";
import type {
  PreflightAssetRequest,
  ProjectorPreflightAsset,
  ProjectorPreflightReport,
} from "./preflight";
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

export interface JudgeSubmitMessage extends ProtocolEnvelope {
  type: "judge_submit";
  commandId: CommandId;
  input: JudgeRawInput;
}

/** Ephemeral projector playback telemetry; never persisted, admin-only. */
export interface ProjectorPlaybackStatus {
  visual: MediaPlaybackState;
  audio: MediaPlaybackState;
  positionMs: number | null;
  durationMs: number | null;
  armed: boolean;
  black: boolean;
  error: string | null;
  /** Media held after a reload until the operator resumes or replays. */
  held?: boolean;
  cache?: MediaCacheSummary;
}

export interface ProjectorStatusMessage extends ProtocolEnvelope {
  type: "projector_status";
  status: ProjectorPlaybackStatus;
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

/** Admin asks the coordinator to have the projector probe itself. */
export interface PreflightRequest extends ProtocolEnvelope {
  type: "preflight_request";
  requestId: CommandId;
}

/** The projector's answer, relayed to admin and never persisted. */
export interface ProjectorPreflightMessage extends ProtocolEnvelope {
  type: "projector_preflight";
  requestId: CommandId;
  report: ProjectorPreflightReport;
}

export type ClientMessage =
  | ClientHello
  | AdminCommandMessage
  | JudgeSubmitMessage
  | ProjectorAcknowledgement
  | ProjectorStatusMessage
  | ResyncRequest
  | PreflightRequest
  | ProjectorPreflightMessage;

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
  | {
      kind: "display";
      displayMode: string;
      blackScreen: boolean;
      intermissionMessage: string;
      emergencyMessage: string;
      emergencyPresentation: EmergencyPresentation;
    }
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
    | "stop_all"
    | "restart"
    | "replay"
    | "seek"
    | "next"
    | "previous"
    | "black";
  cueId: CueId | null;
  positionMs?: number;
  /** Authoritative black-screen state, sent with the `black` action only. */
  blackScreen?: boolean;
}

export interface ResultRevealMessage extends RevisionedServerMessage {
  type: "result_reveal";
  state: ResultRevealState;
  /**
   * The revealed final score, projected per role: public roles receive it only
   * once revealed; the operator already holds the result and receives null.
   */
  revealedResult: number | null;
}

/** Public ranking slice for the current results stage; null when hidden. */
export interface PublicResultsMessage extends RevisionedServerMessage {
  type: "public_results";
  results: PublicResults | null;
}

/** Relayed to the projector with the assets the coordinator wants probed. */
export interface PreflightRequestMessage extends RevisionedServerMessage {
  type: "preflight_request";
  requestId: CommandId;
  assets: readonly PreflightAssetRequest[];
}

export interface ProjectorPreflightReportMessage extends RevisionedServerMessage {
  type: "projector_preflight_report";
  requestId: CommandId;
  report: ProjectorPreflightReport;
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

export interface ProjectorTelemetryMessage extends RevisionedServerMessage {
  type: "projector_telemetry";
  status: ProjectorPlaybackStatus;
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
  | PublicResultsMessage
  | PreflightRequestMessage
  | ProjectorPreflightReportMessage
  | CommandAcknowledgementMessage
  | ProjectorAcknowledgementMessage
  | ProjectorTelemetryMessage
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

const PLAYBACK_STATES: ReadonlySet<string> = new Set([
  "IDLE",
  "LOADED",
  "PLAYING",
  "PAUSED",
  "ENDED",
  "ERROR",
]);

function parseMilliseconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

function parseCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/** Cache summaries are small counters; anything malformed drops the summary, not the message. */
function parseMediaCacheSummary(value: unknown): MediaCacheSummary | undefined {
  if (!isRecord(value)) return undefined;
  const files = parseCount(value.files);
  const cached = parseCount(value.cached);
  const failed = parseCount(value.failed);
  const bytes = parseCount(value.bytes);
  const cachedBytes = parseCount(value.cachedBytes);
  if (
    files === null ||
    cached === null ||
    failed === null ||
    bytes === null ||
    cachedBytes === null ||
    (value.persisted !== null && typeof value.persisted !== "boolean") ||
    (value.error !== null && typeof value.error !== "string")
  ) {
    return undefined;
  }
  return {
    files,
    cached,
    failed,
    bytes,
    cachedBytes,
    persisted: value.persisted as boolean | null,
    error: typeof value.error === "string" ? value.error.slice(0, 200) : null,
  };
}

function parseProjectorStatus(value: unknown): ProjectorPlaybackStatus | null {
  if (
    !isRecord(value) ||
    typeof value.visual !== "string" ||
    !PLAYBACK_STATES.has(value.visual) ||
    typeof value.audio !== "string" ||
    !PLAYBACK_STATES.has(value.audio) ||
    typeof value.armed !== "boolean" ||
    typeof value.black !== "boolean"
  ) {
    return null;
  }
  const detail = typeof value.error === "string" ? value.error : null;
  const cache = parseMediaCacheSummary(value.cache);
  return {
    visual: value.visual as MediaPlaybackState,
    audio: value.audio as MediaPlaybackState,
    positionMs: parseMilliseconds(value.positionMs),
    durationMs: parseMilliseconds(value.durationMs),
    armed: value.armed,
    black: value.black,
    error: detail === null ? null : detail.slice(0, 200),
    ...(value.held === true ? { held: true } : {}),
    ...(cache ? { cache } : {}),
  };
}

const MAX_PREFLIGHT_ASSETS = 500;
const ASSET_KINDS: ReadonlySet<string> = new Set(["image", "audio", "video"]);

function parsePreflightAsset(value: unknown): ProjectorPreflightAsset | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !IDENTIFIER.test(value.id) ||
    typeof value.kind !== "string" ||
    !ASSET_KINDS.has(value.kind) ||
    typeof value.ok !== "boolean" ||
    typeof value.detail !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    kind: value.kind as ProjectorPreflightAsset["kind"],
    ok: value.ok,
    detail: value.detail.slice(0, 200),
    durationMs: parseMilliseconds(value.durationMs),
  };
}

function parsePreflightReport(value: unknown): ProjectorPreflightReport | null {
  if (
    !isRecord(value) ||
    typeof value.protocolVersion !== "number" ||
    typeof value.engineReady !== "boolean" ||
    typeof value.armed !== "boolean" ||
    typeof value.cacheStorage !== "boolean" ||
    !Array.isArray(value.assets) ||
    value.assets.length > MAX_PREFLIGHT_ASSETS
  ) {
    return null;
  }
  const assets: ProjectorPreflightAsset[] = [];
  for (const entry of value.assets) {
    const asset = parsePreflightAsset(entry);
    if (!asset) return null;
    assets.push(asset);
  }
  const cache = parseMediaCacheSummary(value.cache);
  return {
    protocolVersion: value.protocolVersion,
    engineReady: value.engineReady,
    armed: value.armed,
    cacheStorage: value.cacheStorage,
    assets,
    ...(cache ? { cache } : {}),
  };
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
    case "projector_status": {
      const status = parseProjectorStatus(value.status);
      return status
        ? {
            ok: true,
            message: {
              type: "projector_status",
              protocolVersion: PROTOCOL_VERSION,
              status,
            },
          }
        : { ok: false, reason: "Invalid projector status" };
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
    case "preflight_request": {
      const requestId = parseCommandIdentifier(value.requestId);
      return requestId
        ? {
            ok: true,
            message: {
              type: "preflight_request",
              protocolVersion: PROTOCOL_VERSION,
              requestId,
            },
          }
        : { ok: false, reason: "Invalid preflight request" };
    }
    case "projector_preflight": {
      const requestId = parseCommandIdentifier(value.requestId);
      const report = parsePreflightReport(value.report);
      return requestId && report
        ? {
            ok: true,
            message: {
              type: "projector_preflight",
              protocolVersion: PROTOCOL_VERSION,
              requestId,
              report,
            },
          }
        : { ok: false, reason: "Invalid projector preflight report" };
    }
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
