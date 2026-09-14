import {
  actId,
  commandId,
  cueId,
  judgeId,
  PROTOCOL_VERSION,
  showRevision,
  type ActId,
  type CommandId,
  type CueId,
  type DisplayMode,
  type JudgeId,
  type ProtocolVersion,
  type ShowRevision,
} from "./domain";
import { isRecord } from "./trust";

export type AdminCommandType =
  | "SELECT_ACT"
  | "NEXT_ACT"
  | "PREVIOUS_ACT"
  | "SET_DISPLAY_MODE"
  | "RESTORE_DISPLAY"
  | "OPEN_AUDIENCE_VOTING"
  | "CLOSE_AUDIENCE_VOTING"
  | "OPEN_ALL_JUDGES"
  | "CLOSE_ALL_JUDGES"
  | "OPEN_JUDGE"
  | "CLOSE_JUDGE"
  | "REVEAL_RESULT"
  | "HIDE_RESULT"
  | "FINALISE_RESULT"
  | "PREPARE_CUE"
  | "PLAY_CUE"
  | "PAUSE_MEDIA"
  | "RESUME_MEDIA"
  | "STOP_MEDIA"
  | "RESTART_MEDIA"
  | "REPLAY_MEDIA"
  | "SEEK_MEDIA"
  | "NEXT_CUE"
  | "PREVIOUS_CUE"
  | "BLACK_SCREEN";

interface AdminCommandBase {
  protocolVersion: ProtocolVersion;
  commandId: CommandId;
  expectedRevision: ShowRevision;
}

export type AdminCommand =
  | (AdminCommandBase & { type: "SELECT_ACT"; actId: ActId })
  | (AdminCommandBase & { type: "NEXT_ACT" })
  | (AdminCommandBase & { type: "PREVIOUS_ACT" })
  | (AdminCommandBase & { type: "SET_DISPLAY_MODE"; mode: DisplayMode })
  | (AdminCommandBase & { type: "RESTORE_DISPLAY" })
  | (AdminCommandBase & { type: "OPEN_AUDIENCE_VOTING" })
  | (AdminCommandBase & { type: "CLOSE_AUDIENCE_VOTING" })
  | (AdminCommandBase & { type: "OPEN_ALL_JUDGES" })
  | (AdminCommandBase & { type: "CLOSE_ALL_JUDGES" })
  | (AdminCommandBase & { type: "OPEN_JUDGE"; judgeId: JudgeId })
  | (AdminCommandBase & { type: "CLOSE_JUDGE"; judgeId: JudgeId })
  | (AdminCommandBase & { type: "REVEAL_RESULT" })
  | (AdminCommandBase & { type: "HIDE_RESULT" })
  | (AdminCommandBase & { type: "FINALISE_RESULT" })
  | (AdminCommandBase & { type: "PREPARE_CUE"; cueId: CueId })
  | (AdminCommandBase & { type: "PLAY_CUE"; cueId?: CueId })
  | (AdminCommandBase & { type: "PAUSE_MEDIA" })
  | (AdminCommandBase & { type: "RESUME_MEDIA" })
  | (AdminCommandBase & { type: "STOP_MEDIA" })
  | (AdminCommandBase & { type: "RESTART_MEDIA" })
  | (AdminCommandBase & { type: "REPLAY_MEDIA" })
  | (AdminCommandBase & { type: "SEEK_MEDIA"; positionMs: number })
  | (AdminCommandBase & { type: "NEXT_CUE" })
  | (AdminCommandBase & { type: "PREVIOUS_CUE" })
  | (AdminCommandBase & { type: "BLACK_SCREEN" });

export type CommandStatus =
  "accepted" | "rejected" | "stale" | "invalid" | "unauthorised" | "conflict";

export interface AdminCommandAcknowledgement {
  commandId: CommandId | null;
  status: CommandStatus;
  revision: ShowRevision;
  reason?: string;
}

export type AdminCommandParseResult =
  | { ok: true; command: AdminCommand }
  | { ok: false; reason: string; commandId: CommandId | null };

const DISPLAY_MODES: ReadonlySet<DisplayMode> = new Set([
  "LOBBY",
  "ACT_CARD",
  "PERFORMANCE",
  "SCOREBOARD",
  "INTERMISSION",
  "HOLD",
  "FINAL_RESULTS",
  "EMERGENCY",
]);

const COMMAND_TYPES: ReadonlySet<AdminCommandType> = new Set([
  "SELECT_ACT",
  "NEXT_ACT",
  "PREVIOUS_ACT",
  "SET_DISPLAY_MODE",
  "RESTORE_DISPLAY",
  "OPEN_AUDIENCE_VOTING",
  "CLOSE_AUDIENCE_VOTING",
  "OPEN_ALL_JUDGES",
  "CLOSE_ALL_JUDGES",
  "OPEN_JUDGE",
  "CLOSE_JUDGE",
  "REVEAL_RESULT",
  "HIDE_RESULT",
  "FINALISE_RESULT",
  "PREPARE_CUE",
  "PLAY_CUE",
  "PAUSE_MEDIA",
  "RESUME_MEDIA",
  "STOP_MEDIA",
  "RESTART_MEDIA",
  "REPLAY_MEDIA",
  "SEEK_MEDIA",
  "NEXT_CUE",
  "PREVIOUS_CUE",
  "BLACK_SCREEN",
]);

const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;

function parseCommandId(value: unknown): CommandId | null {
  return typeof value === "string" && IDENTIFIER.test(value)
    ? commandId(value)
    : null;
}

