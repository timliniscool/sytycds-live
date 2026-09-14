import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { parseShowInput, upsertShow } from "../worker/show-config";
import { PRIMARY_SHOW_ID, projectShowState } from "../worker/show-state";

describe("show provisioning", () => {
  it("accepts a trimmed title and optional tagline and refuses the rest", () => {
    expect(parseShowInput({ title: "  Talent  Night ", tagline: "" })).toEqual({
      title: "Talent Night",
      tagline: "",
    });
    expect(parseShowInput({ title: "", tagline: "" })).toBeNull();
    expect(parseShowInput({ title: "x".repeat(121), tagline: "" })).toBeNull();
    expect(parseShowInput({ title: "Show" })).toBeNull();
  });

  it("creates the show with safe defaults once and renames it without touching state", async () => {
    const stub = env.SHOW_COORDINATOR.get(
      env.SHOW_COORDINATOR.idFromName("show-config"),
    );
    await stub.fetch("https://show.internal/health");
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        projectShowState(state.storage, PRIMARY_SHOW_ID, { kind: "audience" }),
      ).toBeNull();
      expect(
        upsertShow(state.storage, PRIMARY_SHOW_ID, {
          title: "Talent Night",
          tagline: "Year 9 to 13",
        }),
      ).toEqual({ created: true });
      const created = projectShowState(state.storage, PRIMARY_SHOW_ID, {
        kind: "audience",
      });
      expect(created?.role === "audience" && created.show).toMatchObject({
        title: "Talent Night",
        displayMode: "LOBBY",
        audienceVoteState: "CLOSED",
        revision: 0,
      });

      state.storage.sql.exec(
        "UPDATE shows SET display_mode = 'PERFORMANCE', audience_vote_state = 'OPEN' WHERE id = ?",
        PRIMARY_SHOW_ID,
      );
      expect(
        upsertShow(state.storage, PRIMARY_SHOW_ID, {
          title: "Talent Night 2026",
          tagline: "",
        }),
      ).toEqual({ created: false });
      const renamed = projectShowState(state.storage, PRIMARY_SHOW_ID, {
        kind: "audience",
      });
      expect(renamed?.role === "audience" && renamed.show).toMatchObject({
        title: "Talent Night 2026",
        displayMode: "PERFORMANCE",
        audienceVoteState: "OPEN",
        revision: 1,
      });
    });
  });
});
