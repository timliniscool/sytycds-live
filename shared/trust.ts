import type { JudgeRawInput } from "./domain";

/**
 * Every value supplied by a browser or Worker request starts as unknown. These
 * narrow guards are deliberately small; command-specific validation belongs at
 * the coordinator transition that owns the command.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJudgeRawInput(value: unknown): value is JudgeRawInput {
  return isRecord(value) && typeof value.raw === "string";
}
