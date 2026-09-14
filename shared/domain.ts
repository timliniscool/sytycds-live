/**
 * Shared, transport-neutral vocabulary for the browser, Worker, and coordinator.
 *
 * Values arriving from a browser or HTTP request are untrusted until the Worker
 * validates them. Values read from the coordinator's database may rely on its
 * constraints. Scores calculated by a client are display-only, never authority.
 */

declare const brand: unique symbol;

type Brand<Value, Name extends string> = Value & {
  readonly [brand]: Name;
};

export type ShowId = Brand<string, "ShowId">;
export type ActId = Brand<string, "ActId">;
export type JudgeId = Brand<string, "JudgeId">;
export type CueId = Brand<string, "CueId">;
export type CommandId = Brand<string, "CommandId">;
export type ShowRevision = Brand<number, "ShowRevision">;

export const showId = (value: string): ShowId => value as ShowId;
export const actId = (value: string): ActId => value as ActId;
export const judgeId = (value: string): JudgeId => value as JudgeId;
export const cueId = (value: string): CueId => value as CueId;
export const commandId = (value: string): CommandId => value as CommandId;
export const showRevision = (value: number): ShowRevision =>
  value as ShowRevision;

export const PROTOCOL_VERSION = 1 as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

export type DisplayMode =
  | "LOBBY"
  | "ACT_CARD"
  | "PERFORMANCE"
  | "SCOREBOARD"
  | "INTERMISSION"
  | "HOLD"
  | "FINAL_RESULTS"
  | "EMERGENCY";

export type AudienceVoteState = "OPEN" | "CLOSED";
export type JudgePermissionState = "OPEN" | "CLOSED";
export type ResultRevealState = "HIDDEN" | "REVEALED";
export type MediaTransportState = "STOPPED" | "PREPARED" | "PLAYING" | "PAUSED";

export type ConnectionRole =
  | { kind: "admin" }
  | { kind: "projector" }
  | { kind: "audience" }
  | { kind: "judge"; judgeId: JudgeId };

export type VisualCueKind =
  "TITLE_CARD" | "IMAGE" | "SLIDES" | "VIDEO" | "BLACK";
export type AudioCueKind = "AUDIO" | "VIDEO_AUDIO";

/** Visual and backing-audio channels are intentionally independent. */
export interface VisualCue {
  kind: VisualCueKind;
  sourceKey: string | null;
  title: string | null;
}

export interface AudioCue {
  kind: AudioCueKind;
  sourceKey: string;
}

export interface PersistedCue {
  id: CueId;
  showId: ShowId;
  actId: ActId;
  position: number;
  visual: VisualCue | null;
  audio: AudioCue | null;
  durationMs: number | null;
}

export interface PublicAct {
  id: ActId;
  order: number;
  performerName: string;
  schoolYear: string;
  actName: string;
  actType: string;
  publicDescription: string;
}

export interface AdminAct extends PublicAct {
  internalNotes: string;
  cues: readonly PersistedCue[];
}

export interface PersistedShow {
  id: ShowId;
  title: string;
  displayMode: DisplayMode;
  audienceVoteState: AudienceVoteState;
  resultRevealState: ResultRevealState;
  activeActId: ActId | null;
  revision: ShowRevision;
}

/** Durable operational state that must survive coordinator hibernation. */
export interface ShowRuntimeState {
  showId: ShowId;
  previousDisplayMode: DisplayMode | null;
  globalJudgePermission: JudgePermissionState;
  preparedCueId: CueId | null;
  activeVisualCueId: CueId | null;
  activeAudioCueId: CueId | null;
  visualTransport: MediaTransportState;
  audioTransport: MediaTransportState;
  blackScreen: boolean;
}

export type AudienceScore = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export const isAudienceScore = (value: unknown): value is AudienceScore =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= 10;

export interface JudgeRawInput {
  raw: string;
}

export type ParsedJudgeScore =
  | { classification: "FINITE"; finiteValue: number }
  | { classification: "POSITIVE_INFINITY"; finiteValue: null }
  | { classification: "NEGATIVE_INFINITY"; finiteValue: null };

/** The persisted, server-derived score after applying the mandated taper. */
export type EffectiveJudgeScore = number;

export interface JudgeSubmission {
  showId: ShowId;
  actId: ActId;
  judgeId: JudgeId;
  input: JudgeRawInput;
  parsed: ParsedJudgeScore;
  effectiveScore: EffectiveJudgeScore;
  submittedAt: string;
}

export interface AudienceAggregate {
  showId: ShowId;
  actId: ActId;
  voteCount: number;
  weightedSum: number;
  totalWeight: number;
  weightedMean: number | null;
}

export interface PersistedResult {
  showId: ShowId;
  actId: ActId;
  audienceMean: number | null;
  judgeScores: readonly EffectiveJudgeScore[];
  finalScore: number | null;
  finalisedAt: string | null;
}

export interface AdminShowProjection {
  role: "admin";
  show: PersistedShow;
  acts: readonly AdminAct[];
  audienceAggregates: readonly AudienceAggregate[];
  runtime: ShowRuntimeState;
}

export interface ProjectorShowProjection {
  role: "projector";
  show: Pick<
    PersistedShow,
    "title" | "displayMode" | "activeActId" | "revision"
  >;
  activeAct: PublicAct | null;
  activeCues: readonly PersistedCue[];
  runtime: Pick<
    ShowRuntimeState,
    | "preparedCueId"
    | "activeVisualCueId"
    | "activeAudioCueId"
    | "visualTransport"
    | "audioTransport"
    | "blackScreen"
  >;
}

export interface AudienceShowProjection {
  role: "audience";
  show: Pick<
    PersistedShow,
    "title" | "activeActId" | "audienceVoteState" | "revision"
  >;
  activeAct: PublicAct | null;
}

export interface JudgeShowProjection {
  role: "judge";
  show: Pick<PersistedShow, "title" | "activeActId" | "revision">;
  activeAct: PublicAct | null;
  permission: JudgePermissionState;
  submission: JudgeSubmission | null;
}

export type ClientProjection =
  | AdminShowProjection
  | ProjectorShowProjection
  | AudienceShowProjection
  | JudgeShowProjection;
