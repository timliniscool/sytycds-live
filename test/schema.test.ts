import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  initialiseSchema,
  LATEST_SCHEMA_VERSION,
  readSchemaVersion,
} from "../worker/schema";

const now = "2026-09-14T00:00:00.000Z";

describe("coordinator SQLite schema", () => {
  it("brings a fresh coordinator to the latest schema", async () => {
    const stub = env.SHOW_COORDINATOR.get(
      env.SHOW_COORDINATOR.idFromName("schema-fresh"),
    );
    await stub.fetch("https://show.internal/health");

    await runInDurableObject(stub, (_instance, state) => {
      expect(readSchemaVersion(state.storage.sql)).toBe(LATEST_SCHEMA_VERSION);
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM schema_migrations",
          )
          .one().count,
      ).toBe(LATEST_SCHEMA_VERSION);
      expect(
        state.storage.sql
          .exec<{ name: string }>("PRAGMA table_info(acts)")
          .toArray()
          .some(({ name }) => name === "public_image_asset_id"),
      ).toBe(true);
    });
  });

  it("repairs a database whose migration history is recorded but incomplete", async () => {
    const stub = env.SHOW_COORDINATOR.get(
      env.SHOW_COORDINATOR.idFromName("schema-drift"),
    );
    await stub.fetch("https://show.internal/health");

    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      // Reproduce a coordinator that ran an intermediate migration 9: the
      // version is recorded, but the projector session table has no expiry and
      // the font tables were never created. Left alone, every projector
      // session lookup throws and pairing a display fails with a 500.
      sql.exec("DROP TABLE projector_sessions");
      sql.exec(`CREATE TABLE projector_sessions (
        token_hash BLOB PRIMARY KEY NOT NULL CHECK (length(token_hash) = 32),
        show_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        revoked_at TEXT
      ) STRICT`);
      sql.exec("DROP TABLE font_assets");
      sql.exec("DROP TABLE selected_font_css");
      sql.exec("DELETE FROM schema_migrations WHERE version >= 13");

      initialiseSchema(state.storage);

      expect(
        sql
          .exec<{ name: string }>(
            "SELECT name FROM pragma_table_info('projector_sessions')",
          )
          .toArray()
          .some(({ name }) => name === "expires_at"),
      ).toBe(true);
      for (const table of ["font_assets", "selected_font_css"]) {
        expect(
          sql
            .exec<{ name: string }>(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
              table,
            )
            .toArray(),
        ).toHaveLength(1);
      }
      expect(readSchemaVersion(sql)).toBe(LATEST_SCHEMA_VERSION);
    });
  });

  it("detects applied migrations and can initialise repeatedly", async () => {
    const stub = env.SHOW_COORDINATOR.get(
      env.SHOW_COORDINATOR.idFromName("schema-repeat"),
    );
    await stub.fetch("https://show.internal/health");

    await runInDurableObject(stub, (_instance, state) => {
      initialiseSchema(state.storage);
      initialiseSchema(state.storage);

      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM schema_migrations",
          )
          .one().count,
      ).toBe(LATEST_SCHEMA_VERSION);
    });
  });

  it("enforces insert-once votes and judge submissions", async () => {
    const stub = env.SHOW_COORDINATOR.get(
      env.SHOW_COORDINATOR.idFromName("schema-uniqueness"),
    );
    await stub.fetch("https://show.internal/health");

    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      const voterHash = new Uint8Array(32).buffer;
      const judgeHash = new Uint8Array(32).fill(1).buffer;

      sql.exec(
        `INSERT INTO shows (
          id, title, display_mode, audience_vote_state, result_reveal_state,
          active_act_id, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "show-1",
        "Show",
        "LOBBY",
        "CLOSED",
        "HIDDEN",
        null,
        0,
        now,
        now,
      );
      sql.exec(
        `INSERT INTO acts (
          id, show_id, order_index, performer_name, school_year, act_name,
          act_type, public_description, internal_notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "act-1",
        "show-1",
        0,
        "Performer",
        "Year 10",
        "Act",
        "Music",
        "Description",
        "",
        now,
        now,
      );
      sql.exec(
        `INSERT INTO judges (
          id, show_id, slot, display_name, token_hash, created_at, revoked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        "judge-1",
        "show-1",
        1,
        "Judge 1",
        judgeHash,
        now,
        null,
      );

      const insertVote = () =>
        sql.exec(
          `INSERT INTO audience_votes (
            show_id, act_id, voter_id_hash, score, weight, weighted_score, received_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          "show-1",
          "act-1",
          voterHash,
          7,
          1,
          7,
          now,
        );
      insertVote();
      expect(insertVote).toThrow();

      const insertSubmission = () =>
        sql.exec(
          `INSERT INTO judge_submissions (
            show_id, act_id, judge_id, raw_input, parsed_classification,
            finite_value, effective_score, submitted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          "show-1",
          "act-1",
          "judge-1",
          "7",
          "FINITE",
          7,
          7,
          now,
        );
      insertSubmission();
      expect(insertSubmission).toThrow();
    });
  });

  it("uses the audience uniqueness index for duplicate-vote checks", async () => {
    const stub = env.SHOW_COORDINATOR.get(
      env.SHOW_COORDINATOR.idFromName("schema-query-plan"),
    );
    await stub.fetch("https://show.internal/health");

    await runInDurableObject(stub, (_instance, state) => {
      const plan = state.storage.sql
        .exec<{ detail: string }>(
          `EXPLAIN QUERY PLAN
           SELECT score FROM audience_votes
           WHERE show_id = ? AND act_id = ? AND voter_id_hash = ?`,
          "show-1",
          "act-1",
          new Uint8Array(32).buffer,
        )
        .one();

      expect(plan.detail).toContain("USING INDEX");
      expect(plan.detail).toContain("audience_votes");
    });
  });
});
