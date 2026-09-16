import { describe, expect, it } from "vitest";

import {
  addAudienceScore,
  calculateFinalScore,
  emptyScoringAggregate,
  parseJudgeScore,
  transformJudgeScore,
} from "../shared/scoring";

function transformed(input: string): number {
  const parsed = parseJudgeScore(input);
  if (!parsed.ok) {
    throw new Error(`Expected ${input} to parse`);
  }
  return transformJudgeScore(parsed.parsed);
}

describe("pure scoring engine", () => {
  it("uses the required weighted incremental audience aggregate", () => {
    const first = addAudienceScore(emptyScoringAggregate(), 0);
    const second = addAudienceScore(first, 10);
    expect(second.count).toBe(2);
    expect(second.weightedSum).toBe(5);
    expect(second.totalWeight).toBe(1);
    expect(second.weightedMean).toBe(5);
  });

  it("accepts only the safe judge number grammar", () => {
    expect(parseJudgeScore("-1.25e+2")).toMatchObject({ ok: true });
    expect(parseJudgeScore("π")).toMatchObject({ ok: true });
    expect(parseJudgeScore("-Infinity")).toMatchObject({ ok: true });
    // Arithmetic and whitelisted functions are part of the language now;
    // anything that names code or an unknown symbol is still refused.
    expect(parseJudgeScore("5+5")).toMatchObject({
      ok: true,
      parsed: { classification: "FINITE", finiteValue: 10 },
    });
    expect(parseJudgeScore("sqrt(2)")).toMatchObject({ ok: true });
    for (const invalid of ["", "   ", "NaN", "alert(1)", "x", "8 5"]) {
      expect(parseJudgeScore(invalid)).toMatchObject({ ok: false });
    }
    expect(parseJudgeScore("1".repeat(129))).toMatchObject({
      ok: false,
      reason: "TOO_LONG",
    });
  });

  it("matches the specified taper values", () => {
    expect(transformed("0")).toBe(0);
    expect(transformed("10")).toBe(10);
    expect(transformed("11")).toBeCloseTo(10.5, 12);
    expect(transformed("20")).toBeCloseTo(11, 12);
    expect(transformed("100")).toBeCloseTo(11.832972291810425, 12);
    expect(transformed("-1")).toBeCloseTo(-0.5, 12);
    expect(transformed("-10")).toBeCloseTo(-1, 12);
    expect(transformed("Infinity")).toBe(15);
    expect(transformed("-inf")).toBe(-5);
  });

  it("is monotonic across representative finite and infinite inputs", () => {
    const inputs = [
      "-Infinity",
      "-100",
      "-10",
      "-1",
      "0",
      "1",
      "10",
      "11",
      "20",
      "100",
      "Infinity",
    ];
    const values = inputs.map(transformed);
    for (let index = 1; index < values.length; index += 1) {
      expect(values[index] ?? 0).toBeGreaterThanOrEqual(values[index - 1] ?? 0);
    }
  });

  it("represents incomplete finals without silently substituting scores", () => {
    expect(calculateFinalScore([1, 2, 3, null], 8)).toEqual({
      kind: "incomplete",
      missingJudges: [4],
      audienceMissing: false,
    });
    expect(calculateFinalScore([1, 2, 3, 4], 8)).toEqual({
      kind: "complete",
      value: 5.25,
    });
  });
});
