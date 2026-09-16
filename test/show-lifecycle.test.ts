import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { PROTOCOL_VERSION, type AudienceScore } from "../shared/domain";
import { createAct, deleteAct, replaceActOrder } from "../worker/acts";
import { submitAudienceVote } from "../worker/audience-votes";
import { createCue, replaceCueOrder, type CueInput } from "../worker/cues";
import { submitJudgeScore } from "../worker/judge-submissions";
import { updateMediaMetadata, uploadMediaAsset } from "../worker/media-assets";
import { applyScoringConfiguration } from "../worker/scoring-config";
import {
  executeAdminCommand,
  PRIMARY_SHOW_ID,
  projectShowState,
} from "../worker/show-state";
import { upsertShow } from "../worker/show-config";
import { resetShow } from "../worker/show-reset";

/**
 * This is the dress-rehearsal path on a fresh, isolated Durable Object. It is
 * deliberately one test so every step consumes the real state left by the
 * previous step, including persisted revisions and immutable submissions.
 */
describe("zero-act show lifecycle", () => {
  it("runs setup through public reveal and verifies every safety override", async () => {
    const stub = env.SHOW_COORDINATOR.get(
      env.SHOW_COORDINATOR.idFromName("prompt-2-isolated-lifecycle"),
    );
    await stub.fetch("https://show.internal/health");

    await runInDurableObject(stub, async (_instance, state) => {
      const { storage } = state;
      upsertShow(storage, PRIMARY_SHOW_ID, {
        title: "SYTYCDS Dress Rehearsal",
        tagline: "One hall. One live show.",
        shortName: "Dress Rehearsal",
        themeId: "crimson",
        fontFamily: "system-ui",
        reactionsEnabled: true,
      });

      const empty = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "admin",
      });
      expect(empty?.role === "admin" && empty.acts).toHaveLength(0);

      const configured = await applyScoringConfiguration(
        storage,
        PRIMARY_SHOW_ID,
        {
          judgeNames: Array.from(
            { length: 4 },
            (_, index) => `Judge ${index + 1}`,
          ),
          audienceWeight: 0.5,
          reset: false,
          confirm: null,
        },
      );
      expect(configured.ok && configured.issued).toHaveLength(4);

      const upload = async (
        filename: string,
        mimeType: string,
        bytes: readonly number[],
      ) => {
        const result = await uploadMediaAsset(
          storage,
          env.MEDIA,
          PRIMARY_SHOW_ID,
          new Request("https://show.test/api/admin/media", {
            method: "POST",
            headers: {
              "Content-Type": mimeType,
              "Content-Length": String(bytes.length),
            },
            body: new Uint8Array(bytes),
          }),
          filename,
        );
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.error);
        return result.asset;
      };
      // Minimal generated fixtures take the same streaming upload → R2 → SQL
      // path as the editor. Decoding is a projector/browser responsibility.
      const poster = await upload(
        "poster.png",
        "image/png",
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      );
      const track = await upload(
        "backing.mp3",
        "audio/mpeg",
        [0x49, 0x44, 0x33, 0x04, 0x00, 0x00],
      );
      const video = await upload(
        "visual.mp4",
        "video/mp4",
        [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70],
      );
      expect(
        updateMediaMetadata(storage, PRIMARY_SHOW_ID, poster.id, {
          durationMs: null,
          width: 1280,
          height: 720,
        }),
      ).toBe(true);
      expect(
        updateMediaMetadata(storage, PRIMARY_SHOW_ID, track.id, {
          durationMs: 90_000,
          width: null,
          height: null,
        }),
      ).toBe(true);
      expect(
        updateMediaMetadata(storage, PRIMARY_SHOW_ID, video.id, {
          durationMs: 12_000,
          width: 1920,
          height: 1080,
        }),
      ).toBe(true);

      const act = createAct(storage, PRIMARY_SHOW_ID, {
        performerName: "Alex Rivera",
        schoolYear: "Year 11",
        actName: "Orbit",
        actType: "Contemporary dance",
        publicDescription: "A live movement piece.",
        internalNotes: "Stand by stage left at LX 12.",
        publicImageAssetId: poster.id,
        showDescriptionToAudience: false,
        showImageToAudience: false,
        presentation: {
          actImageAssetId: null,
          performanceMode: "DEFAULT",
          performanceVisualMode: "AUTOMATIC",
          performanceAssetId: null,
          performanceFit: "contain",
          backingAudioAssetId: null,
          backingAudioStart: "MANUAL",
        },
        appearance: { themeId: null, fontFamily: null },
      });
      const secondAct = createAct(storage, PRIMARY_SHOW_ID, {
        performerName: "Stage Band",
        schoolYear: "Years 9–12",
        actName: "Finale",
        actType: "Music",
        publicDescription: "The closing number.",
        internalNotes: "Confirm all microphones before standby.",
        showDescriptionToAudience: false,
        showImageToAudience: false,
        presentation: {
          actImageAssetId: null,
          performanceMode: "DEFAULT",
          performanceVisualMode: "AUTOMATIC",
          performanceAssetId: null,
          performanceFit: "contain",
          backingAudioAssetId: null,
          backingAudioStart: "MANUAL",
        },
        appearance: { themeId: null, fontFamily: null },
      });
      expect(act).not.toBeNull();
      expect(secondAct).not.toBeNull();
      if (!act || !secondAct) return;
      expect(
        replaceActOrder(storage, PRIMARY_SHOW_ID, [secondAct.id, act.id]),
      ).toBe(true);
      expect(
        createCue(storage, PRIMARY_SHOW_ID, secondAct.id, {
          operatorLabel: "Disposable title card",
          internalNote: "Removed with the incomplete act",
          operations: [
            {
              kind: "visual",
              visual: {
                kind: "TITLE_CARD",
                sourceKey: null,
                title: "Finale",
              },
            },
          ],
        }),
      ).not.toBeNull();

      const cueInput: CueInput = {
        operatorLabel: "Orbit opening picture + track",
        internalNote: "GO after house clears",
        operations: [
          {
            kind: "visual",
            visual: {
              kind: "IMAGE",
              sourceKey: poster.id,
              title: null,
              fit: "contain",
            },
          },
          { kind: "audio", action: "PLAY", assetId: track.id },
        ],
      };
      const cue = createCue(storage, PRIMARY_SHOW_ID, act.id, cueInput);
      expect(cue).not.toBeNull();
      if (!cue) return;
      const pauseCue = createCue(storage, PRIMARY_SHOW_ID, act.id, {
        operatorLabel: "Pause backing track",
        internalNote: "Hold for applause",
        operations: [{ kind: "audio", action: "PAUSE" }],
      });
      const videoCue = createCue(storage, PRIMARY_SHOW_ID, act.id, {
        operatorLabel: "Change to film",
        internalNote: "Audio must continue",
        operations: [
          {
            kind: "visual",
            visual: {
              kind: "VIDEO",
              sourceKey: video.id,
              title: null,
            },
          },
        ],
      });
      expect(pauseCue).not.toBeNull();
      expect(videoCue).not.toBeNull();
      if (!pauseCue || !videoCue) return;
      expect(
        replaceCueOrder(storage, PRIMARY_SHOW_ID, act.id, [
          cue,
          videoCue,
          pauseCue,
        ]),
      ).toBe(true);

      let sequence = 0;
      const command = (
        type: string,
        extras: Readonly<Record<string, unknown>> = {},
      ) => {
        const revision = storage.sql
          .exec<{ revision: number }>(
            "SELECT revision FROM shows WHERE id = ?",
            PRIMARY_SHOW_ID,
          )
          .one().revision;
        sequence += 1;
        const outcome = executeAdminCommand(
          storage,
          PRIMARY_SHOW_ID,
          { kind: "admin" },
          {
            type,
            protocolVersion: PROTOCOL_VERSION,
            commandId: `lifecycle-${sequence}`,
            expectedRevision: revision,
            ...extras,
          },
        );
        expect(outcome.acknowledgement.status).toBe("accepted");
        return outcome;
      };

      command("SELECT_ACT", { actId: act.id });
      command("SET_DISPLAY_MODE", { mode: "PERFORMANCE" });
      command("PREPARE_CUE", { cueId: cue });
      command("PLAY_CUE", { cueId: cue });
      command("PLAY_CUE", { cueId: videoCue });
      const layered = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "projector",
      });
      expect(layered?.role === "projector" && layered.runtime).toMatchObject({
        activeVisualCueId: videoCue,
        activeAudioCueId: cue,
        audioTransport: "PLAYING",
      });
      command("PLAY_CUE", { cueId: pauseCue });
      command("RESUME_MEDIA");

      command("SET_DISPLAY_MODE", { mode: "HOLD" });
      let live = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "projector",
      });
      expect(live?.role === "projector" && live.runtime.audioTransport).toBe(
        "PLAYING",
      );
      command("RESTORE_DISPLAY");

      command("ACTIVATE_EMERGENCY", { presentation: "TEXT" });
      live = projectShowState(storage, PRIMARY_SHOW_ID, { kind: "projector" });
      expect(live?.role === "projector" && live.runtime.audioTransport).toBe(
        "PAUSED",
      );
      expect(live?.role === "projector" && live.show.displayMode).toBe(
        "EMERGENCY",
      );
      command("RESTORE_DISPLAY");
      command("RESUME_MEDIA");
      command("BLACK_SCREEN");
      live = projectShowState(storage, PRIMARY_SHOW_ID, { kind: "projector" });
      expect(live?.role === "projector" && live.runtime.blackScreen).toBe(true);
      expect(live?.role === "projector" && live.runtime.audioTransport).toBe(
        "PLAYING",
      );
      command("STOP_ALL_MEDIA");
      live = projectShowState(storage, PRIMARY_SHOW_ID, { kind: "projector" });
      expect(live?.role === "projector" && live.runtime).toMatchObject({
        activeVisualCueId: null,
        activeAudioCueId: null,
        visualTransport: "STOPPED",
        audioTransport: "STOPPED",
        // STOP ALL stops transports; the blackout override stays until lifted.
        blackScreen: true,
      });
      command("BLACK_SCREEN");
      live = projectShowState(storage, PRIMARY_SHOW_ID, { kind: "projector" });
      expect(live?.role === "projector" && live.runtime.blackScreen).toBe(
        false,
      );

      command("OPEN_AUDIENCE_VOTING");
      expect(
        submitAudienceVote(
          storage,
          PRIMARY_SHOW_ID,
          new Uint8Array(32).fill(7).buffer,
          { actIdentifier: act.id, score: 8 as AudienceScore },
        ),
      ).toMatchObject({ ok: true });
      command("CLOSE_AUDIENCE_VOTING");
      command("OPEN_ALL_JUDGES");

      const judgeIds = storage.sql
        .exec<{ id: string }>(
          "SELECT id FROM show_judges WHERE show_id = ? AND active = 1 ORDER BY slot",
          PRIMARY_SHOW_ID,
        )
        .toArray()
        .map((judge) => judge.id);
      for (const [index, score] of ["8", "π", "20", "Infinity"].entries()) {
        expect(
          submitJudgeScore(storage, PRIMARY_SHOW_ID, judgeIds[index]!, score),
        ).toMatchObject({ ok: true, accepted: true });
      }
      command("CLOSE_ALL_JUDGES");
      command("FINALISE_RESULT");

      const hidden = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "audience",
      });
      expect(hidden?.role === "audience" && hidden.revealedResult).toBeNull();
      command("REVEAL_RESULT");

      const audience = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "audience",
      });
      const projector = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "projector",
      });
      const admin = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "admin",
      });
      expect(
        audience?.role === "audience" && audience.revealedResult,
      ).toBeCloseTo(8.6426990817);
      expect(projector?.role === "projector" && projector.revealedResult).toBe(
        audience?.role === "audience" ? audience.revealedResult : null,
      );
      expect(JSON.stringify(audience)).not.toContain("stage left");
      expect(JSON.stringify(projector)).not.toContain("GO after");
      expect(JSON.stringify(admin)).toContain("stage left");
      expect(JSON.stringify(admin)).toContain("GO after");

      // Deleting an act takes its cues with it in one transaction.
      const removed = deleteAct(storage, PRIMARY_SHOW_ID, secondAct.id);
      expect(removed.ok).toBe(true);
      expect(
        storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM cues WHERE act_id = ?",
            secondAct.id,
          )
          .one().count,
      ).toBe(0);

      // The rehearsal finishes with the operator's own full-reset path: the
      // event's performance data goes, its setup stays.
      expect(
        await resetShow(storage, env.MEDIA, PRIMARY_SHOW_ID),
      ).toMatchObject({ mediaCleanupComplete: true });
      const afterReset = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "admin",
      });
      expect(afterReset?.role === "admin" && afterReset.acts).toEqual([]);
      expect(afterReset?.role === "admin" && afterReset.show.displayMode).toBe(
        "LOBBY",
      );
      expect(
        storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM media_assets")
          .one().count,
      ).toBe(0);
    });
  });
});
