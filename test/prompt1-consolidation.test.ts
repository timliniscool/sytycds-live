/**
 * Architecture consolidation: the show flow engine (GO), the between-events
 * reset, the Act Media Library, projector arming on the first click,
 * authoritative presence and the procedural test-show generator. Each test
 * names the behaviour a stage crew relies on, not the code that provides it.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_SHOW_FLOW_POLICY,
  PROTOCOL_VERSION,
  showRevision,
} from "../shared/domain";
import { serialiseServerMessage } from "../shared/protocol";
import {
  TEST_SCENARIOS,
  chooseScenario,
  createTestSeed,
  generateTestShowPlan,
  seededRandom,
} from "../shared/test-show";
import { ProjectorMediaEngine } from "../src/projector/MediaEngine";
import {
  RealtimeClient,
  type WebSocketLike,
} from "../src/realtime/RealtimeClient";
import {
  createAct,
  deleteAct,
  editAct,
  parseActInput,
  previewActDeletion,
} from "../worker/acts";
import { createCue, cueValidationState, parseCueInput } from "../worker/cues";
import {
  deleteMediaAsset,
  listMediaAssets,
  uploadMediaAsset,
} from "../worker/media-assets";
import { applyScoringConfiguration } from "../worker/scoring-config";
import { parseShowInput, upsertShow } from "../worker/show-config";
import { resetShow } from "../worker/show-reset";
import {
  PRIMARY_SHOW_ID,
  executeAdminCommand,
  loadFlowState,
  projectShowState,
} from "../worker/show-state";
import {
  generateTestShow,
  syntheticPng,
  syntheticWav,
} from "../worker/test-show";

const NOW = "2026-09-16T00:00:00.000Z";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withShow(
  name: string,
  test: (storage: DurableObjectStorage) => void | Promise<void>,
): Promise<void> {
  const stub = env.SHOW_COORDINATOR.get(env.SHOW_COORDINATOR.idFromName(name));
  await stub.fetch("https://show.internal/health");
  await runInDurableObject(stub, async (_instance, state) => {
    await test(state.storage);
  });
}

function revision(storage: DurableObjectStorage): number {
  return storage.sql
    .exec<{ revision: number }>(
      "SELECT revision FROM shows WHERE id = ?",
      PRIMARY_SHOW_ID,
    )
    .one().revision;
}

function command(
  storage: DurableObjectStorage,
  type: string,
  extras: Record<string, unknown> = {},
) {
  return executeAdminCommand(
    storage,
    PRIMARY_SHOW_ID,
    { kind: "admin" },
    {
      type,
      protocolVersion: PROTOCOL_VERSION,
      commandId: `cmd-${crypto.randomUUID()}`,
      expectedRevision: revision(storage),
      ...extras,
    },
  );
}

function show(storage: DurableObjectStorage) {
  return storage.sql
    .exec<{
      display_mode: string;
      audience_vote_state: string;
      active_act_id: string | null;
    }>(
      "SELECT display_mode, audience_vote_state, active_act_id FROM shows WHERE id = ?",
      PRIMARY_SHOW_ID,
    )
    .one();
}

function runtime(storage: DurableObjectStorage) {
  return storage.sql
    .exec<{
      flow_step: string | null;
      visual_transport: string;
      audio_transport: string;
      global_judge_permission: string;
      active_visual_cue_id: string | null;
    }>(
      `SELECT flow_step, visual_transport, audio_transport, global_judge_permission,
              active_visual_cue_id FROM show_runtime WHERE show_id = ?`,
      PRIMARY_SHOW_ID,
    )
    .one();
}

function seedAsset(
  storage: DurableObjectStorage,
  id: string,
  mimeType: string,
  actId: string | null = null,
): void {
  storage.sql.exec(
    `INSERT INTO media_assets (
      id, show_id, object_key, original_filename, mime_type, size_bytes,
      version_identifier, duration_ms, width, height, uploaded_at, deleted_at,
      act_id, generated_test, test_show_id
    ) VALUES (?, ?, ?, ?, ?, 1024, 'v1', NULL, NULL, NULL, ?, NULL, ?, 0, NULL)`,
    id,
    PRIMARY_SHOW_ID,
    `primary/${id}`,
    `${id}.file`,
    mimeType,
    NOW,
    actId,
  );
}

function actInput(overrides: Record<string, unknown> = {}) {
  const parsed = parseActInput({
    performerName: "Performer",
    schoolYear: "Year 10",
    actName: "Act",
    actType: "Music",
    publicDescription: "",
    internalNotes: "",
    publicImageAssetId: null,
    showDescriptionToAudience: false,
    showImageToAudience: false,
    presentation: {
      performanceVisualMode: "AUTOMATIC",
      performanceAssetId: null,
      performanceFit: "contain",
      backingAudioAssetId: null,
      backingAudioStart: "MANUAL",
    },
    ...overrides,
  });
  if (!parsed) throw new Error("Test fixture is not a valid act");
  return parsed;
}

async function seedShowWithJudges(
  storage: DurableObjectStorage,
  judgeCount = 2,
): Promise<void> {
  upsertShow(storage, PRIMARY_SHOW_ID, { title: "Show", tagline: "" });
  const configured = await applyScoringConfiguration(storage, PRIMARY_SHOW_ID, {
    judgeNames: Array.from(
      { length: judgeCount },
      (_, index) => `J${index + 1}`,
    ),
    audienceWeight: 0.5,
    reset: false,
    confirm: null,
  });
  if (!configured.ok) throw new Error(configured.reason);
}

/** A small in-memory R2 with the four calls the coordinator makes. */
function fakeBucket(initial: Record<string, number> = {}) {
  const objects = new Map<string, number>(Object.entries(initial));
  const deleted: string[] = [];
  const bucket = {
    put: async (key: string, body: unknown) => {
      const bytes =
        body instanceof Uint8Array
          ? body
          : new Uint8Array(await new Response(body as BodyInit).arrayBuffer());
      objects.set(key, bytes.byteLength);
      return { size: bytes.byteLength, version: `v-${key}` };
    },
    delete: async (key: string) => {
      objects.delete(key);
      deleted.push(key);
    },
    head: async (key: string) => (objects.has(key) ? { key } : null),
    list: async (options?: { prefix?: string }) => ({
      objects: [...objects.entries()]
        .filter(([key]) => key.startsWith(options?.prefix ?? ""))
        .map(([key, size]) => ({ key, size })),
      truncated: false as const,
    }),
  } as unknown as R2Bucket;
  return { bucket, objects, deleted };
}

