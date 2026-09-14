import {
  REACTION_EPOCH_MS,
  REACTION_INTERVAL_MS,
  REACTION_MAX_UNITS,
  reporterEligible,
  type ReactionHistogram,
} from "../shared/reactions";

export interface ReactionValidationInput {
  slot: number;
  epoch: number;
  interval: number;
  lastInterval: number;
  now: number;
  enabled: boolean;
  emergency: boolean;
  histogram: ReactionHistogram;
  eligibleSlots: number;
}

export function validateReactionSummary(
  input: ReactionValidationInput,
): boolean {
  const total = input.histogram.reduce((sum, count) => sum + count, 0);
  return (
    input.enabled &&
    !input.emergency &&
    total > 0 &&
    total <= REACTION_MAX_UNITS &&
    input.epoch === Math.floor(input.now / REACTION_EPOCH_MS) &&
    input.interval === Math.floor(input.now / REACTION_INTERVAL_MS) &&
    input.interval > input.lastInterval &&
    reporterEligible(input.slot, input.epoch, input.eligibleSlots)
  );
}
