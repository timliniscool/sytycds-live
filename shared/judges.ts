/**
 * The one authoritative judge-configuration rule, shared verbatim by the setup
 * console and the coordinator. There is a single source of truth for how many
 * judges a show has: the list of configured judges. A separate "number of
 * judges" question does not exist anywhere in the system — the count is the
 * length of this list.
 */

export const MIN_JUDGES = 1;
export const MAX_JUDGES = 8;
export const MAX_JUDGE_NAME_LENGTH = 120;

/** Slot numbers are 1-based and are what the operator sees on the matrix. */
export function defaultJudgeName(slot: number): string {
  return `Judge ${slot}`;
}

/**
 * Collapses whitespace and falls back to the slot's default label. Entering a
 * personal name is optional: an empty or blank field means "Judge N", which is
 * a perfectly valid configuration, not an error.
 */
export function normaliseJudgeName(value: string, slot: number): string {
  const clean = value.replace(/\s+/gu, " ").trim();
  return clean.length === 0 ? defaultJudgeName(slot) : clean;
}

export type JudgeConfigurationResult =
  { ok: true; names: readonly string[] } | { ok: false; reason: string };

/**
 * Only the active configured slots matter. Hidden slots beyond the configured
 * count are never inspected, so shrinking the panel can never be invalidated
 * by a name the operator can no longer see.
 */
export function normaliseJudgeConfiguration(
  supplied: readonly string[],
): JudgeConfigurationResult {
  if (supplied.length < MIN_JUDGES || supplied.length > MAX_JUDGES) {
    return {
      ok: false,
      reason: `Configure between ${MIN_JUDGES} and ${MAX_JUDGES} judges`,
    };
  }
  const names = supplied.map((name, index) =>
    normaliseJudgeName(name, index + 1),
  );
  const tooLong = names.find((name) => name.length > MAX_JUDGE_NAME_LENGTH);
  if (tooLong !== undefined) {
    return {
      ok: false,
      reason: `Judge names may contain up to ${MAX_JUDGE_NAME_LENGTH} characters`,
    };
  }
  return { ok: true, names };
}

/** Grows or shrinks a name list to `count`, keeping what the operator typed. */
export function resizeJudgeNames(
  current: readonly string[],
  count: number,
): string[] {
  const size = Math.min(MAX_JUDGES, Math.max(MIN_JUDGES, count));
  return Array.from(
    { length: size },
    (_, index) => current[index] ?? defaultJudgeName(index + 1),
  );
}
