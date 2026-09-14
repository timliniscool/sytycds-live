import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { isResetConfirmed, resetShow } from "../worker/show-reset";
import { upsertShow } from "../worker/show-config";
import { PRIMARY_SHOW_ID, projectShowState } from "../worker/show-state";

const now = "2026-09-14T00:00:00.000Z";

describe("show reset", () => {
  it("accepts only the exact confirmation phrase", () => {
    expect(isResetConfirmed({ confirm: "RESET SHOW" })).toBe(true);
    expect(isResetConfirmed({ confirm: "reset show" })).toBe(false);
    expect(isResetConfirmed({})).toBe(false);
    expect(isResetConfirmed(null)).toBe(false);
  });

  it("erases every show table, deletes media objects, and keeps operator sessions", async () => {
    const stub = env.SHOW_COORDINATOR.get(
      env.SHOW_COORDINATOR.idFromName("show-reset"),
    );
    await stub.fetch("https://show.internal/health");
    const deleted: string[] = [];
    const bucket = {
      delete: async (key: string) => {
        deleted.push(key);
      },
    } as unknown as R2Bucket;
    await runInDurableObject(stub, async (_instance, state) => {
      upsertShow(state.storage, PRIMARY_SHOW_ID, { title: "Old", tagline: "" });
      state.storage.sql.exec(
        `INSERT INTO acts (id, show_id, order_index, performer_name, school_year, act_name,
           act_type, public_description, internal_notes, created_at, updated_at)
         VALUES ('act-1', ?, 0, 'P', 'Y', 'A', 'Music', '', '', ?, ?)`,
        PRIMARY_SHOW_ID,
        now,
        now,
      );
      state.storage.sql.exec(
        `INSERT INTO media_assets (id, show_id, object_key, original_filename, mime_type, size_bytes,
           version_identifier, duration_ms, width, height, uploaded_at, deleted_at)
         VALUES ('asset-1', ?, 'primary/asset-1', 'a.png', 'image/png', 1, 'v', NULL, NULL, NULL, ?, NULL)`,
        PRIMARY_SHOW_ID,
        now,
      );
      state.storage.sql.exec(
        `INSERT INTO admin_sessions (token_hash, expires_at, created_at, last_seen_at)
         VALUES (?, ?, ?, ?)`,
        new Uint8Array(32).fill(7).buffer,
        Date.now() + 60_000,
        now,
        now,
      );
      // Touch the runtime row so it exists too.
      projectShowState(state.storage, PRIMARY_SHOW_ID, { kind: "audience" });

      const result = await resetShow(state.storage, bucket, PRIMARY_SHOW_ID);
      expect(result.deletedObjects).toBe(1);
      expect(deleted).toEqual(["primary/asset-1"]);
      for (const table of [
        "shows",
        "acts",
        "media_assets",
        "show_runtime",
        "audit_events",
      ]) {
        expect(
          state.storage.sql
            .exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`)
            .one().count,
        ).toBe(0);
      }
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM admin_sessions",
          )
          .one().count,
      ).toBe(1);
      expect(
        projectShowState(state.storage, PRIMARY_SHOW_ID, { kind: "admin" }),
      ).toBeNull();
      // The coordinator is back to a fresh deployment: creation works again.
      expect(
        upsertShow(state.storage, PRIMARY_SHOW_ID, {
          title: "New",
          tagline: "",
        }),
      ).toEqual({ created: true });
    });
  });
});
