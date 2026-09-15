/**
 * Deleting an act and resetting the show are the two operations that destroy
 * an operator's evening if they are wrong. These tests exercise the real
 * transactions against a real coordinator, including the cases where R2 refuses
 * and the work has to survive as something retryable.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  createAct,
  deleteAct,
  parseActInput,
  previewActDeletion,
} from "../worker/acts";
import {
  cleanOrphanedAssets,
  drainMediaCleanupQueue,
  findOrphanedAssets,
  pendingCleanupCount,
} from "../worker/media-cleanup";
import { deleteMediaAsset } from "../worker/media-assets";
import { upsertShow } from "../worker/show-config";
import { resetShow } from "../worker/show-reset";
import { PRIMARY_SHOW_ID, projectShowState } from "../worker/show-state";

const NOW = "2026-09-15T00:00:00.000Z";

/**
 * A small in-memory R2: it holds objects, records deletions, and can be told to
 * start refusing so the retry path can be exercised.
 */
function recordingBucket(initial: Record<string, number> = {}) {
  const objects = new Map<string, number>(Object.entries(initial));
  const deleted: string[] = [];
  let failing = false;
  return {
    deleted,
    objects,
    fail(value: boolean) {
      failing = value;
    },
    bucket: {
      delete: async (key: string) => {
        if (failing) throw new Error("R2 unavailable");
        objects.delete(key);
        deleted.push(key);
      },
      list: async (options?: { prefix?: string }) => ({
        objects: [...objects.entries()]
          .filter(([key]) => key.startsWith(options?.prefix ?? ""))
          .map(([key, size]) => ({ key, size })),
        truncated: false as const,
      }),
    } as unknown as R2Bucket,
  };
}

function seedAsset(
  storage: DurableObjectStorage,
  id: string,
  mimeType = "image/png",
): void {
  storage.sql.exec(
    `INSERT INTO media_assets (
      id, show_id, object_key, original_filename, mime_type, size_bytes,
      version_identifier, duration_ms, width, height, uploaded_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, 2048, 'v1', NULL, NULL, NULL, ?, NULL)`,
    id,
    PRIMARY_SHOW_ID,
    `primary/${id}`,
    `${id}.file`,
    mimeType,
    NOW,
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
      performanceMode: "DEFAULT",
      performanceAssetId: null,
      performanceFit: "contain",
      backingAudioAssetId: null,
      backingAudioStart: "MANUAL",
    },
    ...overrides,
  });
  if (!parsed) throw new Error("invalid act fixture");
  return parsed;
}

function count(storage: DurableObjectStorage, sql: string, ...args: unknown[]) {
  return storage.sql.exec<{ count: number }>(sql, ...(args as never[])).one()
    .count;
}

async function withShow(
  name: string,
  run: (storage: DurableObjectStorage) => Promise<void>,
): Promise<void> {
  const stub = env.SHOW_COORDINATOR.get(env.SHOW_COORDINATOR.idFromName(name));
  await stub.fetch("https://show.internal/health");
  await runInDurableObject(stub, async (_instance, state) => {
    upsertShow(state.storage, PRIMARY_SHOW_ID, {
      title: "Test Show",
      tagline: "",
    });
    await run(state.storage);
  });
}

