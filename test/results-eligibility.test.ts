/**
 * The Final Results panel refuses to stage a ranking that does not exist, and
 * an operator meeting a disabled button mid-show must be told why rather than
 * left to guess. These cases pin the sentence it shows in every blocked state.
 */

import { describe, expect, it } from "vitest";

import { actId, type AdminRanking, type PublicAct } from "../shared/domain";
import {
  exclusionLabel,
  whyNothingIsEligible,
} from "../src/admin/results-view";

function act(id: string, performerName: string): PublicAct {
  return {
    id: actId(id),
    order: 0,
    performerName,
    schoolYear: "Year 10",
    actName: "An act",
    actType: "Music",
    publicDescription: "",
    publicImageAssetId: null,
    withdrawn: false,
    appearance: { themeId: null, fontFamily: null },
  };
}

function ranking(overrides: Partial<AdminRanking>): AdminRanking {
  return { ranked: [], incomplete: [], withdrawn: [], ...overrides };
}

describe("why nothing is eligible for the final ranking", () => {
  it("says the results are simply not in yet when no act has been scored", () => {
    expect(whyNothingIsEligible(ranking({}))).toBe(
      "No act has been scored yet. Results appear here once an act is finalised.",
    );
  });

  it("distinguishes an empty show from one whose acts were all withdrawn", () => {
    expect(
      whyNothingIsEligible(ranking({ withdrawn: [act("act-1", "Ana")] })),
    ).toBe("Every act has been withdrawn, so there is nothing to rank.");
  });

  it("names FINALISE first, because that is the action closest to a ranking", () => {
    const message = whyNothingIsEligible(
      ranking({
        incomplete: [
          {
            act: act("act-1", "Ana"),
            reason: "NOT_FINALISED",
            missingJudgeSlots: [],
          },
          {
            act: act("act-2", "Tomas"),
            reason: "NOT_FINALISED",
            missingJudgeSlots: [],
          },
          {
            act: act("act-3", "Bo"),
            reason: "JUDGE_SCORE_MISSING",
            missingJudgeSlots: [2],
          },
        ],
      }),
    );
    expect(message).toBe(
      "2 acts are fully scored and waiting for FINALISE. Nothing can be ranked until then.",
    );
  });

  it("uses a singular subject for a single act", () => {
    expect(
      whyNothingIsEligible(
        ranking({
          incomplete: [
            {
              act: act("act-1", "Ana"),
              reason: "NOT_FINALISED",
              missingJudgeSlots: [],
            },
          ],
        }),
      ),
    ).toBe(
      "1 act is fully scored and waiting for FINALISE. Nothing can be ranked until then.",
    );
  });

  it("sends the operator to Setup when judges carry weight but none exist", () => {
    expect(
      whyNothingIsEligible(
        ranking({
          incomplete: [
            {
              act: act("act-1", "Ana"),
              reason: "JUDGES_NOT_CONFIGURED",
              missingJudgeSlots: [],
            },
          ],
        }),
      ),
    ).toBe(
      "Judges carry weight but no judge panel is configured. Add judges in Setup before results can be ranked.",
    );
  });

  it("points at the table when the block is missing judge scores", () => {
    expect(
      whyNothingIsEligible(
        ranking({
          incomplete: [
            {
              act: act("act-1", "Ana"),
              reason: "JUDGE_SCORE_MISSING",
              missingJudgeSlots: [1, 3],
            },
          ],
        }),
      ),
    ).toBe(
      "1 act is still waiting on judge scores. The table below names the judges.",
    );
  });

  it("offers both ways out when the audience result is what is missing", () => {
    expect(
      whyNothingIsEligible(
        ranking({
          incomplete: [
            {
              act: act("act-1", "Ana"),
              reason: "AUDIENCE_RESULT_INCOMPLETE",
              missingJudgeSlots: [],
            },
          ],
        }),
      ),
    ).toBe(
      "1 act is missing an audience result. Open audience voting for them, or set the audience weight to zero.",
    );
  });
});

describe("per-act exclusion labels", () => {
  it("names a single missing judge in the singular", () => {
    expect(exclusionLabel("JUDGE_SCORE_MISSING", [2])).toBe(
      "judge 2 has not scored",
    );
  });

  it("lists several missing judges", () => {
    expect(exclusionLabel("JUDGE_SCORE_MISSING", [1, 3, 4])).toBe(
      "judges 1, 3, 4 have not scored",
    );
  });

  it("covers every exclusion reason the server can report", () => {
    for (const reason of [
      "NOT_FINALISED",
      "AUDIENCE_RESULT_INCOMPLETE",
      "JUDGE_SCORE_MISSING",
      "JUDGES_NOT_CONFIGURED",
    ] as const) {
      expect(exclusionLabel(reason, [1]).length).toBeGreaterThan(0);
    }
  });
});