// ---------------------------------------------------------------------------
// Show flow engine
// ---------------------------------------------------------------------------

describe("show flow engine (GO)", () => {
  it("walks an ordinary act with one GO per step and says what each GO will do", async () => {
    await withShow("flow-basic", async (storage) => {
      await seedShowWithJudges(storage);
      seedAsset(storage, "asset-visual", "image/png");
      seedAsset(storage, "asset-audio", "audio/mpeg");
      const first = createAct(
        storage,
        PRIMARY_SHOW_ID,
        actInput({
          actName: "Opener",
          presentation: {
            performanceVisualMode: "IMAGE",
            performanceAssetId: "asset-visual",
            performanceFit: "contain",
            backingAudioAssetId: "asset-audio",
            backingAudioStart: "PERFORMANCE",
          },
        }),
      )!;
      const second = createAct(
        storage,
        PRIMARY_SHOW_ID,
        actInput({ actName: "Closer" }),
      )!;

      // Nothing selected: GO says it will select the first act.
      let flow = loadFlowState(storage.sql, PRIMARY_SHOW_ID)!;
      expect(flow).toMatchObject({
        step: null,
        blocked: null,
        next: { kind: "first_act", actId: first.id },
      });

      // GO → first act on its card.
      expect(command(storage, "ADVANCE_SHOW").acknowledgement.status).toBe(
        "accepted",
      );
      expect(show(storage)).toMatchObject({
        active_act_id: first.id,
        display_mode: "ACT_CARD",
      });
      expect(runtime(storage).flow_step).toBe("ACT_CARD");
      flow = loadFlowState(storage.sql, PRIMARY_SHOW_ID)!;
      expect(flow.next).toEqual({ kind: "step", step: "PERFORMANCE" });

      // GO → PERFORMANCE: visual up and the backing track started, because
      // the act asked for it to start with the performance.
      command(storage, "ADVANCE_SHOW");
      expect(show(storage).display_mode).toBe("PERFORMANCE");
      expect(runtime(storage)).toMatchObject({
        flow_step: "PERFORMANCE",
        visual_transport: "PLAYING",
        audio_transport: "PLAYING",
      });

      // GO → SCORING: media ends, the act card returns, judges open, and
      // audience voting stays closed because the default policy says so.
      command(storage, "ADVANCE_SHOW");
      expect(show(storage)).toMatchObject({
        display_mode: "ACT_CARD",
        audience_vote_state: "CLOSED",
      });
      expect(runtime(storage)).toMatchObject({
        flow_step: "SCORING",
        visual_transport: "STOPPED",
        audio_transport: "STOPPED",
        active_visual_cue_id: null,
        global_judge_permission: "OPEN",
      });
      const judges = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "admin",
      });
      expect(
        judges?.role === "admin" &&
          judges.judges.every((judge) => judge.permission === "OPEN"),
      ).toBe(true);

      // GO → SCOREBOARD.
      command(storage, "ADVANCE_SHOW");
      expect(show(storage).display_mode).toBe("SCOREBOARD");
      expect(runtime(storage).flow_step).toBe("SCOREBOARD");

      // Voting open blocks moving on; the reason is the same one shown on GO.
      command(storage, "OPEN_AUDIENCE_VOTING");
      flow = loadFlowState(storage.sql, PRIMARY_SHOW_ID)!;
      expect(flow.blocked).toContain("Close audience voting");
      const blocked = command(storage, "ADVANCE_SHOW");
      expect(blocked.acknowledgement).toMatchObject({
        status: "rejected",
        reason: flow.blocked,
      });
      command(storage, "CLOSE_AUDIENCE_VOTING");

      // GO → next act's card, reveal hidden, flow restarted.
      command(storage, "ADVANCE_SHOW");
      expect(show(storage)).toMatchObject({
        active_act_id: second.id,
        display_mode: "ACT_CARD",
      });
      expect(runtime(storage).flow_step).toBe("ACT_CARD");

      // At the end of the running order GO refuses rather than guessing.
      command(storage, "SET_SHOW_STEP", { step: "SCOREBOARD" });
      flow = loadFlowState(storage.sql, PRIMARY_SHOW_ID)!;
      expect(flow.next).toEqual({ kind: "end" });
      expect(flow.blocked).toContain("End of the running order");
      expect(command(storage, "ADVANCE_SHOW").acknowledgement.status).toBe(
        "rejected",
      );
    });
  });

  it("keeps the flow consistent with direct display and act changes", async () => {
    await withShow("flow-consistency", async (storage) => {
      await seedShowWithJudges(storage);
      const act = createAct(storage, PRIMARY_SHOW_ID, actInput())!;
      command(storage, "SELECT_ACT", { actId: act.id });
      expect(runtime(storage).flow_step).toBeNull();
      // A manual SCOREBOARD is a flow step too, so GO afterwards means next act.
      command(storage, "SET_DISPLAY_MODE", { mode: "SCOREBOARD" });
      expect(runtime(storage).flow_step).toBe("SCOREBOARD");
      // Jumping straight to SCORING opens the judges and stops nothing else.
      expect(
        command(storage, "SET_SHOW_STEP", { step: "SCORING" }).acknowledgement
          .status,
      ).toBe("accepted");
      expect(runtime(storage)).toMatchObject({
        flow_step: "SCORING",
        global_judge_permission: "OPEN",
      });
      // Intermission is not a step: the flow forgets its position.
      command(storage, "SET_DISPLAY_MODE", { mode: "INTERMISSION" });
      expect(runtime(storage).flow_step).toBeNull();
      // Emergency blocks GO until the show is restored.
      command(storage, "ACTIVATE_EMERGENCY", { presentation: "BLACK" });
      expect(loadFlowState(storage.sql, PRIMARY_SHOW_ID)?.blocked).toContain(
        "EMERGENCY",
      );
      expect(command(storage, "ADVANCE_SHOW").acknowledgement.status).toBe(
        "rejected",
      );
    });
  });

  it("follows the show's GO policy: voting on scoring, and no scoreboard step", async () => {
    await withShow("flow-policy", async (storage) => {
      await seedShowWithJudges(storage);
      upsertShow(storage, PRIMARY_SHOW_ID, {
        ...parseShowInput({
          title: "Show",
          tagline: "",
          flowPolicy: {
            openVotingOnScoring: true,
            scoreboardStep: false,
          },
        })!,
      });
      const a = createAct(storage, PRIMARY_SHOW_ID, actInput())!;
      const b = createAct(storage, PRIMARY_SHOW_ID, actInput())!;
      command(storage, "SELECT_ACT", { actId: a.id });
      command(storage, "SET_SHOW_STEP", { step: "PERFORMANCE" });
      command(storage, "ADVANCE_SHOW");
      // Policy opened voting with SCORING.
      expect(show(storage).audience_vote_state).toBe("OPEN");
      expect(runtime(storage).flow_step).toBe("SCORING");
      // Without a scoreboard step the next GO is the next act, once voting is
      // closed — closing is never automatic.
      let flow = loadFlowState(storage.sql, PRIMARY_SHOW_ID)!;
      expect(flow.next).toMatchObject({ kind: "next_act", actId: b.id });
      expect(flow.blocked).toContain("Close audience voting");
      command(storage, "CLOSE_AUDIENCE_VOTING");
      flow = loadFlowState(storage.sql, PRIMARY_SHOW_ID)!;
      expect(flow.blocked).toBeNull();
      command(storage, "ADVANCE_SHOW");
      expect(show(storage).active_act_id).toBe(b.id);
    });
  });

  it("keeps the stored GO policy when a client saves the show without it", async () => {
    await withShow("flow-policy-merge", async (storage) => {
      upsertShow(storage, PRIMARY_SHOW_ID, {
        ...parseShowInput({
          title: "Show",
          tagline: "",
          flowPolicy: { openVotingOnScoring: true },
        })!,
      });
      // An older client that only knows about the title.
      upsertShow(storage, PRIMARY_SHOW_ID, { title: "Renamed", tagline: "" });
      const projection = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "admin",
      });
      expect(projection?.role === "admin" && projection.show).toMatchObject({
        title: "Renamed",
        flowPolicy: { ...DEFAULT_SHOW_FLOW_POLICY, openVotingOnScoring: true },
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Act Media Library
// ---------------------------------------------------------------------------

describe("act media library", () => {
  it("uploads into one act's library and lets every slot reference the same asset", async () => {
    await withShow("library-upload", async (storage) => {
      await seedShowWithJudges(storage);
      const r2 = fakeBucket();
      const act = createAct(storage, PRIMARY_SHOW_ID, actInput())!;
      const upload = await uploadMediaAsset(
        storage,
        r2.bucket,
        PRIMARY_SHOW_ID,
        new Request("https://show.test/api/admin/media", {
          method: "POST",
          headers: { "Content-Type": "image/png", "Content-Length": "4" },
          body: new Uint8Array([1, 2, 3, 4]),
        }),
        "portrait.png",
        { actId: act.id },
      );
      expect(upload.ok && upload.asset).toMatchObject({
        kind: "image",
        actId: act.id,
        readiness: "UPLOADED",
        referenced: false,
        generatedTest: false,
      });
      const assetId = upload.ok ? upload.asset.id : "";

      // The same file is the act image, the performance visual and a cue.
      expect(
        editAct(
          storage,
          PRIMARY_SHOW_ID,
          act.id,
          actInput({
            presentation: {
              actImageAssetId: assetId,
              performanceVisualMode: "IMAGE",
              performanceAssetId: assetId,
              performanceFit: "cover",
              backingAudioAssetId: null,
              backingAudioStart: "MANUAL",
            },
          }),
        ),
      ).toBe(true);
      const cue = createCue(
        storage,
        PRIMARY_SHOW_ID,
        act.id,
        parseCueInput({
          operatorLabel: "Slide",
          internalNote: "",
          operations: [
            {
              kind: "visual",
              visual: { kind: "IMAGE", sourceKey: assetId, title: null },
            },
          ],
        })!,
      );
      expect(cue).not.toBeNull();

      const library = listMediaAssets(storage.sql, PRIMARY_SHOW_ID, act.id);
      expect(library).toHaveLength(1);
      expect(
        library[0]?.references.map((reference) => reference.kind).sort(),
        // The derived PERFORMANCE cue and the operator's own cue both count.
      ).toEqual(["act_image", "cue", "cue", "performance_visual"]);
      // One source of truth: the derived cue and the operator's cue both
      // resolve to the very same asset the act names.
      const projection = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "admin",
      });
      const stored = projection?.role === "admin" ? projection.acts[0] : null;
      expect(stored?.presentation).toMatchObject({
        actImageAssetId: assetId,
        performanceVisualMode: "IMAGE",
        performanceAssetId: assetId,
      });
      expect(
        stored?.cues.every((entry) =>
          entry.operations.some(
            (operation) =>
              operation.kind === "visual" &&
              operation.visual.sourceKey === assetId,
          ),
        ),
      ).toBe(true);
      // In use: cannot be deleted from underneath the act.
      expect(
        await deleteMediaAsset(storage, r2.bucket, PRIMARY_SHOW_ID, assetId),
      ).toBe("referenced");
    });
  });

  it("refuses a visual mode that does not match the file, and derives the mode from the file", async () => {
    await withShow("library-modes", async (storage) => {
      await seedShowWithJudges(storage);
      seedAsset(storage, "asset-image", "image/png");
      seedAsset(storage, "asset-video", "video/mp4");
      const act = createAct(storage, PRIMARY_SHOW_ID, actInput())!;
      // An image chosen as a video is a mistake the server refuses.
      expect(
        editAct(
          storage,
          PRIMARY_SHOW_ID,
          act.id,
          actInput({
            presentation: {
              performanceVisualMode: "VIDEO",
              performanceAssetId: "asset-image",
              performanceFit: "contain",
              backingAudioAssetId: null,
              backingAudioStart: "MANUAL",
            },
          }),
        ),
      ).toBe(false);
      expect(
        editAct(
          storage,
          PRIMARY_SHOW_ID,
          act.id,
          actInput({
            presentation: {
              performanceVisualMode: "VIDEO",
              performanceAssetId: "asset-video",
              performanceFit: "contain",
              backingAudioAssetId: null,
              backingAudioStart: "MANUAL",
            },
          }),
        ),
      ).toBe(true);
      const projection = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "admin",
      });
      expect(
        projection?.role === "admin" && projection.acts[0]?.presentation,
      ).toMatchObject({
        performanceVisualMode: "VIDEO",
        performanceMode: "CUSTOM",
      });
      // The legacy vocabulary still works: CUSTOM + an image is IMAGE.
      const legacy = parseActInput({
        ...actInput(),
        presentation: {
          performanceMode: "CUSTOM",
          performanceAssetId: "asset-image",
          performanceFit: "contain",
          backingAudioAssetId: null,
          backingAudioStart: "MANUAL",
        },
      });
      expect(legacy?.presentation.performanceVisualMode).toBe("IMAGE");
    });
  });

  it("shows a shared file in both libraries and protects it when one act goes", async () => {
    await withShow("library-shared", async (storage) => {
      await seedShowWithJudges(storage);
      const owner = createAct(
        storage,
        PRIMARY_SHOW_ID,
        actInput({ actName: "A" }),
      )!;
      const borrower = createAct(
        storage,
        PRIMARY_SHOW_ID,
        actInput({ actName: "B" }),
      )!;
      seedAsset(storage, "asset-track", "audio/mpeg", owner.id);
      seedAsset(storage, "asset-unused", "image/png", owner.id);
      // A show-level asset from before ownership existed, referenced by B.
      seedAsset(storage, "asset-legacy", "image/png", null);
      for (const id of [owner.id, borrower.id]) {
        editAct(
          storage,
          PRIMARY_SHOW_ID,
          id,
          actInput({
            publicImageAssetId: id === borrower.id ? "asset-legacy" : null,
            presentation: {
              performanceVisualMode: "AUTOMATIC",
              performanceAssetId: null,
              performanceFit: "contain",
              backingAudioAssetId: "asset-track",
              backingAudioStart: "MANUAL",
            },
          }),
        );
      }
      const ownerLibrary = listMediaAssets(
        storage.sql,
        PRIMARY_SHOW_ID,
        owner.id,
      ).map((asset) => asset.id);
      const borrowerLibrary = listMediaAssets(
        storage.sql,
        PRIMARY_SHOW_ID,
        borrower.id,
      ).map((asset) => asset.id);
      expect(ownerLibrary.sort()).toEqual(["asset-track", "asset-unused"]);
      // B's library: the shared track it references, plus the legacy show
      // asset it references — no re-upload was needed for either.
      expect(borrowerLibrary.sort()).toEqual(["asset-legacy", "asset-track"]);

      // Deleting the owner releases only what nobody else uses: the unused
      // upload goes, the shared track stays and becomes a show asset.
      const preview = previewActDeletion(
        storage.sql,
        PRIMARY_SHOW_ID,
        owner.id,
      );
      expect(
        preview.ok && preview.preview.releasedAssets.map((a) => a.id),
      ).toEqual(["asset-unused"]);
      expect(
        preview.ok && preview.preview.sharedAssets.map((a) => a.id),
      ).toEqual(["asset-track"]);
      expect(deleteAct(storage, PRIMARY_SHOW_ID, owner.id).ok).toBe(true);
      expect(
        storage.sql
          .exec<{ id: string; act_id: string | null }>(
            "SELECT id, act_id FROM media_assets WHERE show_id = ? ORDER BY id",
            PRIMARY_SHOW_ID,
          )
          .toArray(),
      ).toEqual([
        { id: "asset-legacy", act_id: null },
        { id: "asset-track", act_id: null },
      ]);
    });
  });

  it("keeps advanced cues compatible: they reference library assets and validate against them", async () => {
    await withShow("library-cues", async (storage) => {
      await seedShowWithJudges(storage);
      const act = createAct(storage, PRIMARY_SHOW_ID, actInput())!;
      seedAsset(storage, "asset-audio", "audio/mpeg", act.id);
      expect(
        cueValidationState(storage.sql, PRIMARY_SHOW_ID, [
          { kind: "audio", action: "LOAD", assetId: "asset-audio" },
          {
            kind: "visual",
            visual: { kind: "VIDEO", sourceKey: "asset-audio", title: null },
          },
        ]),
      ).toBe("INCOMPATIBLE_MEDIA");
      expect(
        cueValidationState(storage.sql, PRIMARY_SHOW_ID, [
          { kind: "audio", action: "LOAD", assetId: "asset-missing" },
        ]),
      ).toBe("MISSING_MEDIA");
      const cue = createCue(
        storage,
        PRIMARY_SHOW_ID,
        act.id,
        parseCueInput({
          operatorLabel: "Track in",
          internalNote: "",
          operations: [
            { kind: "audio", action: "LOAD", assetId: "asset-audio" },
          ],
        })!,
      );
      expect(cue).not.toBeNull();
      const library = listMediaAssets(storage.sql, PRIMARY_SHOW_ID, act.id);
      expect(library[0]?.references).toEqual([
        { kind: "cue", actId: act.id, cueId: cue },
      ]);
    });
  });
});

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

