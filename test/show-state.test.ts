import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { PROTOCOL_VERSION } from "../shared/domain";
import { PRIMARY_SHOW_ID, executeAdminCommand } from "../worker/show-state";

const now = "2026-09-14T00:00:00.000Z";

function seedShow(sql: SqlStorage): void {
  sql.exec(
    `INSERT INTO shows (
      id, title, display_mode, audience_vote_state, result_reveal_state,
      active_act_id, revision, created_at, updated_at
    ) VALUES (?, ?, 'LOBBY', 'CLOSED', 'HIDDEN', NULL, 0, ?, ?)`,
    PRIMARY_SHOW_ID,
    "Show",
    now,
    now,
  );
  for (const [id, order] of [
    ["act-1", 0],
    ["act-2", 1],
  ] as const) {
    sql.exec(
      `INSERT INTO acts (
        id, show_id, order_index, performer_name, school_year, act_name,
        act_type, public_description, internal_notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      PRIMARY_SHOW_ID,
      order,
      "Performer",
      "Year 10",
      id,
      "Music",
      "Description",
      "",
      now,
      now,
    );
  }
  for (const slot of [1, 2, 3, 4]) {
    sql.exec(
      `INSERT INTO judges (
        id, show_id, slot, display_name, token_hash, created_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      `judge-${slot}`,
      PRIMARY_SHOW_ID,
      slot,
      `Judge ${slot}`,
      new Uint8Array(32).fill(slot).buffer,
      now,
    );
  }
}

async function withSeededShow(
  name: string,
  test: (storage: DurableObjectStorage) => void,
): Promise<void> {
  const stub = env.SHOW_COORDINATOR.get(env.SHOW_COORDINATOR.idFromName(name));
  await stub.fetch("https://show.internal/health");
  await runInDurableObject(stub, (_instance, state) => {
    seedShow(state.storage.sql);
    test(state.storage);
  });
}

describe("authoritative show state", () => {
  it("keeps voting independent from display changes and restores HOLD safely", async () => {
    await withSeededShow("state-display", (storage) => {
      const select = executeAdminCommand(
        storage,
        PRIMARY_SHOW_ID,
        { kind: "admin" },
        {
          type: "SELECT_ACT",
          protocolVersion: PROTOCOL_VERSION,
          commandId: "select-act",
          expectedRevision: 0,
          actId: "act-1",
        },
      );
      expect(select.acknowledgement.status).toBe("accepted");
      const openVoting = executeAdminCommand(
        storage,
        PRIMARY_SHOW_ID,
        { kind: "admin" },
        {
          type: "OPEN_AUDIENCE_VOTING",
          protocolVersion: PROTOCOL_VERSION,
          commandId: "open-voting",
          expectedRevision: 1,
        },
      );
      expect(openVoting.acknowledgement.status).toBe("accepted");
      executeAdminCommand(
        storage,
        PRIMARY_SHOW_ID,
        { kind: "admin" },
        {
          type: "SET_DISPLAY_MODE",
          protocolVersion: PROTOCOL_VERSION,
          commandId: "intermission",
          expectedRevision: 2,
          mode: "INTERMISSION",
        },
      );
      executeAdminCommand(
        storage,
        PRIMARY_SHOW_ID,
        { kind: "admin" },
        {
          type: "SET_DISPLAY_MODE",
          protocolVersion: PROTOCOL_VERSION,
          commandId: "hold",
          expectedRevision: 3,
          mode: "HOLD",
        },
      );
      const restored = executeAdminCommand(
        storage,
        PRIMARY_SHOW_ID,
        { kind: "admin" },
        {
          type: "RESTORE_DISPLAY",
          protocolVersion: PROTOCOL_VERSION,
          commandId: "restore",
          expectedRevision: 4,
        },
      );

      expect(restored.acknowledgement.status).toBe("accepted");
      expect(
        storage.sql
          .exec<{
            display_mode: string;
            audience_vote_state: string;
            active_act_id: string;
          }>(
            "SELECT display_mode, audience_vote_state, active_act_id FROM shows WHERE id = ?",
            PRIMARY_SHOW_ID,
          )
          .one(),
      ).toEqual({
        display_mode: "INTERMISSION",
        audience_vote_state: "OPEN",
        active_act_id: "act-1",
      });
    });
  });

  it("rejects invalid, stale and unauthorised commands without mutating state", async () => {
    await withSeededShow("state-invalid", (storage) => {
      const invalidAct = executeAdminCommand(
        storage,
        PRIMARY_SHOW_ID,
        { kind: "admin" },
        {
          type: "SELECT_ACT",
          protocolVersion: PROTOCOL_VERSION,
          commandId: "unknown-act",
          expectedRevision: 0,
          actId: "not-present",
        },
      );
      expect(invalidAct.acknowledgement.status).toBe("rejected");
      const stale = executeAdminCommand(
        storage,
        PRIMARY_SHOW_ID,
        { kind: "admin" },
        {
          type: "CLOSE_AUDIENCE_VOTING",
          protocolVersion: PROTOCOL_VERSION,
          commandId: "stale",
          expectedRevision: 4,
        },
      );
      expect(stale.acknowledgement.status).toBe("stale");
      const unauthorised = executeAdminCommand(
        storage,
        PRIMARY_SHOW_ID,
        { kind: "audience" },
        {
          type: "CLOSE_AUDIENCE_VOTING",
          protocolVersion: PROTOCOL_VERSION,
          commandId: "not-admin",
          expectedRevision: 0,
        },
      );
      expect(unauthorised.acknowledgement.status).toBe("unauthorised");
      expect(
        storage.sql
          .exec<{ revision: number }>(
            "SELECT revision FROM shows WHERE id = ?",
            PRIMARY_SHOW_ID,
          )
          .one().revision,
      ).toBe(0);
    });
  });

  it("records command IDs idempotently and never reopens a submitted judge", async () => {
    await withSeededShow("state-idempotent", (storage) => {
      const command = {
        type: "SELECT_ACT",
        protocolVersion: PROTOCOL_VERSION,
        commandId: "select-once",
        expectedRevision: 0,
        actId: "act-1",
      } as const;
      const first = executeAdminCommand(
        storage,
        PRIMARY_SHOW_ID,
        { kind: "admin" },
        command,
      );
      const repeat = executeAdminCommand(
        storage,
        PRIMARY_SHOW_ID,
        { kind: "admin" },
        command,
      );
      expect(first.acknowledgement).toEqual(repeat.acknowledgement);
      expect(first.acknowledgement.revision).toBe(1);
      const conflictingReplay = executeAdminCommand(
        storage,
        PRIMARY_SHOW_ID,
        { kind: "admin" },
        {
          ...command,
          type: "SELECT_ACT",
          actId: "act-2",
        },
      );
      expect(conflictingReplay.acknowledgement.status).toBe("conflict");

      storage.sql.exec(
        `INSERT INTO judge_submissions (
          show_id, act_id, judge_id, raw_input, parsed_classification,
          finite_value, effective_score, submitted_at
        ) VALUES (?, ?, ?, '8', 'FINITE', 8, 8, ?)`,
        PRIMARY_SHOW_ID,
        "act-1",
        "judge-1",
        now,
      );
      const reopen = executeAdminCommand(
        storage,
        PRIMARY_SHOW_ID,
        { kind: "admin" },
        {
          type: "OPEN_JUDGE",
          protocolVersion: PROTOCOL_VERSION,
          commandId: "reopen-submitted",
          expectedRevision: 1,
          judgeId: "judge-1",
        },
      );
      expect(reopen.acknowledgement.status).toBe("rejected");
      expect(reopen.acknowledgement.reason).toContain("cannot be reopened");
    });
  });
});