function parseIdentifier(
  value: unknown,
  label: "act" | "cue" | "judge",
): ActId | CueId | JudgeId | null {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    return null;
  }

  switch (label) {
    case "act":
      return actId(value);
    case "cue":
      return cueId(value);
    case "judge":
      return judgeId(value);
  }
}

function parseBase(value: unknown):
  | {
      ok: true;
      base: AdminCommandBase & { type: AdminCommandType };
      value: Record<string, unknown>;
    }
  | {
      ok: false;
      reason: string;
      commandId: CommandId | null;
    } {
  if (!isRecord(value)) {
    return { ok: false, reason: "Command must be an object", commandId: null };
  }

  const parsedCommandId = parseCommandId(value.commandId);
  if (value.protocolVersion !== PROTOCOL_VERSION) {
    return {
      ok: false,
      reason: "Unsupported protocol version",
      commandId: parsedCommandId,
    };
  }
  if (!parsedCommandId) {
    return { ok: false, reason: "Invalid command ID", commandId: null };
  }
  if (
    typeof value.expectedRevision !== "number" ||
    !Number.isSafeInteger(value.expectedRevision) ||
    value.expectedRevision < 0
  ) {
    return {
      ok: false,
      reason: "Invalid expected revision",
      commandId: parsedCommandId,
    };
  }
  if (
    typeof value.type !== "string" ||
    !COMMAND_TYPES.has(value.type as AdminCommandType)
  ) {
    return {
      ok: false,
      reason: "Unknown admin command",
      commandId: parsedCommandId,
    };
  }

  return {
    ok: true,
    base: {
      protocolVersion: PROTOCOL_VERSION,
      commandId: parsedCommandId,
      expectedRevision: showRevision(value.expectedRevision),
      type: value.type as AdminCommandType,
    },
    value,
  };
}

/** Parses untrusted JSON once at the protocol boundary. */
export function parseAdminCommand(value: unknown): AdminCommandParseResult {
  const base = parseBase(value);
  if (!base.ok) {
    return base;
  }

  switch (base.base.type) {
    case "SELECT_ACT": {
      const selectedActId = parseIdentifier(base.value.actId, "act");
      return selectedActId
        ? {
            ok: true,
            command: {
              ...base.base,
              type: "SELECT_ACT",
              actId: selectedActId as ActId,
            },
          }
        : {
            ok: false,
            reason: "Invalid act ID",
            commandId: base.base.commandId,
          };
    }
    case "SET_DISPLAY_MODE":
      return typeof base.value.mode === "string" &&
        DISPLAY_MODES.has(base.value.mode as DisplayMode)
        ? {
            ok: true,
            command: {
              ...base.base,
              type: "SET_DISPLAY_MODE",
              mode: base.value.mode as DisplayMode,
            },
          }
        : {
            ok: false,
            reason: "Invalid display mode",
            commandId: base.base.commandId,
          };
    case "OPEN_JUDGE":
    case "CLOSE_JUDGE": {
      const selectedJudgeId = parseIdentifier(base.value.judgeId, "judge");
      return selectedJudgeId
        ? {
            ok: true,
            command: {
              ...base.base,
              type: base.base.type,
              judgeId: selectedJudgeId as JudgeId,
            },
          }
        : {
            ok: false,
            reason: "Invalid judge ID",
            commandId: base.base.commandId,
          };
    }
    case "PREPARE_CUE": {
      const selectedCueId = parseIdentifier(base.value.cueId, "cue");
      return selectedCueId
        ? {
            ok: true,
            command: {
              ...base.base,
              type: "PREPARE_CUE",
              cueId: selectedCueId as CueId,
            },
          }
        : {
            ok: false,
            reason: "Invalid cue ID",
            commandId: base.base.commandId,
          };
    }
    case "PLAY_CUE": {
      if (base.value.cueId === undefined) {
        return { ok: true, command: { ...base.base, type: "PLAY_CUE" } };
      }
      const selectedCueId = parseIdentifier(base.value.cueId, "cue");
      return selectedCueId
        ? {
            ok: true,
            command: {
              ...base.base,
              type: "PLAY_CUE",
              cueId: selectedCueId as CueId,
            },
          }
        : {
            ok: false,
            reason: "Invalid cue ID",
            commandId: base.base.commandId,
          };
    }
    case "NEXT_ACT":
    case "PREVIOUS_ACT":
    case "RESTORE_DISPLAY":
    case "OPEN_AUDIENCE_VOTING":
    case "CLOSE_AUDIENCE_VOTING":
    case "OPEN_ALL_JUDGES":
    case "CLOSE_ALL_JUDGES":
    case "REVEAL_RESULT":
    case "HIDE_RESULT":
    case "FINALISE_RESULT":
    case "PAUSE_MEDIA":
    case "RESUME_MEDIA":
    case "STOP_MEDIA":
    case "RESTART_MEDIA":
    case "REPLAY_MEDIA":
    case "NEXT_CUE":
    case "PREVIOUS_CUE":
    case "BLACK_SCREEN":
      return {
        ok: true,
        command: { ...base.base, type: base.base.type },
      } as AdminCommandParseResult;
    case "SEEK_MEDIA":
      return typeof base.value.positionMs === "number" &&
        Number.isSafeInteger(base.value.positionMs) &&
        base.value.positionMs >= 0
        ? {
            ok: true,
            command: {
              ...base.base,
              type: "SEEK_MEDIA",
              positionMs: base.value.positionMs,
            },
          }
        : {
            ok: false,
            reason: "Invalid media seek position",
            commandId: base.base.commandId,
          };
  }
}