describe("RESET ENTIRE SHOW", () => {
  it("clears event data and media while retaining venue configuration", async () => {
    await withShow("reset-defaults", async (storage) => {
      const r2 = fakeBucket({ "primary/asset-stranded": 99 });
      upsertShow(storage, PRIMARY_SHOW_ID, {
        title: "Big Night",
        tagline: "Tag",
        shortName: "BN",
        themeId: "crimson",
        fontFamily: "Fancy Display",
        reactionsEnabled: false,
        flowPolicy: { ...DEFAULT_SHOW_FLOW_POLICY, openVotingOnScoring: true },
      });
      // A generated test show, complete with fixtures under its own prefix.
      const generated = await generateTestShow(
        storage,
        r2.bucket,
        PRIMARY_SHOW_ID,
        { seed: "0000BEEF", scenario: "media-heavy" },
      );
      expect(generated.assets).toBeGreaterThan(0);
      expect(
        [...r2.objects.keys()].some((key) => key.startsWith("test-shows/")),
      ).toBe(true);
      const beforeReset = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "admin",
      });
      if (beforeReset?.role !== "admin") throw new Error("expected admin");

      const result = await resetShow(storage, r2.bucket, PRIMARY_SHOW_ID);
      expect(result.mediaCleanupComplete).toBe(true);
      const projection = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "admin",
      });
      if (projection?.role !== "admin") throw new Error("expected admin");
      expect(projection.show).toMatchObject({
        title: beforeReset.show.title,
        tagline: beforeReset.show.tagline,
        shortName: beforeReset.show.shortName,
        fontFamily: beforeReset.show.fontFamily,
        reactionsEnabled: beforeReset.show.reactionsEnabled,
        audienceWeight: beforeReset.show.audienceWeight,
        flowPolicy: beforeReset.show.flowPolicy,
      });
      expect(projection.acts).toEqual([]);
      expect(projection.testShow).toBeNull();
      const judgeConfiguration = (
        judges: typeof projection.judges,
      ): { id: string; slot: number; displayName: string }[] =>
        judges.map(({ id, slot, displayName }) => ({ id, slot, displayName }));
      expect(judgeConfiguration(projection.judges)).toEqual(
        judgeConfiguration(beforeReset.judges),
      );
      expect(
        projection.judges.every((judge) => judge.submission === null),
      ).toBe(true);
      expect(
        storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM media_assets")
          .one().count,
      ).toBe(0);
      // Every generated fixture and the stranded object left R2; the font
      // cache is not show data and is untouched.
      expect(
        [...r2.objects.keys()].filter(
          (key) => key.startsWith("test-shows/") || key.startsWith("primary/"),
        ),
      ).toEqual([]);
      expect(r2.deleted).toContain("primary/asset-stranded");
    });
  });
});

