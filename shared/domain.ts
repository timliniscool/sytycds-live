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
export type ThemeId = import("./themes").ThemeId;

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

/** Emergency is black by default; text is a deliberate second step. */
export type EmergencyPresentation = "BLACK" | "TEXT";

/**
 * How much of the completed-show ranking the public may currently see. This is
 * independent from the per-act scoreboard reveal.
 */
export type ResultsStage =
  "HIDDEN" | "LEADERBOARD" | "STAGED" | "TOP_THREE" | "WINNER";

export const MAX_PUBLIC_MESSAGE_LENGTH = 200;

/** What a projector's own media elements report, as opposed to operator intent. */
export type MediaPlaybackState =
  "IDLE" | "LOADED" | "PLAYING" | "PAUSED" | "ENDED" | "ERROR";

export type ConnectionRole =
  | { kind: "admin" }
  | { kind: "projector" }
  | { kind: "audience" }
  | { kind: "judge"; judgeId: JudgeId };

export type VisualCueKind =
  "TITLE_CARD" | "IMAGE" | "SLIDES" | "VIDEO" | "BLACK" | "CLEAR";
export type AudioCueKind = "AUDIO" | "VIDEO_AUDIO";

/**
 * `contain` preserves the whole slide inside a black frame and is the default.
 * `cover` crops to fill and is only honoured where the cue explicitly asks.
 */
export type ImageFit = "contain" | "cover";

/** Visual and backing-audio channels are intentionally independent. */
export interface VisualCue {
  kind: VisualCueKind;
  sourceKey: string | null;
  title: string | null;
  fit?: ImageFit;
}

export interface AudioCue {
  kind: AudioCueKind;
  sourceKey: string;
}

/**
 * `SIMPLE` cues are derived from an act's presentation settings and are
 * regenerated whenever those change; `MANUAL` cues are the operator's own and
 * are never touched by the derivation.
 */
export type CueOrigin = "MANUAL" | "SIMPLE";

export interface PersistedCue {
  id: CueId;
  showId: ShowId;
  actId: ActId;
  position: number;
  origin: CueOrigin;
  visual: VisualCue | null;
  audio: AudioCue | null;
  durationMs: number | null;
  operatorLabel: string;
  operations: readonly CueOperation[];
  internalNote: string;
  validationState?: "VALID" | "MISSING_MEDIA" | "INCOMPATIBLE_MEDIA";
}

/**
 * The projector needs enough of a cue to load media and nothing more. Operator
 * labels and backstage notes are removed by the server projection, never hidden
 * by the display client.
 */
export type ProjectorCue = Omit<PersistedCue, "operatorLabel" | "internalNote">;

export type CueOperation =
  | { kind: "visual"; visual: VisualCue }
  | {
      kind: "audio";
      action: "LOAD" | "PLAY" | "PAUSE" | "RESUME" | "STOP" | "REPLAY" | "SEEK";
      assetId?: string;
      positionMs?: number;
    }
  | { kind: "delay"; durationMs: number };

export interface MediaAsset {
  id: string;
  objectKey: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  versionIdentifier: string;
  uploadedAt: string;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  referenced: boolean;
}

export interface PublicAct {
  id: ActId;
  order: number;
  performerName: string;
  schoolYear: string;
  actName: string;
  actType: string;
  /**
   * Empty on audience phones unless the act opts in. The server omits the
   * content rather than sending it for a client to hide.
   */
  publicDescription: string;
  publicImageAssetId?: string | null;
  /** A withdrawn act keeps its history but leaves the running order and rankings. */
  withdrawn: boolean;
}

/** Whether the act's optional copy and artwork reach audience phones at all. */
export interface ActAudienceVisibility {
  showDescriptionToAudience: boolean;
  showImageToAudience: boolean;
}

/** The automatic performance screen, or a custom visual that replaces it. */
export type PerformanceMode = "DEFAULT" | "CUSTOM";
/** Backing audio starts on the operator's GO, or with the performance itself. */
export type BackingAudioStart = "MANUAL" | "PERFORMANCE";

