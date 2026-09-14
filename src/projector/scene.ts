import type {
  EmergencyPresentation,
  ProjectorCue,
  ProjectorShowProjection,
  PublicAct,
  PublicResults,
} from "../../shared/domain";
import type { RealtimeConnectionState } from "../realtime/RealtimeClient";

/** The graphics underneath the media layer, chosen by display mode. */
export type ProjectorBase =
  | { kind: "CONNECTING"; unauthorised: boolean }
  | { kind: "LOBBY"; title: string; tagline: string; joinUrl: string }
  | { kind: "ACT_CARD"; act: PublicAct }
  | { kind: "STAND_BY" }
  | { kind: "STAGE" }
  | { kind: "SCOREBOARD"; act: PublicAct | null }
  | { kind: "INTERMISSION"; message: string }
  | { kind: "HOLD" }
  | { kind: "EMERGENCY"; presentation: EmergencyPresentation; message: string }
  | { kind: "FINAL_RESULTS"; title: string; results: PublicResults | null };

/** What the commanded visual channel currently asks the screen to show. */
export type VisualLayer =
  | { kind: "NONE" }
  | { kind: "BLACK" }
  | { kind: "TITLE_CARD"; title: string }
  | { kind: "MEDIA" };

export interface ProjectorScene {
  base: ProjectorBase;
  layer: VisualLayer;
  /**
   * False in the modes whose graphics are the commanded public output
   * (HOLD, EMERGENCY, SCOREBOARD, FINAL_RESULTS): a lingering image must not
   * cover the scores, and an override must win immediately. Audio is
   * unaffected; only the frame is hidden.
   */
  mediaVisible: boolean;
}

export function joinUrlFor(
  configured: string | null,
  clientOrigin: string,
): string {
  return configured ?? `${clientOrigin}/vote`;
}

function activeVisualLayer(
  projection: ProjectorShowProjection,
  cues: readonly ProjectorCue[],
): VisualLayer {
  if (projection.runtime.blackScreen) return { kind: "BLACK" };
  if (projection.runtime.visualTransport === "STOPPED") return { kind: "NONE" };
  const cue = cues.find(
    (candidate) => candidate.id === projection.runtime.activeVisualCueId,
  );
  const visual = cue?.visual ?? null;
  if (!visual) return { kind: "NONE" };
  switch (visual.kind) {
    case "BLACK":
      return { kind: "BLACK" };
    case "TITLE_CARD":
      return { kind: "TITLE_CARD", title: visual.title ?? "" };
    case "CLEAR":
      return { kind: "NONE" };
    case "IMAGE":
    case "SLIDES":
    case "VIDEO":
      return visual.sourceKey ? { kind: "MEDIA" } : { kind: "NONE" };
  }
}

/** One place decides what the hall sees, so the surface only renders. */
export function deriveScene(
  projection: ProjectorShowProjection | null,
  connection: RealtimeConnectionState,
  clientOrigin: string,
): ProjectorScene {
  if (!projection) {
    return {
      base: { kind: "CONNECTING", unauthorised: connection === "UNAUTHORISED" },
      layer: { kind: "NONE" },
      mediaVisible: false,
    };
  }
  const layer = activeVisualLayer(projection, projection.activeCues);
  const mode = projection.show.displayMode;
  const mediaVisible =
    mode !== "HOLD" &&
    mode !== "EMERGENCY" &&
    mode !== "SCOREBOARD" &&
    mode !== "FINAL_RESULTS";

  let base: ProjectorBase;
  switch (mode) {
    case "LOBBY":
      base = {
        kind: "LOBBY",
        title: projection.show.title,
        tagline: projection.show.tagline,
        joinUrl: joinUrlFor(projection.joinUrl, clientOrigin),
      };
      break;
    case "ACT_CARD":
      base = projection.activeAct
        ? { kind: "ACT_CARD", act: projection.activeAct }
        : { kind: "STAND_BY" };
      break;
    case "PERFORMANCE":
      base = { kind: "STAGE" };
      break;
    case "SCOREBOARD":
      base = { kind: "SCOREBOARD", act: projection.activeAct };
      break;
    case "INTERMISSION":
      base = {
        kind: "INTERMISSION",
        message: projection.show.intermissionMessage,
      };
      break;
    case "HOLD":
      base = { kind: "HOLD" };
      break;
    case "EMERGENCY":
      base = {
        kind: "EMERGENCY",
        presentation: projection.runtime.emergencyPresentation,
        message: projection.show.emergencyMessage,
      };
      break;
    case "FINAL_RESULTS":
      base = {
        kind: "FINAL_RESULTS",
        title: projection.show.title,
        results: projection.publicResults,
      };
      break;
  }
  return {
    base,
    layer: mediaVisible ? layer : { kind: "NONE" },
    mediaVisible,
  };
}
