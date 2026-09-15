import type { CueOperation } from "../../shared/domain";

/** Cue operations in the words an operator would use, not protocol enums. */
export function describeOperation(operation: CueOperation): string {
  if (operation.kind === "delay")
    return `Wait ${(operation.durationMs / 1000).toFixed(1)}s`;
  if (operation.kind === "audio") {
    switch (operation.action) {
      case "LOAD":
        return "Start backing audio";
      case "PLAY":
        return "Play audio";
      case "PAUSE":
        return "Pause audio";
      case "RESUME":
        return "Resume audio";
      case "STOP":
        return "Stop audio";
      case "REPLAY":
        return "Replay audio";
      case "SEEK":
        return "Jump to a point in the audio";
    }
  }
  switch (operation.visual.kind) {
    case "TITLE_CARD":
      return "Show a title card";
    case "IMAGE":
      return "Show image";
    case "SLIDES":
      return "Show slide";
    case "VIDEO":
      return "Play video";
    case "BLACK":
      return "Black screen";
    case "CLEAR":
      return "Clear the screen";
  }
}
