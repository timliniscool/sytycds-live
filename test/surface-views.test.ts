import { describe, expect, it } from "vitest";

import {
  actId,
  judgeId,
  showId,
  showRevision,
  type AudienceShowProjection,
  type JudgeShowProjection,
  type PublicAct,
} from "../shared/domain";
import { deriveJudgeView, previewJudgeInput } from "../src/judge/judge-view";
import { deriveVoteView, type VoteSubmission } from "../src/vote/vote-view";

const act: PublicAct = {
  id: actId("act-1"),
  order: 0,
  performerName: "Ana",
  schoolYear: "Year 11",
  actName: "Escape act",
  actType: "Variety",
  publicDescription: "",
  withdrawn: false,
  appearance: { themeId: null, fontFamily: null },
};

function audience(
  overrides: Partial<AudienceShowProjection["show"]> = {},
  activeAct: PublicAct | null = act,
): AudienceShowProjection {
  return {
    role: "audience",
    show: {
      title: "Show",
      shortName: "",
      themeId: "navy-bismarck",
      fontFamily: "system-ui",
      reactionsEnabled: true,
      intermissionMessage: "Back in 15 minutes",
      emergencyMessage: "",
      displayMode: "PERFORMANCE",
      activeActId: activeAct?.id ?? null,
      audienceVoteState: "CLOSED",
      revision: showRevision(4),
      ...overrides,
    },
    activeAct,
    revealedResult: null,
    publicResults: null,
    voteCloseRevision: null,
  };
}

const idle: VoteSubmission = { kind: "idle" };

describe("audience view state", () => {
  it("waits for a projection before showing anything else", () => {
    expect(
      deriveVoteView({
        connection: "CONNECTING",
        projection: null,
        submission: idle,
        sawVotingOpen: false,
      }).kind,
    ).toBe("CONNECTING");
  });

  it("ends the session on a terminal connection state", () => {
    expect(
      deriveVoteView({
        connection: "INCOMPATIBLE",
        projection: audience(),
        submission: idle,
        sawVotingOpen: false,
      }).kind,
    ).toBe("UNAVAILABLE");
  });

  it("offers the selector only while voting is open for an act", () => {
    expect(
      deriveVoteView({
        connection: "LIVE",
        projection: audience({ audienceVoteState: "OPEN" }),
        submission: idle,
        sawVotingOpen: true,
      }).kind,
    ).toBe("VOTING");
    expect(
      deriveVoteView({
        connection: "LIVE",
        projection: audience({ audienceVoteState: "OPEN" }, null),
        submission: idle,
        sawVotingOpen: false,
      }).kind,
    ).toBe("LOBBY");
  });

  it("keeps a locked score visible even while voting is still open", () => {
    const view = deriveVoteView({
      connection: "LIVE",
      projection: audience({ audienceVoteState: "OPEN" }),
      submission: { kind: "locked", score: 7 },
      sawVotingOpen: true,
    });
    expect(view).toMatchObject({ kind: "LOCKED", score: 7 });
  });

  it("separates an act that has not opened from one that has closed", () => {
    expect(
      deriveVoteView({
        connection: "LIVE",
        projection: audience(),
        submission: idle,
        sawVotingOpen: false,
      }).kind,
    ).toBe("ACT");
    expect(
      deriveVoteView({
        connection: "LIVE",
        projection: audience(),
        submission: idle,
        sawVotingOpen: true,
      }).kind,
    ).toBe("CLOSED");
  });

  it("mirrors the projector for intermission, hold, emergency and final results", () => {
    expect(
      deriveVoteView({
        connection: "LIVE",
        projection: audience({ displayMode: "INTERMISSION" }),
        submission: idle,
        sawVotingOpen: false,
      }),
    ).toEqual({ kind: "INTERMISSION", message: "Back in 15 minutes" });
    for (const [displayMode, expected] of [
      ["HOLD", "HOLD"],
      ["EMERGENCY", "EMERGENCY"],
      ["FINAL_RESULTS", "RESULTS"],
    ] as const) {
      expect(
        deriveVoteView({
          connection: "LIVE",
          projection: audience({ displayMode }),
          submission: idle,
          sawVotingOpen: false,
        }).kind,
      ).toBe(expected);
    }
  });
});

function judge(
  permission: "OPEN" | "CLOSED",
  submission: JudgeShowProjection["submission"] = null,
  activeAct: PublicAct | null = act,
): JudgeShowProjection {
  return {
    role: "judge",
    show: {
      title: "Show",
      shortName: "",
      themeId: "navy-bismarck",
      fontFamily: "system-ui",
      activeActId: activeAct?.id ?? null,
      revision: showRevision(4),
    },
    activeAct,
    permission,
    submission,
  };
}

describe("adjudicator view state", () => {
  it("reports a refused link instead of retrying forever", () => {
    expect(
      deriveJudgeView({ connection: "UNAUTHORISED", projection: null }).kind,
    ).toBe("REJECTED");
  });

  it("waits for an act before offering score entry", () => {
    expect(
      deriveJudgeView({
        connection: "LIVE",
        projection: judge("OPEN", null, null),
      }).kind,
    ).toBe("WAITING");
  });

  it("locks on a submitted score even if scoring is reopened", () => {
    const view = deriveJudgeView({
      connection: "LIVE",
      projection: judge("OPEN", {
        showId: showId("primary"),
        actId: act.id,
        judgeId: judgeId("judge-1"),
        input: { raw: "20" },
        parsed: { classification: "FINITE", finiteValue: 20 },
        effectiveScore: 11.000132,
        submittedAt: "2026-09-14T00:00:00.000Z",
      }),
    });
    expect(view.kind).toBe("LOCKED");
  });

  it("tracks permission when nothing has been submitted", () => {
    expect(
      deriveJudgeView({ connection: "LIVE", projection: judge("OPEN") }).kind,
    ).toBe("OPEN");
    expect(
      deriveJudgeView({ connection: "LIVE", projection: judge("CLOSED") }).kind,
    ).toBe("CLOSED");
  });
});

describe("adjudicator input preview", () => {
  it("stays silent when the typed number is the number that counts", () => {
    expect(previewJudgeInput("8")).toEqual({
      status: "valid",
      effectiveScore: 8,
      transform: null,
    });
    expect(previewJudgeInput("8.5").transform).toBeNull();
  });

  it("shows the tapered value when the transform changes the score", () => {
    expect(previewJudgeInput("20").transform).toBe("effective 11.000");
    expect(previewJudgeInput("Infinity").transform).toBe("effective 15.000");
    expect(previewJudgeInput("-inf").transform).toBe("effective -5.000");
  });

  it("resolves a symbol to its value without claiming a transform", () => {
    expect(previewJudgeInput("π").transform).toBe("3.14159");
  });

  it("rejects expressions and anything else the server would refuse", () => {
    expect(previewJudgeInput("5+5").status).toBe("invalid");
    expect(previewJudgeInput("").status).toBe("empty");
    expect(previewJudgeInput("9".repeat(200)).status).toBe("too_long");
  });
});