describe("deleting an act", () => {
  it("removes only that act's records and only the files it alone used", async () => {
    await withShow("delete-act-isolation", async (storage) => {
      const r2 = recordingBucket();
      seedAsset(storage, "asset-a-image");
      seedAsset(storage, "asset-b-image");
      seedAsset(storage, "asset-shared", "audio/mpeg");

      const actA = createAct(
        storage,
        PRIMARY_SHOW_ID,
        actInput({
          actName: "Act A",
          publicImageAssetId: "asset-a-image",
          presentation: {
            performanceMode: "DEFAULT",
            performanceAssetId: null,
            performanceFit: "contain",
            backingAudioAssetId: "asset-shared",
            backingAudioStart: "MANUAL",
          },
        }),
      )!;
      const actB = createAct(
        storage,
        PRIMARY_SHOW_ID,
        actInput({
          actName: "Act B",
          publicImageAssetId: "asset-b-image",
          presentation: {
            performanceMode: "DEFAULT",
            performanceAssetId: null,
            performanceFit: "contain",
            // Deliberately the same backing track as Act A.
            backingAudioAssetId: "asset-shared",
            backingAudioStart: "MANUAL",
          },
        }),
      )!;

      // Act A carries a full evening's worth of state.
      storage.sql.exec(
        `INSERT INTO audience_votes (show_id, act_id, voter_id_hash, score, weight, weighted_score, received_at)
         VALUES (?, ?, ?, 8, 0.95, 7.6, ?)`,
        PRIMARY_SHOW_ID,
        actA.id,
        new Uint8Array(32).fill(1).buffer,
        NOW,
      );
      storage.sql.exec(
        `INSERT INTO audience_aggregates (show_id, act_id, vote_count, weighted_sum, total_weight, weighted_mean, updated_at)
         VALUES (?, ?, 1, 7.6, 0.95, 8, ?)`,
        PRIMARY_SHOW_ID,
        actA.id,
        NOW,
      );

      const preview = previewActDeletion(storage.sql, PRIMARY_SHOW_ID, actA.id);
      expect(preview.ok && preview.preview).toMatchObject({
        audienceVotes: 1,
        cues: 1,
        blockers: [],
      });
      expect(
        preview.ok && preview.preview.releasedAssets.map((a) => a.id),
      ).toEqual(["asset-a-image"]);
      expect(
        preview.ok && preview.preview.sharedAssets.map((a) => a.id),
      ).toEqual(["asset-shared"]);

      const result = deleteAct(storage, PRIMARY_SHOW_ID, actA.id);
      expect(result.ok).toBe(true);
      await drainMediaCleanupQueue(storage, r2.bucket, PRIMARY_SHOW_ID);

      // Act A is gone, with every record that referenced it.
      expect(
        count(
          storage,
          "SELECT COUNT(*) AS count FROM acts WHERE id = ?",
          actA.id,
        ),
      ).toBe(0);
      for (const table of [
        "cues",
        "audience_votes",
        "audience_aggregates",
        "cue_asset_references",
      ]) {
        expect(
          count(
            storage,
            `SELECT COUNT(*) AS count FROM ${table} WHERE show_id = ? AND ${table === "cue_asset_references" ? "cue_id LIKE ?" : "act_id = ?"}`,
            PRIMARY_SHOW_ID,
            table === "cue_asset_references" ? `%${actA.id}%` : actA.id,
          ),
          table,
        ).toBe(0);
      }
      // Act B is untouched, and the shared track survived.
      expect(
        count(
          storage,
          "SELECT COUNT(*) AS count FROM acts WHERE id = ?",
          actB.id,
        ),
      ).toBe(1);
      expect(r2.deleted).toEqual(["primary/asset-a-image"]);
      expect(
        count(
          storage,
          "SELECT COUNT(*) AS count FROM media_assets WHERE id = ?",
          "asset-shared",
        ),
      ).toBe(1);
      expect(
        count(
          storage,
          "SELECT COUNT(*) AS count FROM media_assets WHERE id = ?",
          "asset-b-image",
        ),
      ).toBe(1);
      // The running order closes up behind the deleted act.
      expect(
        storage.sql
          .exec<{ order_index: number }>(
            "SELECT order_index FROM acts WHERE id = ?",
            actB.id,
          )
          .one().order_index,
      ).toBe(0);
    });
  });

  it("refuses while the act is live, and allows it once nothing is", async () => {
    await withShow("delete-act-live", async (storage) => {
      const act = createAct(storage, PRIMARY_SHOW_ID, actInput())!;
      projectShowState(storage, PRIMARY_SHOW_ID, { kind: "admin" });
      storage.sql.exec(
        "UPDATE shows SET active_act_id = ?, audience_vote_state = 'OPEN' WHERE id = ?",
        act.id,
        PRIMARY_SHOW_ID,
      );
      const blocked = deleteAct(storage, PRIMARY_SHOW_ID, act.id);
      expect(blocked).toMatchObject({ ok: false, status: 409 });
      expect(!blocked.ok && blocked.reason).toContain("voting is open");

      storage.sql.exec(
        "UPDATE shows SET audience_vote_state = 'CLOSED' WHERE id = ?",
        PRIMARY_SHOW_ID,
      );
      storage.sql.exec(
        "UPDATE show_runtime SET audio_transport = 'PLAYING' WHERE show_id = ?",
        PRIMARY_SHOW_ID,
      );
      expect(deleteAct(storage, PRIMARY_SHOW_ID, act.id)).toMatchObject({
        ok: false,
        status: 409,
      });

      storage.sql.exec(
        "UPDATE show_runtime SET audio_transport = 'STOPPED' WHERE show_id = ?",
        PRIMARY_SHOW_ID,
      );
      // Deleting the current act clears the selection rather than refusing.
      expect(deleteAct(storage, PRIMARY_SHOW_ID, act.id).ok).toBe(true);
      const show = storage.sql
        .exec<{ active_act_id: string | null }>(
          "SELECT active_act_id FROM shows WHERE id = ?",
          PRIMARY_SHOW_ID,
        )
        .one();
      expect(show.active_act_id).toBeNull();
    });
  });

  it("is idempotent: deleting twice reports not found, never a half deletion", async () => {
    await withShow("delete-act-idempotent", async (storage) => {
      const act = createAct(storage, PRIMARY_SHOW_ID, actInput())!;
      expect(deleteAct(storage, PRIMARY_SHOW_ID, act.id).ok).toBe(true);
      const second = deleteAct(storage, PRIMARY_SHOW_ID, act.id);
      expect(second).toMatchObject({ ok: false, status: 404 });
    });
  });

  it("keeps an act deletable when R2 is down, and remembers the objects", async () => {
    await withShow("delete-act-r2-down", async (storage) => {
      const r2 = recordingBucket();
      seedAsset(storage, "asset-only");
      const act = createAct(
        storage,
        PRIMARY_SHOW_ID,
        actInput({ publicImageAssetId: "asset-only" }),
      )!;

      r2.fail(true);
      expect(deleteAct(storage, PRIMARY_SHOW_ID, act.id).ok).toBe(true);
      const failed = await drainMediaCleanupQueue(
        storage,
        r2.bucket,
        PRIMARY_SHOW_ID,
      );
      expect(failed).toMatchObject({ deleted: 0, pending: 1, complete: false });
      // The database is already correct; only the object is outstanding.
      expect(count(storage, "SELECT COUNT(*) AS count FROM acts")).toBe(0);
      expect(count(storage, "SELECT COUNT(*) AS count FROM media_assets")).toBe(
        0,
      );

      r2.fail(false);
      const retried = await drainMediaCleanupQueue(
        storage,
        r2.bucket,
        PRIMARY_SHOW_ID,
      );
      expect(retried).toMatchObject({ deleted: 1, complete: true });
      expect(r2.deleted).toEqual(["primary/asset-only"]);
    });
  });
});

