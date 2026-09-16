import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { isResetConfirmed, resetShow } from "../worker/show-reset";
import { upsertShow } from "../worker/show-config";
import { PRIMARY_SHOW_ID, projectShowState } from "../worker/show-state";

const now = "2026-09-14T00:00:00.000Z";

function seedShow(storage: DurableObjectStorage): void {
  upsertShow(storage, PRIMARY_SHOW_ID, {
    title: "Ngaio Showcase",
    tagline: "Term 3",
    shortName: "Showcase",
    themeId: "gold-white",
    fontFamily: "system-ui",
    reactionsEnabled: true,
  });
  storage.sql.exec(
    `INSERT INTO acts (id, show_id, order_index, performer_name, school_year, act_name,
       act_type, public_description, internal_notes, created_at, updated_at)
     VALUES ('act-1', ?, 0, 'P', 'Y', 'A', 'Music', '', '', ?, ?)`,
    PRIMARY_SHOW_ID,
    now,
    now,
  );
  storage.sql.exec(
    `INSERT INTO media_assets (id, show_id, object_key, original_filename, mime_type, size_bytes,
       version_identifier, duration_ms, width, height, uploaded_at, deleted_at)
     VALUES ('asset-1', ?, 'primary/asset-1', 'a.png', 'image/png', 1, 'v', NULL, NULL, NULL, ?, NULL)`,
    PRIMARY_SHOW_ID,
    now,
  );
  storage.sql.exec(
    `INSERT INTO show_judges (id, show_id, slot, display_name, token_hash, active,
       created_at, deactivated_at, credential_revoked_at)
     VALUES ('judge-1', ?, 1, 'Alice', ?, 1, ?, NULL, NULL)`,
    PRIMARY_SHOW_ID,
    new Uint8Array(32).fill(3).buffer,
    now,
  );
  storage.sql.exec(
    `INSERT INTO audience_votes (show_id, act_id, voter_id_hash, score, weight, weighted_score, received_at)
     VALUES (?, 'act-1', ?, 8, 0.95, 7.6, ?)`,
    PRIMARY_SHOW_ID,
    new Uint8Array(32).fill(1).buffer,
    now,
  );
  storage.sql.exec(
    `INSERT INTO admin_sessions (token_hash, expires_at, created_at, last_seen_at)
     VALUES (?, ?, ?, ?)`,
    new Uint8Array(32).fill(7).buffer,
    Date.now() + 60_000,
    now,
    now,
  );
  storage.sql.exec(
    "UPDATE shows SET display_mode = 'SCOREBOARD', audience_vote_state = 'OPEN', active_act_id = 'act-1' WHERE id = ?",
    PRIMARY_SHOW_ID,
  );
  projectShowState(storage, PRIMARY_SHOW_ID, { kind: "audience" });
  storage.sql.exec(
    "UPDATE show_runtime SET black_screen = 1, results_stage = 'LEADERBOARD' WHERE show_id = ?",
    PRIMARY_SHOW_ID,
  );
}

