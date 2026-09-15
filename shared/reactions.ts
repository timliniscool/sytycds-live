export const REACTION_IDS = [
  "applause",
  "heart",
  "fire",
  "laugh",
  "wow",
] as const;
export type ReactionId = (typeof REACTION_IDS)[number];
export type ReactionHistogram = readonly [
  number,
  number,
  number,
  number,
  number,
];

export const REACTION_EPOCH_MS = 15_000;
export const REACTION_INTERVAL_MS = 5_000;
export const REACTION_TARGET_REPORTERS = 5;
export const REACTION_SLOT_COUNT = 1_000;
export const REACTION_MAX_UNITS = 8;

/** Stable non-secret slot derived server-side from the voter hash. */
export function reactionSlot(hash: ArrayBuffer): number {
  const bytes = new Uint8Array(hash);
  const value =
    ((bytes[0] ?? 0) << 24) |
    ((bytes[1] ?? 0) << 16) |
    ((bytes[2] ?? 0) << 8) |
    (bytes[3] ?? 0);
  return (value >>> 0) % REACTION_SLOT_COUNT;
}

export function reporterEligible(
  slot: number,
  epoch: number,
  target = REACTION_TARGET_REPORTERS,
): boolean {
  if (!Number.isSafeInteger(slot) || !Number.isSafeInteger(epoch) || target < 1)
    return false;
  const width = Math.min(REACTION_SLOT_COUNT, target);
  const start =
    (((epoch * 97) % REACTION_SLOT_COUNT) + REACTION_SLOT_COUNT) %
    REACTION_SLOT_COUNT;
  const distance = (slot - start + REACTION_SLOT_COUNT) % REACTION_SLOT_COUNT;
  return distance < width;
}

/**
 * Spreads the small eligible cohort across its reporting interval. Reporters
 * derive this from server-adjusted time, so no per-client timer state or
 * scheduling message is needed.
 */
export function reporterFlushDue(
  slot: number,
  epoch: number,
  serverNow: number,
  intervalMs: number,
  target = REACTION_TARGET_REPORTERS,
): boolean {
  if (!reporterEligible(slot, epoch, target) || intervalMs < 1_000)
    return false;
  const phases = Math.max(1, Math.floor(intervalMs / 1_000));
  const start =
    (((epoch * 97) % REACTION_SLOT_COUNT) + REACTION_SLOT_COUNT) %
    REACTION_SLOT_COUNT;
  const cohortPosition =
    (slot - start + REACTION_SLOT_COUNT) % REACTION_SLOT_COUNT;
  return Math.floor(serverNow / 1_000) % phases === cohortPosition % phases;
}

export function capReactionHistogram(
  histogram: readonly number[],
): ReactionHistogram | null {
  if (histogram.length !== REACTION_IDS.length) return null;
  const clean = histogram.map((value) =>
    Number.isSafeInteger(value) && value >= 0 ? value : -1,
  );
  if (clean.some((value) => value < 0)) return null;
  const total = clean.reduce((sum, value) => sum + value, 0);
  if (total === 0) return [0, 0, 0, 0, 0];
  if (total <= REACTION_MAX_UNITS) return clean as unknown as ReactionHistogram;
  let remaining = REACTION_MAX_UNITS;
  const capped = clean.map((value) => {
    const allocated = Math.min(value, remaining);
    remaining -= allocated;
    return allocated;
  });
  return capped as unknown as ReactionHistogram;
}

export function reactionTrafficEstimate(
  clientCount: number,
  seconds: number,
): number {
  const reporters = Math.min(clientCount, REACTION_TARGET_REPORTERS);
  return Math.ceil((seconds * reporters) / (REACTION_INTERVAL_MS / 1_000));
}
