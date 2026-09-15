import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createAct, replaceActOrder } from "../worker/acts";
import { submitJudgeScore } from "../worker/judge-submissions";
import { operationalResult } from "../worker/results";
import { PRIMARY_SHOW_ID, projectShowState } from "../worker/show-state";

const now = "2026-09-14T00:00:00.000Z";

function seed(sql: SqlStorage): void {
  sql.exec(
    `INSERT INTO shows (id,title,display_mode,audience_vote_state,result_reveal_state,active_act_id,revision,created_at,updated_at) VALUES (?, 'Show','SCOREBOARD','OPEN','HIDDEN','act-1',0,?,?)`,
    PRIMARY_SHOW_ID,
    now,
    now,
  );
  ["act-1", "act-2"].forEach((id, order) =>
    sql.exec(
      `INSERT INTO acts (id,show_id,order_index,performer_name,school_year,act_name,act_type,public_description,internal_notes,created_at,updated_at) VALUES (?,?,?,'P','Y',?,'Music','D','',?,?)`,
      id,
      PRIMARY_SHOW_ID,
      order,
      id,
      now,
      now,
    ),
  );
  [1, 2, 3, 4].forEach((slot) =>
    sql.exec(
      `INSERT INTO judges (id,show_id,slot,display_name,token_hash,created_at,revoked_at) VALUES (?,?,?,?,?,?,NULL)`,
      `judge-${slot}`,
      PRIMARY_SHOW_ID,
      slot,
      `Judge ${slot}`,
      new Uint8Array(32).fill(slot).buffer,
      now,
    ),
  );
  sql.exec(
    `INSERT INTO show_runtime (show_id,global_judge_permission,updated_at) VALUES (?,'OPEN',?)`,
    PRIMARY_SHOW_ID,
    now,
  );
}

describe("judge submission, results, and act ordering", () => {
  it("parses and permanently locks server-authoritative judge scores", async () => {
    const stub = env.SHOW_COORDINATOR.get(
      env.SHOW_COORDINATOR.idFromName("judge-submit-transaction"),
    );
    await stub.fetch("https://show.internal/health");
    await runInDurableObject(stub, (_instance, state) => {
      seed(state.storage.sql);
      const expected = [
        ["8", 8],
        ["π", Math.PI],
        ["20", 11],
        ["Infinity", 15],
      ] as const;
      expected.forEach(([raw, score], index) => {
        const outcome = submitJudgeScore(
          state.storage,
          PRIMARY_SHOW_ID,
          `judge-${index + 1}`,
          raw,
        );
        expect(outcome.ok && outcome.submission.effectiveScore).toBeCloseTo(
          score,
        );
      });
      expect(
        submitJudgeScore(state.storage, PRIMARY_SHOW_ID, "judge-1", "9"),
      ).toMatchObject({ ok: true, accepted: false });
      expect(
        submitJudgeScore(state.storage, PRIMARY_SHOW_ID, "judge-2", "5+5"),
      ).toMatchObject({ ok: true, accepted: false });
      state.storage.sql.exec(
        "UPDATE judge_permissions SET permission_state = 'CLOSED' WHERE show_id = ? AND act_id = ? AND judge_id = ?",
        PRIMARY_SHOW_ID,
        "act-1",
        "judge-4",
      );
      expect(
        submitJudgeScore(state.storage, PRIMARY_SHOW_ID, "judge-4", "6"),
      ).toMatchObject({ ok: true, accepted: false });
    });
  });

  it("keeps unrevealed final numbers out of audience/projector projections and orders acts atomically", async () => {
    const stub = env.SHOW_COORDINATOR.get(
      env.SHOW_COORDINATOR.idFromName("result-security-and-order"),
    );
    await stub.fetch("https://show.internal/health");
    await runInDurableObject(stub, (_instance, state) => {
      seed(state.storage.sql);
      state.storage.sql.exec(
        `INSERT INTO audience_aggregates (show_id,act_id,vote_count,weighted_sum,total_weight,weighted_mean,updated_at) VALUES (?, 'act-1', 1, 8, 1, 8, ?)`,
        PRIMARY_SHOW_ID,
        now,
      );
      [1, 2, 3, 4].forEach((slot) =>
        state.storage.sql.exec(
          `INSERT INTO judge_submissions (show_id,act_id,judge_id,raw_input,parsed_classification,finite_value,effective_score,submitted_at) VALUES (?, 'act-1', ?, '8','FINITE',8,8,?)`,
          PRIMARY_SHOW_ID,
          `judge-${slot}`,
          now,
        ),
      );
      expect(
        operationalResult(state.storage.sql, PRIMARY_SHOW_ID, "act-1"),
      ).toEqual({ kind: "provisional", value: 8 });
      const audience = projectShowState(state.storage, PRIMARY_SHOW_ID, {
        kind: "audience",
      });
      const projector = projectShowState(state.storage, PRIMARY_SHOW_ID, {
        kind: "projector",
      });
      expect(
        audience?.role === "audience" && audience.revealedResult,
      ).toBeNull();
      expect(
        projector?.role === "projector" && projector.revealedResult,
      ).toBeNull();
      expect(
        replaceActOrder(state.storage, PRIMARY_SHOW_ID, ["act-2", "act-1"]),
      ).toBe(true);
      expect(
        replaceActOrder(state.storage, PRIMARY_SHOW_ID, ["act-2", "act-2"]),
      ).toBe(false);
      expect(
        createAct(state.storage, PRIMARY_SHOW_ID, {
          performerName: "New",
          schoolYear: "Year 9",
          actName: "Act",
          actType: "Dance",
          publicDescription: "",
          internalNotes: "",
          showDescriptionToAudience: false,
          showImageToAudience: false,
          presentation: {
            performanceMode: "DEFAULT",
            performanceAssetId: null,
            performanceFit: "contain",
            backingAudioAssetId: null,
            backingAudioStart: "MANUAL",
          },
        })?.order,
      ).toBe(2);
    });
  });
});