function count(storage: DurableObjectStorage, table: string): number {
  return storage.sql
    .exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`)
    .one().count;
}

async function withCoordinator(
  name: string,
  run: (storage: DurableObjectStorage) => Promise<void>,
): Promise<void> {
  const stub = env.SHOW_COORDINATOR.get(env.SHOW_COORDINATOR.idFromName(name));
  await stub.fetch("https://show.internal/health");
  await runInDurableObject(stub, async (_instance, state) => {
    await run(state.storage);
  });
}

describe("show reset", () => {
  it("accepts only the exact confirmation phrase", () => {
    expect(isResetConfirmed({ confirm: "RESET SHOW" })).toBe(true);
    expect(isResetConfirmed({ confirm: "reset show" })).toBe(false);
    expect(isResetConfirmed({})).toBe(false);
    expect(isResetConfirmed(null)).toBe(false);
  });

  it("clears the event's performance data and returns the stage to a safe state", async () => {
    await withCoordinator("show-reset", async (storage) => {
      const deleted: string[] = [];
      const bucket = {
        delete: async (key: string) => {
          deleted.push(key);
        },
      } as unknown as R2Bucket;
      seedShow(storage);

      const result = await resetShow(storage, bucket, PRIMARY_SHOW_ID);
      expect(result).toMatchObject({
        clearedActs: 1,
        objectsDeleted: 1,
        objectsPending: 0,
        mediaCleanupComplete: true,
      });
      expect(deleted).toEqual(["primary/asset-1"]);

      for (const table of [
        "acts",
        "cues",
        "media_assets",
        "audience_votes",
        "audience_aggregates",
        "show_judge_submissions",
        "finalised_results_v2",
        "result_snapshots",
        "projector_pairing_codes",
        "media_cleanup_queue",
      ]) {
        expect(count(storage, table), table).toBe(0);
      }

      const projection = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "admin",
      });
      if (projection?.role !== "admin") throw new Error("expected admin");
      expect(projection.acts).toEqual([]);
      expect(projection.show).toMatchObject({
        displayMode: "LOBBY",
        audienceVoteState: "CLOSED",
        resultRevealState: "HIDDEN",
        activeActId: null,
      });
      expect(projection.runtime).toMatchObject({
        blackScreen: false,
        visualTransport: "STOPPED",
        audioTransport: "STOPPED",
        resultsStage: "HIDDEN",
      });
    });
  });

  it("clears operational data while retaining event and venue configuration", async () => {
    await withCoordinator("show-reset-retention", async (storage) => {
      const bucket = {
        delete: async () => undefined,
      } as unknown as R2Bucket;
      seedShow(storage);
      storage.sql.exec(
        `UPDATE shows SET audience_weight = 0.3, intermission_message = 'Back soon',
           flow_open_voting_on_scoring = 1 WHERE id = ?`,
        PRIMARY_SHOW_ID,
      );
      const result = await resetShow(storage, bucket, PRIMARY_SHOW_ID);
      expect(result.projectorSessionsRevoked).toBe(0);

      const projection = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "admin",
      });
      if (projection?.role !== "admin") throw new Error("expected admin");
      // A between-events reset keeps setup preferences that are expensive and
      // error-prone to recreate under venue pressure.
      expect(projection.show).toMatchObject({
        title: "Ngaio Showcase",
        tagline: "Term 3",
        shortName: "Showcase",
        themeId: "gold-white",
        fontFamily: "system-ui",
        audienceWeight: 0.3,
        intermissionMessage: "Back soon",
      });
      expect(projection.judges.map((judge) => judge.displayName)).toEqual([
        "Alice",
      ]);
      expect(projection.testShow).toBeNull();
      // The operator who pressed the button is still signed in: the account
      // and its sessions are platform, not show.
      expect(count(storage, "admin_sessions")).toBe(1);
    });
  });

  it("retains paired projector sessions while clearing temporary pairing codes", async () => {
    await withCoordinator("show-reset-projector", async (storage) => {
      const bucket = {
        delete: async () => undefined,
      } as unknown as R2Bucket;
      seedShow(storage);
      storage.sql.exec(
        `INSERT INTO projector_sessions (token_hash, show_id, created_at, last_seen_at, expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
        new Uint8Array(32).fill(9).buffer,
        PRIMARY_SHOW_ID,
        now,
        now,
        Date.now() + 60_000,
      );
      const result = await resetShow(storage, bucket, PRIMARY_SHOW_ID);
      expect(result.projectorSessionsRevoked).toBe(0);
      expect(count(storage, "projector_sessions")).toBe(1);
      expect(count(storage, "projector_pairing_codes")).toBe(0);
    });
  });

  it("reports outstanding work rather than claiming a clean bucket", async () => {
    await withCoordinator("show-reset-r2-failure", async (storage) => {
      const bucket = {
        delete: async () => {
          throw new Error("R2 unavailable");
        },
      } as unknown as R2Bucket;
      seedShow(storage);

      const result = await resetShow(storage, bucket, PRIMARY_SHOW_ID);
      // The database reset still happened in full...
      expect(result.clearedActs).toBe(1);
      expect(count(storage, "acts")).toBe(0);
      // ...and the object that could not be deleted is retryable work, not a
      // silent leak and not a false "all clean".
      expect(result.mediaCleanupComplete).toBe(false);
      expect(result.objectsPending).toBe(1);
      expect(result.objectsDeleted).toBe(0);
      expect(
        storage.sql
          .exec<{ object_key: string; last_error: string | null }>(
            "SELECT object_key, last_error FROM media_cleanup_queue",
          )
          .one(),
      ).toMatchObject({ object_key: "primary/asset-1" });
    });
  });

  it("is idempotent: resetting an already clean show changes nothing", async () => {
    await withCoordinator("show-reset-idempotent", async (storage) => {
      const bucket = {
        delete: async () => undefined,
      } as unknown as R2Bucket;
      seedShow(storage);
      await resetShow(storage, bucket, PRIMARY_SHOW_ID);
      const second = await resetShow(storage, bucket, PRIMARY_SHOW_ID);
      expect(second).toMatchObject({
        clearedActs: 0,
        objectsDeleted: 0,
        objectsPending: 0,
        mediaCleanupComplete: true,
      });
    });
  });
});
