import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { PROTOCOL_VERSION } from "../shared/domain";
import {
  auditEventForCommand,
  isVoteMilestone,
  listAuditEvents,
  recordAuditEvent,
} from "../worker/audit";
import { submitAudienceVote } from "../worker/audience-votes";
import { PRIMARY_SHOW_ID, executeAdminCommand } from "../worker/show-state";

const now = "2026-09-14T00:00:00.000Z";

function seed(sql: SqlStorage): void {
  sql.exec(
    `INSERT INTO shows (id, title, display_mode, audience_vote_state, result_reveal_state,
       active_act_id, revision, created_at, updated_at)
     VALUES (?, 'Show', 'PERFORMANCE', 'OPEN', 'HIDDEN', 'act-1', 0, ?, ?)`,
    PRIMARY_SHOW_ID,
    now,
    now,
  );
  sql.exec(
    `INSERT INTO acts (id, show_id, order_index, performer_name, school_year, act_name,
       act_type, public_description, internal_notes, created_at, updated_at)
     VALUES ('act-1', ?, 0, 'P', 'Y', 'A', 'Music', '', '', ?, ?)`,
    PRIMARY_SHOW_ID,
    now,
    now,
  );
}

describe("operational audit log", () => {
  it("translates commands into typed events without secrets", () => {
    const base = {
      protocolVersion: PROTOCOL_VERSION,
      commandId: "c1",
      expectedRevision: 0,
    } as const;
    expect(
      auditEventForCommand(
        { ...base, type: "ACTIVATE_EMERGENCY", presentation: "TEXT" } as never,
        { commandId: null, status: "accepted", revision: 1 as never },
      ),
    ).toMatchObject({
      type: "emergency.activated",
      data: { presentation: "TEXT" },
    });
    expect(
      auditEventForCommand(
        {
          ...base,
          type: "SET_INTERMISSION_MESSAGE",
          text: "secret text",
        } as never,
        { commandId: null, status: "accepted", revision: 1 as never },
      ).data,
    ).toEqual({ which: "intermission", length: 11 });
    expect(
      auditEventForCommand({ ...base, type: "NEXT_ACT" } as never, {
        commandId: null,
        status: "rejected",
        revision: 1 as never,
        reason: "There is no next act",
      }),
    ).toMatchObject({
      type: "command.refused",
      data: { command: "NEXT_ACT", reason: "There is no next act" },
    });
  });

  it("logs milestones, not every vote", () => {
    expect(
      [1, 10, 25, 50, 100, 250, 500, 1000, 1500].every(isVoteMilestone),
    ).toBe(true);
    expect([2, 11, 99, 501, 1001].some(isVoteMilestone)).toBe(false);
  });

  it("appends events from the transaction paths and pages them newest first", async () => {
    const stub = env.SHOW_COORDINATOR.get(
      env.SHOW_COORDINATOR.idFromName("audit-log"),
    );
    await stub.fetch("https://show.internal/health");
    await runInDurableObject(stub, (_instance, state) => {
      seed(state.storage.sql);
      executeAdminCommand(
        state.storage,
        PRIMARY_SHOW_ID,
        { kind: "admin" },
        {
          type: "SET_DISPLAY_MODE",
          protocolVersion: PROTOCOL_VERSION,
          commandId: "display",
          expectedRevision: 0,
          mode: "SCOREBOARD",
        },
      );
      for (let voter = 0; voter < 12; voter += 1) {
        submitAudienceVote(
          state.storage,
          PRIMARY_SHOW_ID,
          new Uint8Array(32).fill(voter + 1).buffer,
          { actIdentifier: "act-1", score: 7 },
        );
      }
      recordAuditEvent(state.storage.sql, "not-a-show", {
        type: "ignored",
        actor: "system",
      });

      const first = listAuditEvents(
        state.storage.sql,
        PRIMARY_SHOW_ID,
        null,
        2,
      );
      expect(first.events.map((event) => event.type)).toEqual([
        "audience.milestone",
        "audience.milestone",
      ]);
      expect(first.events[0]?.data).toEqual({ actId: "act-1", voteCount: 10 });
      expect(first.nextBefore).toBe(first.events[1]?.id ?? null);

      const rest = listAuditEvents(
        state.storage.sql,
        PRIMARY_SHOW_ID,
        first.nextBefore,
        50,
      );
      expect(rest.events.map((event) => event.type)).toEqual([
        "display.changed",
      ]);
      expect(rest.nextBefore).toBeNull();
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM audit_events WHERE show_id = ?",
            PRIMARY_SHOW_ID,
          )
          .one().count,
      ).toBe(3);
    });
  });
});