/**
 * How an act presents itself on stage, in the terms an operator thinks in. The
 * cue engine underneath is derived from this, not replaced by it.
 */
export interface ActPresentation {
  performanceMode: PerformanceMode;
  /** The image or video shown instead of the automatic screen. */
  performanceAssetId: string | null;
  /** `contain` by default: the whole frame, never stretched or cropped. */
  performanceFit: ImageFit;
  backingAudioAssetId: string | null;
  backingAudioStart: BackingAudioStart;
}

export interface AdminAct extends PublicAct, ActAudienceVisibility {
  internalNotes: string;
  presentation: ActPresentation;
  cues: readonly PersistedCue[];
}

export interface PersistedShow {
  id: ShowId;
  title: string;
  /** Optional second line for lobby graphics; empty when the show sets none. */
  tagline: string;
  shortName: string;
  themeId: ThemeId;
  fontFamily: string;
  audienceWeight: number;
  reactionsEnabled: boolean;
  /** Short operator-configured public text for the INTERMISSION graphic. */
  intermissionMessage: string;
  /** Short public text shown only in the TEXT emergency presentation. */
  emergencyMessage: string;
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
  emergencyPresentation: EmergencyPresentation;
  resultsStage: ResultsStage;
  /** STAGED reveal: how many rank groups, counted from last place, are public. */
  resultsRevealedGroups: number;
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

export interface AdminJudgeState {
  id: JudgeId;
  slot: number;
  displayName: string;
  permission: JudgePermissionState;
  submission: JudgeSubmission | null;
}

export type OperationalResult =
  | {
      kind: "incomplete";
      missingJudgeSlots: readonly number[];
      audienceMissing: boolean;
      judgeConfigurationMissing?: boolean;
    }
  | { kind: "provisional"; value: number }
  | { kind: "finalised"; value: number; finalisedAt: string };

/**
 * One show-critical media file as the projector cache needs to know it. The
 * version is the R2 object version, so a re-uploaded file is a new entry.
 */
export interface MediaManifestEntry {
  id: string;
  version: string;
  sizeBytes: number;
  mimeType: string;
}

/** Projector media cache state, reported to the operator; never persisted. */
export interface MediaCacheSummary {
  files: number;
  cached: number;
  failed: number;
  bytes: number;
  cachedBytes: number;
  /** Whether the browser granted persistent storage; null before asking. */
  persisted: boolean | null;
  error: string | null;
}

/**
 * One line of the append-only operational log. `data` is small, safe metadata
 * (IDs, modes, counts); secrets, tokens and raw addresses never appear here.
 */
export interface AuditEvent {
  id: number;
  at: string;
  type: string;
  actor: "admin" | "projector" | "audience" | "judge" | "system";
  commandId: string | null;
  data: Readonly<Record<string, string | number | boolean | null>>;
}

/** A judge's public scoreboard tile: raw text as typed plus the score that counts. */
export interface ScoreboardJudge {
  slot: number;
  displayName: string;
  submission: {
    raw: string;
    parsed: ParsedJudgeScore;
    effectiveScore: EffectiveJudgeScore;
  } | null;
}

/**
 * Live scoreboard inputs for the current act. The final score is deliberately
 * absent: it travels only as `revealedResult` after the operator reveals it.
 */
export interface ProjectorScoreboard {
  audience: AudienceAggregate | null;
  judges: readonly ScoreboardJudge[];
}

/** One finalised act in the completed-show ranking. */
export interface RankingEntry {
  actId: ActId;
  /** Competition ranking: equal stored scores share a rank and skip the next. */
  rank: number;
  tied: boolean;
  finalScore: number;
  performerName: string;
  actName: string;
  schoolYear: string;
  actType: string;
}

/**
 * The public slice of the ranking under the current results stage. `pending`
 * counts rank groups the STAGED reveal has not reached; `total` is every ranked
 * group so the projector can draw the empty slots.
 */
export interface PublicResults {
  stage: Exclude<ResultsStage, "HIDDEN">;
  entries: readonly RankingEntry[];
  pendingGroups: number;
  totalGroups: number;
}

/** Why an act is absent from the ranking, in the operator's own terms. */
export type RankingExclusionReason =
  /** Scoring is complete but nobody has pressed FINALISE yet. */
  | "NOT_FINALISED"
  /** The audience block carries weight and no audience result exists. */
  | "AUDIENCE_RESULT_INCOMPLETE"
  /** At least one configured judge has not submitted. */
  | "JUDGE_SCORE_MISSING"
  /** Judges carry weight but the show has no judge panel configured. */
  | "JUDGES_NOT_CONFIGURED";

/** An act the ranking cannot include, and the reason the operator can act on. */
export interface UnrankedAct {
  act: PublicAct;
  reason: RankingExclusionReason;
  /** Slot numbers still owing a score; empty unless the reason names judges. */
  missingJudgeSlots: readonly number[];
}

/** The operator's complete ranking picture, including acts that cannot rank. */
export interface AdminRanking {
  ranked: readonly RankingEntry[];
  incomplete: readonly UnrankedAct[];
  withdrawn: readonly PublicAct[];
}

export interface AdminShowProjection {
  role: "admin";
  show: PersistedShow;
  acts: readonly AdminAct[];
  audienceAggregates: readonly AudienceAggregate[];
  runtime: ShowRuntimeState;
  results: Readonly<Record<string, OperationalResult>>;
  judges: readonly AdminJudgeState[];
  ranking: AdminRanking;
}

export interface ProjectorShowProjection {
  role: "projector";
  show: Pick<
    PersistedShow,
    | "title"
    | "tagline"
    | "shortName"
    | "themeId"
    | "fontFamily"
    | "reactionsEnabled"
    | "intermissionMessage"
    | "emergencyMessage"
    | "displayMode"
    | "activeActId"
    | "revision"
  >;
  activeAct: PublicAct | null;
  activeCues: readonly ProjectorCue[];
  runtime: Pick<
    ShowRuntimeState,
    | "preparedCueId"
    | "activeVisualCueId"
    | "activeAudioCueId"
    | "visualTransport"
    | "audioTransport"
    | "blackScreen"
    | "emergencyPresentation"
  >;
  scoreboard: ProjectorScoreboard;
  /** Present only after the operator has publicly revealed a finalised result. */
  revealedResult: number | null;
  /** Null while the results stage is HIDDEN. */
  publicResults: PublicResults | null;
  /** Canonical audience URL when the deployment configures one; else the client uses its own origin. */
  joinUrl: string | null;
  /** Every asset any cue of the show references, for prefetch and caching. */
  mediaManifest: readonly MediaManifestEntry[];
}

export interface AudienceShowProjection {
  role: "audience";
  /** `displayMode` is already public on the projector, so phones may mirror it. */
  show: Pick<
    PersistedShow,
    | "title"
    | "shortName"
    | "themeId"
    | "fontFamily"
    | "reactionsEnabled"
    | "intermissionMessage"
    | "emergencyMessage"
    | "displayMode"
    | "activeActId"
    | "audienceVoteState"
    | "revision"
  >;
  activeAct: PublicAct | null;
  revealedResult: number | null;
  publicResults: PublicResults | null;
}

export interface JudgeShowProjection {
  role: "judge";
  show: Pick<
    PersistedShow,
    | "title"
    | "shortName"
    | "themeId"
    | "fontFamily"
    | "activeActId"
    | "revision"
  >;
  activeAct: PublicAct | null;
  permission: JudgePermissionState;
  submission: JudgeSubmission | null;
}

export type ClientProjection =
  | AdminShowProjection
  | ProjectorShowProjection
  | AudienceShowProjection
  | JudgeShowProjection;
