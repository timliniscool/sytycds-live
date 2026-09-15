import {
  REACTION_IDS,
  capReactionHistogram,
  reporterFlushDue,
  type ReactionHistogram,
  type ReactionId,
} from "../../shared/reactions";

export interface ReactionSamplingConfiguration {
  slot: number;
  serverOffsetMs: number;
  epochMs: number;
  intervalMs: number;
  eligibleSlots: number;
}

/** Taps are strictly local; only an eligible five-second flush returns a packet. */
export class ReactionReporter {
  private counts = [0, 0, 0, 0, 0];
  private lastInterval = -1;

  tap(id: ReactionId): void {
    const index = REACTION_IDS.indexOf(id);
    if (index >= 0) this.counts[index] = (this.counts[index] ?? 0) + 1;
  }

  flush(
    localNow: number,
    config: ReactionSamplingConfiguration,
  ): { epoch: number; interval: number; histogram: ReactionHistogram } | null {
    const serverNow = localNow + config.serverOffsetMs;
    const epoch = Math.floor(serverNow / config.epochMs);
    const interval = Math.floor(serverNow / config.intervalMs);
    if (
      interval === this.lastInterval ||
      !reporterFlushDue(
        config.slot,
        epoch,
        serverNow,
        config.intervalMs,
        config.eligibleSlots,
      )
    )
      return null;
    const histogram = capReactionHistogram(this.counts);
    this.counts = [0, 0, 0, 0, 0];
    this.lastInterval = interval;
    return histogram && histogram.some((count) => count > 0)
      ? { epoch, interval, histogram }
      : null;
  }
}
