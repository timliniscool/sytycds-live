import { describe, expect, it } from "vitest";

import { isAudienceScore } from "../shared/domain";
import { isJudgeRawInput } from "../shared/trust";

describe("shared domain guards", () => {
  it("accepts only integral audience scores from zero through ten", () => {
    expect(isAudienceScore(0)).toBe(true);
    expect(isAudienceScore(10)).toBe(true);
    expect(isAudienceScore(5.5)).toBe(false);
    expect(isAudienceScore(-1)).toBe(false);
    expect(isAudienceScore(11)).toBe(false);
    expect(isAudienceScore("5")).toBe(false);
  });

  it("treats only the expected judge-input shape as parseable request data", () => {
    expect(isJudgeRawInput({ raw: "pi" })).toBe(true);
    expect(isJudgeRawInput({ raw: 3 })).toBe(false);
    expect(isJudgeRawInput("pi")).toBe(false);
  });
});