describe("orphaned media", () => {
  it("finds uploads nothing references, and never a file still in use", async () => {
    await withShow("orphans", async (storage) => {
      const r2 = recordingBucket();
      seedAsset(storage, "asset-used");
      seedAsset(storage, "asset-leaked");
      createAct(
        storage,
        PRIMARY_SHOW_ID,
        actInput({ publicImageAssetId: "asset-used" }),
      );

      const report = await findOrphanedAssets(
        storage.sql,
        r2.bucket,
        PRIMARY_SHOW_ID,
      );
      expect(report.assets.map((asset) => asset.id)).toEqual(["asset-leaked"]);
      expect(report.totalBytes).toBe(2048);

      const cleaned = await cleanOrphanedAssets(
        storage,
        r2.bucket,
        PRIMARY_SHOW_ID,
      );
      expect(cleaned).toMatchObject({ retired: 1, deleted: 1, complete: true });
      expect(r2.deleted).toEqual(["primary/asset-leaked"]);
      expect(
        count(
          storage,
          "SELECT COUNT(*) AS count FROM media_assets WHERE id = ?",
          "asset-used",
        ),
      ).toBe(1);
      // A second sweep has nothing to do.
      expect(
        (await findOrphanedAssets(storage.sql, r2.bucket, PRIMARY_SHOW_ID))
          .assets,
      ).toHaveLength(0);
    });
  });

  it("finds and removes objects whose metadata row is already gone", async () => {
    await withShow("orphans-stray", async (storage) => {
      // The leak an older build produced: the row was deleted and the R2
      // failure was swallowed, so nothing in the database can reveal the bytes.
      const r2 = recordingBucket({
        "primary/asset-stranded": 7_000_000,
        "fonts/abc123.woff2": 42_000,
      });
      seedAsset(storage, "asset-live");
      createAct(
        storage,
        PRIMARY_SHOW_ID,
        actInput({ publicImageAssetId: "asset-live" }),
      );

      const report = await findOrphanedAssets(
        storage.sql,
        r2.bucket,
        PRIMARY_SHOW_ID,
      );
      expect(report.assets).toHaveLength(0);
      expect(report.strayObjects.map((object) => object.key)).toEqual([
        "primary/asset-stranded",
      ]);
      expect(report.strayBytes).toBe(7_000_000);

      const cleaned = await cleanOrphanedAssets(
        storage,
        r2.bucket,
        PRIMARY_SHOW_ID,
      );
      expect(cleaned).toMatchObject({ strays: 1, deleted: 1, complete: true });
      expect(r2.deleted).toEqual(["primary/asset-stranded"]);
      // The cached typeface lives outside the show's namespace and is untouched.
      expect(r2.objects.has("fonts/abc123.woff2")).toBe(true);
    });
  });

  it("never treats a live asset's object as stray", async () => {
    await withShow("orphans-stray-safe", async (storage) => {
      const r2 = recordingBucket({ "primary/asset-live": 1024 });
      seedAsset(storage, "asset-live");
      createAct(
        storage,
        PRIMARY_SHOW_ID,
        actInput({ publicImageAssetId: "asset-live" }),
      );
      const report = await findOrphanedAssets(
        storage.sql,
        r2.bucket,
        PRIMARY_SHOW_ID,
      );
      expect(report.strayObjects).toEqual([]);
      await cleanOrphanedAssets(storage, r2.bucket, PRIMARY_SHOW_ID);
      expect(r2.deleted).toEqual([]);
      expect(r2.objects.has("primary/asset-live")).toBe(true);
    });
  });

  it("records a failed asset delete as retryable rather than losing the object", async () => {
    await withShow("orphans-retry", async (storage) => {
      const r2 = recordingBucket();
      seedAsset(storage, "asset-solo");
      r2.fail(true);
      expect(
        await deleteMediaAsset(
          storage,
          r2.bucket,
          PRIMARY_SHOW_ID,
          "asset-solo",
        ),
      ).toBe("deleted");
      expect(pendingCleanupCount(storage.sql, PRIMARY_SHOW_ID)).toBe(1);
      r2.fail(false);
      expect(
        await drainMediaCleanupQueue(storage, r2.bucket, PRIMARY_SHOW_ID),
      ).toMatchObject({ deleted: 1, complete: true });
    });
  });

  it("refuses to delete an asset another act still uses", async () => {
    await withShow("orphans-referenced", async (storage) => {
      const r2 = recordingBucket();
      seedAsset(storage, "asset-live");
      createAct(
        storage,
        PRIMARY_SHOW_ID,
        actInput({ publicImageAssetId: "asset-live" }),
      );
      expect(
        await deleteMediaAsset(
          storage,
          r2.bucket,
          PRIMARY_SHOW_ID,
          "asset-live",
        ),
      ).toBe("referenced");
      expect(r2.deleted).toEqual([]);
    });
  });
});

