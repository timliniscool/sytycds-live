import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { actIdentity } from "../shared/act-identity";
import type { PublicAct } from "../shared/domain";
import { actId } from "../shared/domain";
import { createAct, deleteAct, editAct, parseActInput } from "../worker/acts";
import { loadRanking } from "../worker/rankings";
import { finaliseResult } from "../worker/results";
import { upsertShow } from "../worker/show-config";
import { clearShowData } from "../worker/show-reset";
import { PRIMARY_SHOW_ID, projectShowState } from "../worker/show-state";

const names = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `performer-${index + 1}`,
    name: `Member ${index + 1}`,
  }));

function identityAct(
  performers: ReturnType<typeof names>,
  groupName = "",
): PublicAct {
  return {
    id: actId("act-matrix"),
    order: 0,
    performerName: performers[0]?.name ?? "Performer",
    performers,
    performerCount: performers.length,
    groupName,
    performerDisplayMode: "AUTOMATIC",
    schoolYear: "Year 10",
    actName: "Act",
    actType: "Music",
    publicDescription: "",
    withdrawn: false,
    appearance: { themeId: null, fontFamily: null },
  };
}

function groupInput(overrides: Record<string, unknown> = {}) {
  const parsed = parseActInput({
    performers: names(3),
    groupName: "The Jazz Collective",
    performerDisplayMode: "AUTOMATIC",
    schoolYear: "Years 10–12",
    actName: "Valerie",
    actType: "Music",
    publicDescription: "Public copy",
    internalNotes: "Private running note",
    publicImageAssetId: null,
    showDescriptionToAudience: false,
    showImageToAudience: false,
    showFullMemberListToAudience: false,
    presentation: {
      performanceMode: "DEFAULT",
      performanceAssetId: null,
      performanceFit: "contain",
      backingAudioAssetId: null,
      backingAudioStart: "MANUAL",
    },
    appearance: { themeId: null, fontFamily: null },
    ...overrides,
  });
  if (!parsed) throw new Error("invalid group fixture");
  return parsed;
}

async function withShow(
  name: string,
  run: (storage: DurableObjectStorage) => void | Promise<void>,
) {
  const stub = env.SHOW_COORDINATOR.get(env.SHOW_COORDINATOR.idFromName(name));
  await stub.fetch("https://show.internal/health");
  await runInDurableObject(stub, async (_instance, state) => {
    upsertShow(state.storage, PRIMARY_SHOW_ID, {
      title: "Group test",
      tagline: "",
    });
    await run(state.storage);
  });
}

describe("shared solo/group identity", () => {
  it("applies the five automatic projector cases", () => {
    expect(
      actIdentity(identityAct([{ id: "performer-1", name: "Alice" }])),
    ).toMatchObject({
      primary: "Alice",
      secondary: null,
    });
    expect(actIdentity(identityAct(names(3)))).toMatchObject({
      primary: "Member 1 · Member 2 · Member 3",
      secondary: null,
    });
    expect(
      actIdentity(identityAct(names(4), "The Jazz Collective")),
    ).toMatchObject({
      primary: "The Jazz Collective",
      secondary: "Member 1 · Member 2 · Member 3 · Member 4",
    });
    expect(
      actIdentity(identityAct(names(12), "North Sydney Chamber Ensemble")),
    ).toMatchObject({
      primary: "North Sydney Chamber Ensemble",
      secondary: "12 performers",
    });
    expect(actIdentity(identityAct(names(12)))).toMatchObject({
      primary: "Ensemble · 12 performers",
      secondary: null,
    });
  });

  it("uses rendered-line length as well as count", () => {
    const long = identityAct([
      { id: "performer-1", name: "Alexandria Montgomery-Worthington" },
      { id: "performer-2", name: "Bartholomew Constantinople-Smythe" },
      { id: "performer-3", name: "Christopher Maximilian Richardson" },
    ]);
    expect(actIdentity(long).primary).toBe("Ensemble · 3 performers");
  });
});

describe("persisted group acts", () => {
  it("saves stable members, redacts the phone list, and exposes it only on opt-in", async () => {
    await withShow("group-persist-audience", (storage) => {
      const created = createAct(storage, PRIMARY_SHOW_ID, groupInput())!;
      storage.sql.exec(
        "UPDATE shows SET active_act_id = ? WHERE id = ?",
        created.id,
        PRIMARY_SHOW_ID,
      );
      const admin = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "admin",
      });
      expect(admin?.role === "admin" && admin.acts[0]?.performers).toEqual(
        names(3),
      );
      const audience = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "audience",
      });
      expect(audience?.role === "audience" && audience.activeAct).toMatchObject(
        {
          performerName: "The Jazz Collective",
          performerCount: 3,
          performers: [],
        },
      );
      expect(JSON.stringify(audience)).not.toContain("Private running note");

      expect(
        editAct(storage, PRIMARY_SHOW_ID, created.id, {
          ...groupInput(),
          showFullMemberListToAudience: true,
        }),
      ).toBe(true);
      const optedIn = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "audience",
      });
      expect(
        optedIn?.role === "audience" && optedIn.activeAct?.performers,
      ).toEqual(names(3));
    });
  });

  it("freezes group identity with the result, then cleans members on deletion and reset", async () => {
    await withShow("group-frozen-cleanup", (storage) => {
      const created = createAct(
        storage,
        PRIMARY_SHOW_ID,
        groupInput({ performers: names(12), groupName: "North Ensemble" }),
      )!;
      storage.sql.exec(
        "UPDATE shows SET audience_weight = 1 WHERE id = ?",
        PRIMARY_SHOW_ID,
      );
      storage.sql.exec(
        `INSERT INTO audience_aggregates
          (show_id, act_id, vote_count, weighted_sum, total_weight, weighted_mean, updated_at)
         VALUES (?, ?, 1, 9, 1, 9, ?)`,
        PRIMARY_SHOW_ID,
        created.id,
        new Date().toISOString(),
      );
      expect(finaliseResult(storage.sql, PRIMARY_SHOW_ID, created.id).ok).toBe(
        true,
      );
      expect(loadRanking(storage.sql, PRIMARY_SHOW_ID).ranked[0]).toMatchObject(
        {
          performerName: "North Ensemble",
          performerSubtitle: "12 performers",
        },
      );

      expect(
        editAct(
          storage,
          PRIMARY_SHOW_ID,
          created.id,
          groupInput({
            performers: names(12),
            groupName: "Renamed Live Group",
          }),
        ),
      ).toBe(true);
      expect(loadRanking(storage.sql, PRIMARY_SHOW_ID).ranked[0]).toMatchObject(
        {
          performerName: "North Ensemble",
          performerSubtitle: "12 performers",
        },
      );

      expect(deleteAct(storage, PRIMARY_SHOW_ID, created.id).ok).toBe(true);
      expect(
        storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM act_performers WHERE show_id = ?",
            PRIMARY_SHOW_ID,
          )
          .one().count,
      ).toBe(0);

      createAct(storage, PRIMARY_SHOW_ID, groupInput());
      clearShowData(storage.sql, PRIMARY_SHOW_ID);
      expect(
        storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM act_performers WHERE show_id = ?",
            PRIMARY_SHOW_ID,
          )
          .one().count,
      ).toBe(0);
    });
  });
});