// ---------------------------------------------------------------------------
// Projector arming
// ---------------------------------------------------------------------------

class FakeAudio {
  paused = true;
  ended = false;
  currentTime = 0;
  volume = 1;
  muted = false;
  src = "";
  readyState = 0;
  plays = 0;
  refuse = false;
  play(): Promise<void> {
    this.plays += 1;
    if (this.refuse) {
      const error = new Error("play() failed because the user didn't interact");
      error.name = "NotAllowedError";
      return Promise.reject(error);
    }
    this.paused = false;
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
  load(): void {}
  removeAttribute(): void {
    this.src = "";
  }
  addEventListener(): void {}
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state = "suspended";
  resumes = 0;
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  resume(): Promise<void> {
    this.resumes += 1;
    this.state = "running";
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

describe("projector audio arming", () => {
  it("issues both browser unlock calls synchronously inside the click and arms on the first press", async () => {
    const scope = globalThis as { AudioContext?: unknown };
    const previous = scope.AudioContext;
    scope.AudioContext = FakeAudioContext;
    FakeAudioContext.instances = [];
    try {
      const audio = new FakeAudio();
      const statuses: boolean[] = [];
      const engine = new ProjectorMediaEngine(
        {
          onStatus: (status) => statuses.push(status.armed),
          onAcknowledgement: () => undefined,
        },
        audio as unknown as HTMLAudioElement,
      );
      const arming = engine.arm();
      // Before anything has been awaited: the gesture-sensitive calls have
      // already happened. This is what fixes "works on the second click".
      expect(audio.plays).toBe(1);
      expect(FakeAudioContext.instances[0]?.resumes).toBe(1);
      expect(await arming).toBe(true);
      expect(engine.isArmed()).toBe(true);
      expect(statuses.at(-1)).toBe(true);
      // The probe source is detached again and the volume restored.
      expect(audio.src).toBe("");
      expect(audio.volume).toBe(1);
      expect(audio.paused).toBe(true);
    } finally {
      scope.AudioContext = previous;
    }
  });

  it("never fakes armed when the browser refuses, and reports why", async () => {
    const scope = globalThis as { AudioContext?: unknown };
    const previous = scope.AudioContext;
    scope.AudioContext = FakeAudioContext;
    try {
      const audio = new FakeAudio();
      audio.refuse = true;
      let error: string | null = null;
      const engine = new ProjectorMediaEngine(
        {
          onStatus: (status) => {
            error = status.error;
          },
          onAcknowledgement: () => undefined,
        },
        audio as unknown as HTMLAudioElement,
      );
      expect(await engine.arm()).toBe(false);
      expect(engine.isArmed()).toBe(false);
      expect(error).toContain("NotAllowedError");
      // A later gesture that the browser accepts arms it.
      audio.refuse = false;
      expect(await engine.arm()).toBe(true);
    } finally {
      scope.AudioContext = previous;
    }
  });
});

// ---------------------------------------------------------------------------
// Authoritative presence
// ---------------------------------------------------------------------------

class FakeSocket implements WebSocketLike {
  readyState = 1;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  readonly sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {}
  open(): void {
    this.onopen?.(new Event("open"));
  }
  receive(data: string): void {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }
}

describe("authoritative live status", () => {
  it("distinguishes paired from connected, tracks armed live, and forgets telemetry when the display goes", () => {
    const socket = new FakeSocket();
    const client = new RealtimeClient({
      url: "ws://show.test/api/ws",
      hello: {
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        requestedRole: "admin",
      },
      createSocket: () => socket,
    });
    client.connect();
    socket.open();
    // Paired but not connected: a credential exists, no socket does.
    socket.receive(
      serialiseServerMessage({
        type: "connection_count",
        protocolVersion: PROTOCOL_VERSION,
        revision: showRevision(0),
        audience: 12,
        judgeIds: ["judge-1"],
        projectors: 0,
        projectorPaired: true,
        projectorArmed: null,
      }),
    );
    expect(client.getState().presence).toEqual({
      audience: 12,
      judgeIds: ["judge-1"],
      projectors: 0,
      projectorPaired: true,
      projectorArmed: null,
    });
    expect(client.getState().audienceConnections).toBe(12);
    // The display connects, then arms; each is a presence change, not telemetry.
    socket.receive(
      serialiseServerMessage({
        type: "connection_count",
        protocolVersion: PROTOCOL_VERSION,
        revision: showRevision(0),
        audience: 12,
        judgeIds: [],
        projectors: 1,
        projectorPaired: true,
        projectorArmed: false,
      }),
    );
    socket.receive(
      serialiseServerMessage({
        type: "projector_telemetry",
        protocolVersion: PROTOCOL_VERSION,
        revision: showRevision(0),
        status: {
          visual: "IDLE",
          audio: "IDLE",
          positionMs: null,
          durationMs: null,
          armed: true,
          black: false,
          error: null,
        },
      }),
    );
    socket.receive(
      serialiseServerMessage({
        type: "connection_count",
        protocolVersion: PROTOCOL_VERSION,
        revision: showRevision(0),
        audience: 12,
        judgeIds: [],
        projectors: 1,
        projectorPaired: true,
        projectorArmed: true,
      }),
    );
    expect(client.getState().presence?.projectorArmed).toBe(true);
    expect(client.getState().projectorTelemetry?.armed).toBe(true);
    // The display disconnects: presence says so and stale telemetry is dropped
    // so the console cannot show a transport for a socket that is gone.
    socket.receive(
      serialiseServerMessage({
        type: "connection_count",
        protocolVersion: PROTOCOL_VERSION,
        revision: showRevision(0),
        audience: 11,
        judgeIds: [],
        projectors: 0,
        projectorPaired: true,
        projectorArmed: null,
      }),
    );
    expect(client.getState().presence).toMatchObject({
      projectors: 0,
      projectorPaired: true,
      projectorArmed: null,
      audience: 11,
    });
    expect(client.getState().projectorTelemetry).toBeNull();
    client.destroy();
  });

  it("carries the voting close revision to the phone", () => {
    const socket = new FakeSocket();
    const client = new RealtimeClient({
      url: "ws://show.test/api/ws",
      hello: {
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        requestedRole: "audience",
      },
      createSocket: () => socket,
    });
    client.connect();
    socket.open();
    socket.receive(
      serialiseServerMessage({
        type: "voting_state_update",
        protocolVersion: PROTOCOL_VERSION,
        revision: showRevision(0),
        state: "CLOSED",
        closeRevision: "close-abc",
      }),
    );
    expect(client.getState().voteCloseRevision).toBe("close-abc");
    socket.receive(
      serialiseServerMessage({
        type: "voting_state_update",
        protocolVersion: PROTOCOL_VERSION,
        revision: showRevision(1),
        state: "OPEN",
        closeRevision: null,
      }),
    );
    expect(client.getState().voteCloseRevision).toBeNull();
    client.destroy();
  });
});

// ---------------------------------------------------------------------------
// Test show generator
// ---------------------------------------------------------------------------

describe("procedural test shows", () => {
  it("produces the same plan for the same seed and a different one for another", () => {
    const seed = createTestSeed(seededRandom("12345678"));
    expect(seed).toMatch(/^[0-9A-F]{8}$/u);
    const first = generateTestShowPlan(seed);
    const again = generateTestShowPlan(seed);
    expect(again).toEqual(first);
    const other = generateTestShowPlan("FFFFFFFF");
    expect(other).not.toEqual(first);
  });

  it("weights the scenario pool towards the end of the show", () => {
    const random = seededRandom("0BADF00D");
    const counts = new Map<string, number>();
    for (let index = 0; index < 4000; index += 1) {
      const phase = chooseScenario(random).phase;
      counts.set(phase, (counts.get(phase) ?? 0) + 1);
    }
    const end = counts.get("end") ?? 0;
    const mid = counts.get("mid") ?? 0;
    const early = counts.get("early") ?? 0;
    expect(end / 4000).toBeGreaterThan(0.5);
    expect(mid / 4000).toBeGreaterThan(0.15);
    expect(early / 4000).toBeGreaterThan(0.08);
  });

  it.each(TEST_SCENARIOS.map((scenario) => scenario.id))(
    "builds a valid %s plan",
    (scenario) => {
      const plan = generateTestShowPlan("CAFE1234", scenario);
      expect(plan.scenario).toBe(scenario);
      expect(plan.acts.length).toBeGreaterThan(0);
      expect(plan.judgeNames.length).toBeGreaterThanOrEqual(1);
      expect(plan.judgeNames.length).toBeLessThanOrEqual(8);
      for (const act of plan.acts) {
        expect(act.actName.length).toBeGreaterThan(0);
        expect(act.performerName.length).toBeGreaterThan(0);
        expect(act.performers.length).toBeGreaterThan(0);
        for (const performer of act.performers)
          expect(performer.length).toBeGreaterThan(0);
        if (act.groupName === "" && act.performers.length === 1)
          expect(act.performerName).toBe(act.performers[0]);
        if (act.groupName !== "") expect(act.performerName).toBe(act.groupName);
        expect(act.judgeScores).toHaveLength(plan.judgeNames.length);
        // A finalised act has every input a final score needs.
        if (act.finalised) {
          expect(act.audienceScores.length).toBeGreaterThan(0);
          expect(act.judgeScores.every((score) => score !== null)).toBe(true);
        }
        for (const score of act.audienceScores) {
          expect(score).toBeGreaterThanOrEqual(0);
          expect(score).toBeLessThanOrEqual(10);
        }
      }
      if (plan.currentActIndex !== null)
        expect(plan.acts[plan.currentActIndex]).toBeDefined();
    },
  );

  it("generates soloists, named groups and unnamed groups", () => {
    const shapes = new Set<string>();
    for (const seed of [
      "CAFE1234",
      "0BADF00D",
      "12345678",
      "FFFFFFFF",
      "ABCDEF01",
    ]) {
      for (const act of generateTestShowPlan(seed, "near-end").acts) {
        shapes.add(
          act.performers.length === 1
            ? "solo"
            : act.groupName
              ? "named-group"
              : "unnamed-group",
        );
      }
    }
    expect([...shapes].sort()).toEqual([
      "named-group",
      "solo",
      "unnamed-group",
    ]);
  });

  it("generates real rows and tagged fixtures the show can run, rank and reset", async () => {
    await withShow("test-show-generate", async (storage) => {
      const r2 = fakeBucket();
      upsertShow(storage, PRIMARY_SHOW_ID, { title: "Real Show", tagline: "" });
      const summary = await generateTestShow(
        storage,
        r2.bucket,
        PRIMARY_SHOW_ID,
        { seed: "0000C0DE", scenario: "completed-show" },
      );
      expect(summary).toMatchObject({
        seed: "0000C0DE",
        scenario: "completed-show",
        brokenAssets: 0,
      });
      const projection = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "admin",
      });
      if (projection?.role !== "admin") throw new Error("expected admin");
      // Configuration is kept; the data is the generated show.
      expect(projection.show.title).toBe("Real Show");
      expect(projection.acts).toHaveLength(summary.acts);
      expect(projection.testShow).toMatchObject({
        seed: "0000C0DE",
        scenario: "completed-show",
      });
      expect(projection.ranking.ranked.length).toBe(summary.finalised);
      expect(projection.ranking.ranked.length).toBeGreaterThan(0);
      expect(projection.show.displayMode).toBe("FINAL_RESULTS");
      expect(
        storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM audience_votes WHERE show_id = ?",
            PRIMARY_SHOW_ID,
          )
          .one().count,
      ).toBe(summary.votes);
      // Every fixture is owned by an act, flagged, and lives in the test
      // namespace, so nothing about it can be mistaken for a real upload.
      const assets = storage.sql
        .exec<{
          act_id: string | null;
          generated_test: number;
          object_key: string;
          test_show_id: string | null;
        }>(
          "SELECT act_id, generated_test, object_key, test_show_id FROM media_assets WHERE show_id = ?",
          PRIMARY_SHOW_ID,
        )
        .toArray();
      expect(assets).toHaveLength(summary.assets);
      expect(
        assets.every(
          (asset) =>
            asset.act_id !== null &&
            asset.generated_test === 1 &&
            asset.object_key.startsWith(`test-shows/${summary.testShowId}/`) &&
            asset.test_show_id === summary.testShowId,
        ),
      ).toBe(true);
      // The fixtures are real files the projector can decode.
      const png = syntheticPng(8, 8, [10, 20, 30]);
      expect([...png.subarray(0, 8)]).toEqual([
        137, 80, 78, 71, 13, 10, 26, 10,
      ]);
      const wav = syntheticWav(0.5);
      expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");

      // Generating again replaces rather than appends, and clears the old
      // fixtures from storage.
      const before = [...r2.objects.keys()];
      const second = await generateTestShow(
        storage,
        r2.bucket,
        PRIMARY_SHOW_ID,
        { scenario: "early-show" },
      );
      expect(
        projectShowState(storage, PRIMARY_SHOW_ID, { kind: "admin" }),
      ).toMatchObject({ role: "admin" });
      expect(
        storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM acts WHERE show_id = ?",
            PRIMARY_SHOW_ID,
          )
          .one().count,
      ).toBe(second.acts);
      expect(before.every((key) => r2.deleted.includes(key))).toBe(true);
    });
  });

  it("can deliberately produce a broken-media readiness failure", async () => {
    await withShow("test-show-broken", async (storage) => {
      const r2 = fakeBucket();
      upsertShow(storage, PRIMARY_SHOW_ID, { title: "Show", tagline: "" });
      // Several seeds so the scenario's random broken flag lands at least once.
      let broken = 0;
      for (const seed of ["00000001", "00000002", "00000003", "00000004"]) {
        const summary = await generateTestShow(
          storage,
          r2.bucket,
          PRIMARY_SHOW_ID,
          { seed, scenario: "broken-media" },
        );
        broken += summary.brokenAssets;
        if (summary.brokenAssets > 0) {
          const missing = storage.sql
            .exec<{ object_key: string }>(
              "SELECT object_key FROM media_assets WHERE show_id = ?",
              PRIMARY_SHOW_ID,
            )
            .toArray()
            .filter((row) => !r2.objects.has(row.object_key));
          expect(missing.length).toBe(summary.brokenAssets);
        }
      }
      expect(broken).toBeGreaterThan(0);
    });
  });
});
