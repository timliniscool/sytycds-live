import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { PROTOCOL_VERSION } from "../shared/domain";
import { runServerPreflight } from "../worker/preflight";
import {
  PRIMARY_SHOW_ID,
  executeAdminCommand,
  projectShowState,
} from "../worker/show-state";

const now = "2026-09-14T00:00:00.000Z";

function seed(sql: SqlStorage): void {
  sql.exec(
    `INSERT INTO shows (id, title, display_mode, audience_vote_state, result_reveal_state,
       active_act_id, revision, created_at, updated_at)
     VALUES (?, 'Show', 'PERFORMANCE', 'CLOSED', 'HIDDEN', 'act-1', 0, ?, ?)`,
    PRIMARY_SHOW_ID,
    now,
    now,
  );
  ["act-1", "act-2", "act-3"].forEach((id, order) =>
    sql.exec(
      `INSERT INTO acts (id, show_id, order_index, performer_name, school_year, act_name,
         act_type, public_description, internal_notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'Year 10', ?, 'Music', '', 'BACKSTAGE', ?, ?)`,
      id,
      PRIMARY_SHOW_ID,
      order,
      `Performer ${order + 1}`,
      id,
      now,
      now,
    ),
  );
  [1, 2, 3, 4].forEach((slot) =>
    sql.exec(
      `INSERT INTO judges (id, show_id, slot, display_name, token_hash, created_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      `judge-${slot}`,
      PRIMARY_SHOW_ID,
      slot,
      `Judge ${slot}`,
      new Uint8Array(32).fill(slot).buffer,
      now,
    ),
  );
  sql.exec(
    `INSERT INTO cues (id, show_id, act_id, position, visual_kind, visual_source_key, visual_title,
       audio_kind, audio_source_key, duration_ms, created_at, updated_at, operator_label,
       operations_json, internal_note)
     VALUES ('cue-audio', ?, 'act-1', 0, NULL, NULL, NULL, 'AUDIO', 'asset-audio', NULL, ?, ?,
       'Track', '[{"kind":"audio","action":"LOAD","assetId":"asset-audio"}]', '')`,
    PRIMARY_SHOW_ID,
    now,
    now,
  );
  sql.exec(
    `INSERT INTO media_assets (id, show_id, object_key, original_filename, mime_type, size_bytes,
       version_identifier, duration_ms, width, height, uploaded_at, deleted_at)
     VALUES ('asset-audio', ?, 'primary/asset-audio', 'track.mp3', 'audio/mpeg', 10, 'v1', NULL, NULL, NULL, ?, NULL)`,
    PRIMARY_SHOW_ID,
    now,
  );
  sql.exec(
    "INSERT INTO cue_asset_references (show_id, cue_id, asset_id) VALUES (?, 'cue-audio', 'asset-audio')",
    PRIMARY_SHOW_ID,
  );
}

function finalise(sql: SqlStorage, actIdentifier: string, score: number): void {
  sql.exec(
    `INSERT INTO finalised_results (show_id, act_id, audience_mean, judge_1_effective_score,
       judge_2_effective_score, judge_3_effective_score, judge_4_effective_score, final_score, finalised_at)
     VALUES (?, ?, 8, 8, 8, 8, 8, ?, ?)`,
    PRIMARY_SHOW_ID,
    actIdentifier,
    score,
    now,
  );
}

let counter = 0;

function command(
  storage: DurableObjectStorage,
  type: string,
  extras: Record<string, unknown> = {},
) {
  const revision = storage.sql
    .exec<{ revision: number }>(
      "SELECT revision FROM shows WHERE id = ?",
      PRIMARY_SHOW_ID,
    )
    .one().revision;
  counter += 1;
  return executeAdminCommand(
    storage,
    PRIMARY_SHOW_ID,
    { kind: "admin" },
    {
      type,
      protocolVersion: PROTOCOL_VERSION,
      commandId: `public-${counter}`,
      expectedRevision: revision,
      ...extras,
    },
  );
}

function showRow(storage: DurableObjectStorage) {
  return storage.sql
    .exec<{
      display_mode: string;
      active_act_id: string;
      audience_vote_state: string;
      intermission_message: string;
    }>(
      "SELECT display_mode, active_act_id, audience_vote_state, intermission_message FROM shows WHERE id = ?",
      PRIMARY_SHOW_ID,
    )
    .one();
}

function runtimeRow(storage: DurableObjectStorage) {
  return storage.sql
    .exec<{
      previous_display_mode: string | null;
      audio_transport: string;
      active_audio_cue_id: string | null;
      emergency_presentation: string;
      results_stage: string;
      results_revealed_groups: number;
    }>(
      `SELECT previous_display_mode, audio_transport, active_audio_cue_id,
              emergency_presentation, results_stage, results_revealed_groups
       FROM show_runtime WHERE show_id = ?`,
      PRIMARY_SHOW_ID,
    )
    .one();
}

async function withShow(
  name: string,
  test: (storage: DurableObjectStorage) => Promise<void> | void,
): Promise<void> {
  const stub = env.SHOW_COORDINATOR.get(env.SHOW_COORDINATOR.idFromName(name));
  await stub.fetch("https://show.internal/health");
  await runInDurableObject(stub, async (_instance, state) => {
    seed(state.storage.sql);
    await test(state.storage);
  });
}

describe("intermission, hold and emergency", () => {
  it("emergency overrides output at once, pauses audio, keeps state, and restores", async () => {
    await withShow("emergency", (storage) => {
      command(storage, "PLAY_CUE", { cueId: "cue-audio" });
      command(storage, "OPEN_AUDIENCE_VOTING");
      expect(runtimeRow(storage).audio_transport).toBe("PLAYING");

      const activated = command(storage, "ACTIVATE_EMERGENCY", {
        presentation: "TEXT",
      });
      expect(activated.acknowledgement.status).toBe("accepted");
      expect(activated.changes).toEqual(["display", "media"]);
      const during = runtimeRow(storage);
      expect(showRow(storage)).toMatchObject({
        display_mode: "EMERGENCY",
        active_act_id: "act-1",
        audience_vote_state: "OPEN",
      });
      expect(during).toMatchObject({
        previous_display_mode: "PERFORMANCE",
        audio_transport: "PAUSED",
        active_audio_cue_id: "cue-audio",
        emergency_presentation: "TEXT",
      });

      // Switching presentation while active keeps the same restore target.
      command(storage, "ACTIVATE_EMERGENCY", { presentation: "BLACK" });
      expect(runtimeRow(storage)).toMatchObject({
        previous_display_mode: "PERFORMANCE",
        emergency_presentation: "BLACK",
      });

      const restored = command(storage, "RESTORE_DISPLAY");
      expect(restored.acknowledgement.status).toBe("accepted");
      expect(showRow(storage)).toMatchObject({
        display_mode: "PERFORMANCE",
        active_act_id: "act-1",
        audience_vote_state: "OPEN",
      });
      // Audio stays paused until the operator resumes; nothing was destroyed.
      expect(runtimeRow(storage)).toMatchObject({
        audio_transport: "PAUSED",
        active_audio_cue_id: "cue-audio",
        previous_display_mode: null,
      });
      expect(command(storage, "RESUME_MEDIA").acknowledgement.status).toBe(
        "accepted",
      );
      expect(runtimeRow(storage).audio_transport).toBe("PLAYING");
    });
  });

  it("hold preserves context and leaves media alone", async () => {
    await withShow("hold", (storage) => {
      command(storage, "PLAY_CUE", { cueId: "cue-audio" });
      command(storage, "SET_DISPLAY_MODE", { mode: "HOLD" });
      expect(runtimeRow(storage).audio_transport).toBe("PLAYING");
      expect(showRow(storage).display_mode).toBe("HOLD");
      command(storage, "RESTORE_DISPLAY");
      expect(showRow(storage).display_mode).toBe("PERFORMANCE");
    });
  });

  it("intermission text reaches phones and the projector without touching results", async () => {
    await withShow("intermission", (storage) => {
      finalise(storage.sql, "act-1", 8);
      expect(
        command(storage, "SET_INTERMISSION_MESSAGE", {
          text: "  Back  at   8.15pm  ",
        }).acknowledgement.status,
      ).toBe("accepted");
      command(storage, "SET_DISPLAY_MODE", { mode: "INTERMISSION" });
      const audience = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "audience",
      });
      const projector = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "projector",
      });
      expect(audience?.role === "audience" && audience.show).toMatchObject({
        displayMode: "INTERMISSION",
        intermissionMessage: "Back at 8.15pm",
        activeActId: "act-1",
      });
      expect(
        projector?.role === "projector" && projector.show.intermissionMessage,
      ).toBe("Back at 8.15pm");
      expect(
        storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM finalised_results WHERE show_id = ?",
            PRIMARY_SHOW_ID,
          )
          .one().count,
      ).toBe(1);
      expect(
        command(storage, "SET_EMERGENCY_MESSAGE", { text: "x".repeat(201) })
          .acknowledgement.status,
      ).toBe("invalid");
    });
  });
});

describe("final results and ranking", () => {
  it("refuses a public stage with nothing finalised and never leaks the ranking while hidden", async () => {
    await withShow("results-hidden", (storage) => {
      expect(
        command(storage, "SET_RESULTS_STAGE", { stage: "LEADERBOARD" })
          .acknowledgement.status,
      ).toBe("rejected");
      finalise(storage.sql, "act-1", 9.5);
      finalise(storage.sql, "act-2", 9.5);
      const audience = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "audience",
      });
      const projector = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "projector",
      });
      expect(
        audience?.role === "audience" && audience.publicResults,
      ).toBeNull();
      expect(
        projector?.role === "projector" && projector.publicResults,
      ).toBeNull();
      expect(JSON.stringify(audience)).not.toContain("9.5");
      const admin = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "admin",
      });
      expect(admin?.role === "admin" && admin.ranking.ranked).toHaveLength(2);
    });
  });

  it("stages a reveal by rank group, ties intact, and excludes withdrawn acts", async () => {
    await withShow("results-staged", (storage) => {
      finalise(storage.sql, "act-1", 7);
      finalise(storage.sql, "act-2", 9);
      finalise(storage.sql, "act-3", 9);
      expect(
        command(storage, "REVEAL_NEXT_RESULT").acknowledgement.status,
      ).toBe("rejected");
      expect(
        command(storage, "SET_RESULTS_STAGE", { stage: "STAGED" })
          .acknowledgement.status,
      ).toBe("accepted");
      const hidden = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "audience",
      });
      expect(hidden?.role === "audience" && hidden.publicResults).toMatchObject(
        {
          stage: "STAGED",
          entries: [],
          pendingGroups: 2,
          totalGroups: 2,
          totalEntries: 3,
        },
      );

      command(storage, "REVEAL_NEXT_RESULT");
      const third = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "projector",
      });
      expect(
        third?.role === "projector" &&
          third.publicResults?.entries.map((entry) => [
            entry.actId,
            entry.rank,
          ]),
      ).toEqual([["act-1", 2]]);

      command(storage, "REVEAL_NEXT_RESULT");
      const all = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "projector",
      });
      expect(
        all?.role === "projector" &&
          all.publicResults?.entries.map((entry) => [
            entry.actId,
            entry.rank,
            entry.tied,
          ]),
      ).toEqual([
        ["act-2", 1, true],
        ["act-3", 1, true],
        // Dense ranking: the score below two joint firsts is second, not third.
        ["act-1", 2, false],
      ]);
      expect(
        command(storage, "REVEAL_NEXT_RESULT").acknowledgement.reason,
      ).toContain("Every rank");

      // Withdrawing a joint winner leaves a single winner and a clean rank.
      expect(
        command(storage, "WITHDRAW_ACT", { actId: "act-1" }).acknowledgement
          .status,
      ).toBe("rejected");
      expect(
        command(storage, "WITHDRAW_ACT", { actId: "act-3" }).acknowledgement
          .status,
      ).toBe("accepted");
      command(storage, "SET_RESULTS_STAGE", { stage: "WINNER" });
      const winner = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "audience",
      });
      expect(
        winner?.role === "audience" &&
          winner.publicResults?.entries.map((entry) => [
            entry.actId,
            entry.tied,
          ]),
      ).toEqual([["act-2", false]]);
      const admin = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "admin",
      });
      expect(
        admin?.role === "admin" && admin.ranking.withdrawn.map((act) => act.id),
      ).toEqual(["act-3"]);
      // NEXT skips a withdrawn act.
      command(storage, "SELECT_ACT", { actId: "act-2" });
      expect(command(storage, "NEXT_ACT").acknowledgement.reason).toBe(
        "There is no next act",
      );
      command(storage, "REINSTATE_ACT", { actId: "act-3" });
      expect(command(storage, "NEXT_ACT").acknowledgement.status).toBe(
        "accepted",
      );
    });
  });

  it("gives the projector scoreboard judge scores but withholds the final until revealed", async () => {
    await withShow("scoreboard", (storage) => {
      storage.sql.exec(
        `INSERT INTO judge_submissions (show_id, act_id, judge_id, raw_input, parsed_classification,
           finite_value, effective_score, submitted_at)
         VALUES (?, 'act-1', 'judge-1', '20', 'FINITE', 20, 11, ?)`,
        PRIMARY_SHOW_ID,
        now,
      );
      storage.sql.exec(
        `INSERT INTO audience_aggregates (show_id, act_id, vote_count, weighted_sum, total_weight,
           weighted_mean, updated_at) VALUES (?, 'act-1', 3, 21, 3, 7, ?)`,
        PRIMARY_SHOW_ID,
        now,
      );
      finalise(storage.sql, "act-1", 8.25);
      const before = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "projector",
      });
      if (before?.role !== "projector") throw new Error("projector projection");
      expect(before.scoreboard.judges).toHaveLength(4);
      expect(before.scoreboard.judges[0]?.submission).toMatchObject({
        raw: "20",
        effectiveScore: 11,
      });
      expect(before.scoreboard.judges[1]?.submission).toBeNull();
      expect(before.scoreboard.audience?.voteCount).toBe(3);
      expect(before.revealedResult).toBeNull();
      expect(JSON.stringify(before)).not.toContain("8.25");

      command(storage, "REVEAL_RESULT");
      const after = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "projector",
      });
      expect(after?.role === "projector" && after.revealedResult).toBe(8.25);
    });
  });
});

describe("server preflight", () => {
  it("classifies each probe with an actionable detail", async () => {
    await withShow("preflight", async (storage) => {
      const bucket = {
        head: async (key: string) =>
          key === "primary/asset-audio"
            ? ({ key } as unknown as R2Object)
            : null,
      } as unknown as R2Bucket;
      const items = await runServerPreflight({
        sql: storage.sql,
        bucket,
        env: { PUBLIC_ORIGIN: "not a url" },
        showIdentifier: PRIMARY_SHOW_ID,
        sockets: {
          projectors: 0,
          projectorProtocolVersions: [],
          connectedJudgeIds: new Set(["judge-1"]),
        },
      });
      const byId = new Map(items.map((item) => [item.id, item]));
      expect(byId.get("schema")?.status).toBe("READY");
      expect(byId.get("acts")?.status).toBe("READY");
      expect(byId.get("running_order")?.status).toBe("READY");
      expect(byId.get("judges")?.status).toBe("READY");
      expect(byId.get("judge_connections")).toMatchObject({
        status: "WARNING",
        required: false,
      });
      expect(byId.get("judge_connections")?.detail).toContain("Judge 2");
      expect(byId.get("projector")?.status).toBe("FAILURE");
      expect(byId.get("media_references")?.status).toBe("READY");
      expect(byId.get("r2_objects")?.status).toBe("READY");
      expect(byId.get("media_mime")?.status).toBe("READY");
      expect(byId.get("public_origin")?.status).toBe("FAILURE");

      storage.sql.exec(
        "UPDATE media_assets SET mime_type = 'image/png' WHERE id = 'asset-audio'",
      );
      const rerun = await runServerPreflight({
        sql: storage.sql,
        bucket: { head: async () => null } as unknown as R2Bucket,
        env: {},
        showIdentifier: PRIMARY_SHOW_ID,
        sockets: {
          projectors: 1,
          projectorProtocolVersions: [PROTOCOL_VERSION],
          connectedJudgeIds: new Set(),
        },
        only: "r2_objects",
      });
      expect(rerun).toHaveLength(1);
      expect(rerun[0]).toMatchObject({ id: "r2_objects", status: "FAILURE" });
      expect(rerun[0]?.detail).toContain("track.mp3");
      const mime = await runServerPreflight({
        sql: storage.sql,
        bucket,
        env: {},
        showIdentifier: PRIMARY_SHOW_ID,
        sockets: {
          projectors: 1,
          projectorProtocolVersions: [PROTOCOL_VERSION],
          connectedJudgeIds: new Set(),
        },
        only: "media_mime",
      });
      expect(mime[0]).toMatchObject({ status: "FAILURE" });
      expect(mime[0]?.detail).toContain("used as AUDIO");
    });
  });
});
