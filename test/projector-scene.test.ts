import { describe, expect, it } from "vitest";

import {
  actId,
  cueId,
  showId,
  showRevision,
  type ProjectorCue,
  type ProjectorShowProjection,
  type PublicAct,
} from "../shared/domain";
import { deriveScene, joinUrlFor } from "../src/projector/scene";
import {
  audienceReadout,
  judgeTile,
  stepTowards,
} from "../src/projector/scoreboard-view";

const act: PublicAct = {
  id: actId("act-1"),
  order: 0,
  performerName: "Ana",
  schoolYear: "Year 11",
  actName: "Escape act",
  actType: "Variety",
  publicDescription: "",
  withdrawn: false,
};

const imageCue: ProjectorCue = {
  id: cueId("cue-image"),
  showId: showId("primary"),
  actId: act.id,
  position: 0,
  visual: { kind: "IMAGE", sourceKey: "asset-1", title: null },
  audio: null,
  durationMs: null,
  operations: [],
};

const titleCue: ProjectorCue = {
  ...imageCue,
  id: cueId("cue-title"),
  visual: { kind: "TITLE_CARD", sourceKey: null, title: "Finale" },
};

function projection(
  overrides: Partial<ProjectorShowProjection["show"]> = {},
  runtime: Partial<ProjectorShowProjection["runtime"]> = {},
): ProjectorShowProjection {
  return {
    role: "projector",
    show: {
      title: "Show",
      tagline: "",
      intermissionMessage: "Back at 8",
      emergencyMessage: "",
      displayMode: "PERFORMANCE",
      activeActId: act.id,
      revision: showRevision(3),
      ...overrides,
    },
    activeAct: act,
    activeCues: [imageCue, titleCue],
    runtime: {
      preparedCueId: null,
      activeVisualCueId: imageCue.id,
      activeAudioCueId: null,
      visualTransport: "PLAYING",
      audioTransport: "STOPPED",
      blackScreen: false,
      emergencyPresentation: "BLACK",
      ...runtime,
    },
    scoreboard: { audience: null, judges: [] },
    revealedResult: null,
    publicResults: null,
    joinUrl: null,
  };
}

describe("projector scene derivation", () => {
  it("shows the media layer over an empty stage during a performance", () => {
    const scene = deriveScene(projection(), "LIVE", "http://localhost:5173");
    expect(scene.base.kind).toBe("STAGE");
    expect(scene.layer).toEqual({ kind: "MEDIA" });
    expect(scene.mediaVisible).toBe(true);
  });

  it("renders a title card from the visual channel without a media frame", () => {
    const scene = deriveScene(
      projection({}, { activeVisualCueId: titleCue.id }),
      "LIVE",
      "http://localhost:5173",
    );
    expect(scene.layer).toEqual({ kind: "TITLE_CARD", title: "Finale" });
  });

  it("black screen wins over any active visual", () => {
    expect(
      deriveScene(projection({}, { blackScreen: true }), "LIVE", "x").layer,
    ).toEqual({ kind: "BLACK" });
  });

  it("hides the visual layer under overrides and score graphics", () => {
    for (const mode of [
      "HOLD",
      "EMERGENCY",
      "SCOREBOARD",
      "FINAL_RESULTS",
    ] as const) {
      const scene = deriveScene(projection({ displayMode: mode }), "LIVE", "x");
      expect(scene.mediaVisible).toBe(false);
      expect(scene.layer).toEqual({ kind: "NONE" });
    }
    expect(
      deriveScene(projection({ displayMode: "EMERGENCY" }), "LIVE", "x").base,
    ).toEqual({ kind: "EMERGENCY", presentation: "BLACK", message: "" });
    expect(
      deriveScene(projection({ displayMode: "INTERMISSION" }), "LIVE", "x")
        .base,
    ).toEqual({ kind: "INTERMISSION", message: "Back at 8" });
  });

  it("uses the configured origin for the QR and falls back to the client origin", () => {
    expect(joinUrlFor(null, "http://localhost:5173")).toBe(
      "http://localhost:5173/vote",
    );
    expect(
      joinUrlFor("https://show.school.nz/vote", "http://localhost:5173"),
    ).toBe("https://show.school.nz/vote");
    const lobby = deriveScene(
      {
        ...projection({ displayMode: "LOBBY" }),
        joinUrl: "https://s.example/vote",
      },
      "LIVE",
      "http://localhost:5173",
    ).base;
    expect(lobby).toMatchObject({
      kind: "LOBBY",
      joinUrl: "https://s.example/vote",
    });
    expect(JSON.stringify(lobby)).not.toContain("/judge/");
  });

  it("reports connection problems before any projection exists", () => {
    expect(deriveScene(null, "UNAUTHORISED", "x").base).toEqual({
      kind: "CONNECTING",
      unauthorised: true,
    });
  });
});

describe("scoreboard presentation", () => {
  it("never shows zero for a missing judge", () => {
    expect(
      judgeTile({ slot: 1, displayName: "Sam", submission: null }),
    ).toEqual({
      name: "Sam",
      primary: "WAITING",
      secondary: null,
      waiting: true,
    });
  });

  it("shows the raw entry and adds the effective score only when it differs", () => {
    expect(
      judgeTile({
        slot: 1,
        displayName: "Sam",
        submission: {
          raw: "8.5",
          parsed: { classification: "FINITE", finiteValue: 8.5 },
          effectiveScore: 8.5,
        },
      }),
    ).toMatchObject({ primary: "8.5", secondary: null });
    expect(
      judgeTile({
        slot: 2,
        displayName: "Lee",
        submission: {
          raw: "Infinity",
          parsed: { classification: "POSITIVE_INFINITY", finiteValue: null },
          effectiveScore: 15,
        },
      }),
    ).toMatchObject({ primary: "∞", secondary: "counts as 15.00" });
    expect(
      judgeTile({
        slot: 3,
        displayName: "Kim",
        submission: {
          raw: "π",
          parsed: { classification: "FINITE", finiteValue: Math.PI },
          effectiveScore: Math.PI,
        },
      }),
    ).toMatchObject({ primary: "π", secondary: null });
    expect(
      judgeTile({
        slot: 4,
        displayName: "Jo",
        submission: {
          raw: "1000000000",
          parsed: { classification: "FINITE", finiteValue: 1e9 },
          effectiveScore: 12.1,
        },
      }),
    ).toMatchObject({ primary: "1.00e9", secondary: "counts as 12.10" });
  });

  it("reads the audience aggregate without inventing a score", () => {
    expect(audienceReadout(null)).toEqual({
      score: "—",
      count: 0,
      hasVotes: false,
    });
    expect(
      audienceReadout({
        showId: showId("primary"),
        actId: act.id,
        voteCount: 12,
        weightedSum: 80,
        totalWeight: 10.5,
        weightedMean: 7.6190476,
      }),
    ).toEqual({ score: "7.62", count: 12, hasVotes: true });
  });

  it("animation reaches the authoritative value exactly", () => {
    expect(stepTowards(0, 7.5, 1_000, 450)).toBe(7.5);
    expect(stepTowards(0, 7.5, 0, 450)).toBe(0);
    const midway = stepTowards(0, 7.5, 225, 450);
    expect(midway).toBeGreaterThan(0);
    expect(midway).toBeLessThan(7.5);
  });
});