describe("global reset", () => {
  it("clears a complete event and deletes its media", async () => {
    await withShow("reset-full", async (storage) => {
      const r2 = recordingBucket();
      seedAsset(storage, "asset-1");
      seedAsset(storage, "asset-2", "audio/mpeg");
      createAct(
        storage,
        PRIMARY_SHOW_ID,
        actInput({
          publicImageAssetId: "asset-1",
          presentation: {
            performanceMode: "DEFAULT",
            performanceAssetId: null,
            performanceFit: "contain",
            backingAudioAssetId: "asset-2",
            backingAudioStart: "MANUAL",
          },
        }),
      );
      createAct(storage, PRIMARY_SHOW_ID, actInput({ actName: "Second" }));

      const result = await resetShow(storage, r2.bucket, PRIMARY_SHOW_ID);
      expect(result).toMatchObject({
        clearedActs: 2,
        objectsDeleted: 2,
        mediaCleanupComplete: true,
      });
      expect(new Set(r2.deleted)).toEqual(
        new Set(["primary/asset-1", "primary/asset-2"]),
      );
      expect(count(storage, "SELECT COUNT(*) AS count FROM acts")).toBe(0);
      expect(count(storage, "SELECT COUNT(*) AS count FROM cues")).toBe(0);
      expect(
        count(storage, "SELECT COUNT(*) AS count FROM media_cleanup_queue"),
      ).toBe(0);
      // The show itself survives so the operator can run the next event.
      expect(
        count(
          storage,
          "SELECT COUNT(*) AS count FROM shows WHERE id = ?",
          PRIMARY_SHOW_ID,
        ),
      ).toBe(1);
    });
  });
});
