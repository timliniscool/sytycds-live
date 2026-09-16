import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { PROTOCOL_VERSION } from "../shared/domain";
import { createAct } from "../worker/acts";
import { submitAudienceVote } from "../worker/audience-votes";
import { submitJudgeScore } from "../worker/judge-submissions";
import { finaliseResult } from "../worker/results";
import {
  applyScoringConfiguration,
  resetScoringData,
} from "../worker/scoring-config";
import { upsertShow } from "../worker/show-config";
import {
  executeAdminCommand,
  PRIMARY_SHOW_ID,
  projectShowState,
} from "../worker/show-state";

/**
 * The operator's hard reset of votes and scores. Everything that is scoring
 * goes; everything that is the show — acts, running order, judges, settings —
 * stays exactly as built, and the stage is left closed and hidden.
 */
describe("reset all votes and scores", () => {
  it("clears scoring for every act and keeps the show intact", async () => {
    const stub = env.SHOW_COORDINATOR.get(
      env.SHOW_COORDINATOR.idFromName("scoring-reset"),
    );
    await stub.fetch("https://show.internal/health");

    await runInDurableObject(stub, async (_instance, state) => {
      const { storage } = state;
      upsertShow(storage, PRIMARY_SHOW_ID, {
        title: "Reset Check",
        tagline: "",
        shortName: "Reset",
        themeId: "crimson",
        fontFamily: "system-ui",
        reactionsEnabled: false,
      });
      const judges = await applyScoringConfiguration(storage, PRIMARY_SHOW_ID, {
        judgeNames: ["Ada", "Grace"],
        audienceWeight: 0.5,
        reset: false,
        confirm: null,
      });
      expect(judges.ok).toBe(true);
      if (!judges.ok) return;
      const judgeIds = storage.sql
        .exec<{ id: string }>(
          "SELECT id FROM show_judges WHERE show_id = ? AND active = 1 ORDER BY slot",
          PRIMARY_SHOW_ID,
        )
        .toArray()
        .map((row) => row.id);

      const actInput = (name: string) => ({
        performerName: name,
        schoolYear: "Year 9",
        actName: `${name} act`,
        actType: "Dance",
        publicDescription: "",
        internalNotes: "",
        publicImageAssetId: null,
        showDescriptionToAudience: false,
        showImageToAudience: false,
        presentation: {
          actImageAssetId: null,
          performanceMode: "DEFAULT" as const,
          performanceVisualMode: "AUTOMATIC" as const,
          performanceAssetId: null,
          performanceFit: "contain" as const,
          backingAudioAssetId: null,
          backingAudioStart: "MANUAL" as const,
        },
        appearance: { themeId: null, fontFamily: null },
      });
      const first = createAct(storage, PRIMARY_SHOW_ID, actInput("Ana"));
      const second = createAct(storage, PRIMARY_SHOW_ID, actInput("Ben"));
      if (!first || !second) throw new Error("acts not created");

      // Score the first act fully and finalise it.
      const command = (type: string, extras: Record<string, unknown> = {}) => {
        const revision = storage.sql
          .exec<{ revision: number }>(
            "SELECT revision FROM shows WHERE id = ?",
            PRIMARY_SHOW_ID,
          )
          .one().revision;
        return executeAdminCommand(
          storage,
          PRIMARY_SHOW_ID,
          { kind: "admin" },
          {
            type,
            protocolVersion: PROTOCOL_VERSION,
            commandId: `reset-${type}-${revision}`,
            expectedRevision: revision,
            ...extras,
          } as never,
        );
      };
      expect(
        command("SELECT_ACT", { actId: first.id }).acknowledgement.status,
      ).toBe("accepted");
      expect(command("OPEN_ALL_JUDGES").acknowledgement.status).toBe(
        "accepted",
      );
      for (const judgeId of judgeIds) {
        const outcome = submitJudgeScore(
          storage,
          PRIMARY_SHOW_ID,
          judgeId,
          "8",
        );
        expect(outcome.ok).toBe(true);
      }
      expect(command("OPEN_AUDIENCE_VOTING").acknowledgement.status).toBe(
        "accepted",
      );
      const vote = submitAudienceVote(
        storage,
        PRIMARY_SHOW_ID,
        new Uint8Array(32).fill(3).buffer,
        { actIdentifier: first.id, score: 7 },
      );
      expect(vote.ok).toBe(true);
      expect(command("CLOSE_AUDIENCE_VOTING").acknowledgement.status).toBe(
        "accepted",
      );
      expect(finaliseResult(storage.sql, PRIMARY_SHOW_ID, first.id).ok).toBe(
        true,
      );
      expect(
        command("SET_RESULTS_STAGE", { stage: "LEADERBOARD" }).acknowledgement
          .status,
      ).toBe("accepted");

      const before = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "admin",
      });
      expect(before?.role === "admin" && before.ranking.ranked).toHaveLength(1);
      const revisionBefore = storage.sql
        .exec<{ revision: number }>(
          "SELECT revision FROM shows WHERE id = ?",
          PRIMARY_SHOW_ID,
        )
        .one().revision;

      const summary = resetScoringData(storage, PRIMARY_SHOW_ID);
      expect(summary).toEqual({
        audienceVotes: 1,
        judgeScores: 2,
        finalisedResults: 1,
      });

      const after = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "admin",
      });
      if (after?.role !== "admin") throw new Error("expected admin projection");
      // Scoring is gone, the stage is closed and hidden, the revision moved.
      expect(after.ranking.ranked).toHaveLength(0);
      expect(after.judges.every((judge) => judge.submission === null)).toBe(
        true,
      );
      expect(after.judges.every((judge) => judge.permission === "CLOSED")).toBe(
        true,
      );
      expect(after.show.audienceVoteState).toBe("CLOSED");
      expect(after.runtime.resultsStage).toBe("HIDDEN");
      expect(after.show.revision).toBe(revisionBefore + 1);
      expect(after.audienceAggregates).toHaveLength(0);
      // The show itself is untouched: acts, order, current act, judge panel.
      expect(after.acts.map((act) => act.id)).toEqual([first.id, second.id]);
      expect(after.show.activeActId).toBe(first.id);
      expect(after.judges.map((judge) => judge.displayName)).toEqual([
        "Ada",
        "Grace",
      ]);
      // Scoring can start again immediately, including on the finalised act.
      expect(command("OPEN_ALL_JUDGES").acknowledgement.status).toBe(
        "accepted",
      );
      expect(
        submitJudgeScore(storage, PRIMARY_SHOW_ID, judgeIds[0]!, "9").ok,
      ).toBe(true);
    });
  });
});
