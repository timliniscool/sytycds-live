import { describe, expect, it } from "vitest";

import {
  evaluateMathExpression,
  isSimpleValue,
  mathMLToString,
  parseMathExpression,
  toMathML,
} from "../shared/math-expression";
import {
  classifyValue,
  describeJudgeEntry,
  parseJudgeScore,
  transformJudgeScore,
} from "../shared/scoring";
import { previewJudgeInput } from "../src/judge/judge-view";

function node(source: string) {
  const parsed = parseMathExpression(source);
  if (!parsed.ok) throw new Error(`${source}: ${parsed.detail}`);
  return parsed.node;
}

function value(source: string): number {
  const evaluated = evaluateMathExpression(node(source));
  if (!evaluated.ok) throw new Error(`${source}: ${evaluated.detail}`);
  return evaluated.value;
}

function effective(source: string): number {
  const parsed = parseJudgeScore(source);
  if (!parsed.ok) throw new Error(`${source}: ${parsed.detail}`);
  return transformJudgeScore(parsed.parsed);
}

describe("expression language", () => {
  it("evaluates the WolframAlpha-style examples from the brief", () => {
    expect(value("8.5")).toBe(8.5);
    expect(value("pi")).toBe(Math.PI);
    expect(value("e")).toBe(Math.E);
    expect(value("1e6")).toBe(1_000_000);
    expect(value("infinity")).toBe(Infinity);
    expect(value("sqrt(81)")).toBe(9);
    expect(value("sin(pi/2)")).toBe(1);
    expect(value("(7+3)/2")).toBe(5);
    expect(value("2^3")).toBe(8);
    expect(value("log(100)")).toBe(2);
    expect(value("exp(2)")).toBeCloseTo(Math.E ** 2, 12);
    expect(value("integral from 0 to pi of sin(x) dx")).toBeCloseTo(2, 8);
  });

  it("reads the calculator's unicode operators and juxtaposition", () => {
    expect(value("3 × 4 ÷ 2 − 1")).toBe(5);
    expect(value("2π")).toBeCloseTo(2 * Math.PI, 12);
    expect(value("2(3+4)")).toBe(14);
    expect(value("√81")).toBe(9);
    expect(value("∫ from 0 to 1 of x^2 dx")).toBeCloseTo(1 / 3, 8);
    expect(value("5!")).toBe(120);
    expect(value("−3")).toBe(-3);
    expect(value("2**10")).toBe(1024);
    expect(value("∞")).toBe(Infinity);
  });

  it("respects precedence and associativity", () => {
    expect(value("-2^2")).toBe(-4);
    expect(value("2^3^2")).toBe(512);
    expect(value("2^-1")).toBe(0.5);
    expect(value("1 - 2 - 3")).toBe(-4);
    expect(value("8 / 2 / 2")).toBe(2);
    expect(value("1 + 2 * 3")).toBe(7);
    expect(value("sin pi")).toBeCloseTo(0, 12);
    expect(value("3!/3")).toBe(2);
  });

  it("supports both spellings of integrals and sums", () => {
    expect(value("integral(sin(x), x, 0, pi)")).toBeCloseTo(2, 8);
    expect(value("integral(x^2, 0, 3)")).toBeCloseTo(9, 8);
    expect(value("integral of cos(t) dt from 0 to pi/2")).toBeCloseTo(1, 8);
    expect(value("sum from k=1 to 10 of k^2")).toBe(385);
    expect(value("sum(k, k, 1, 100)")).toBe(5050);
    expect(
      value("integral from 0 to 1 of integral from 0 to 1 of x*y dy dx"),
    ).toBeCloseTo(0.25, 8);
  });

  it("refuses everything outside the language with a readable reason", () => {
    const refused = (source: string) => {
      const parsed = parseMathExpression(source);
      if (!parsed.ok) return parsed.detail;
      const evaluated = evaluateMathExpression(parsed.node);
      return evaluated.ok ? null : evaluated.detail;
    };
    expect(refused("alert(1)")).toMatch(/not a function/u);
    expect(refused("x")).toMatch(/"x" is not a number/u);
    expect(refused("8 5")).toMatch(/operator between/u);
    expect(refused("(7+3")).toMatch(/never closed/u);
    expect(refused("7+3)")).toMatch(/closing bracket/u);
    expect(refused("2 +")).toMatch(/ends early/u);
    expect(refused("sqrt(-1)")).toMatch(/does not evaluate to a number/u);
    expect(refused("0/0")).toMatch(/does not evaluate to a number/u);
    expect(refused("integral from 0 to 1 of x*y dx")).toMatch(/"y"/u);
    expect(refused("integral from 0 to inf of 1 dx")).toMatch(/finite/u);
    expect(refused("sum from k=1 to 1e9 of k")).toMatch(/too many terms/u);
    expect(refused("process.exit()")).not.toBeNull();
    expect(refused("this.constructor")).not.toBeNull();
    expect(refused("#")).toMatch(/not part of the score language/u);
    expect(refused(`${"(".repeat(60)}1${")".repeat(60)}`)).toMatch(
      /nested too deeply/u,
    );
    expect(refused("NaN")).not.toBeNull();
  });

  it("stays within its evaluation budget for expensive integrals", () => {
    const started = performance.now();
    const outcome = evaluateMathExpression(
      node(
        "integral from 0 to 100 of integral from 0 to 100 of sin(x*y) dy dx",
      ),
    );
    expect(performance.now() - started).toBeLessThan(4_000);
    // Either a value or a refusal is acceptable; a hang or a crash is not.
    expect(typeof outcome.ok).toBe("boolean");
  });

  it("knows which entries read better as typed", () => {
    for (const plain of ["8", "8.5", "-3", "π", "pi", "Infinity", "1e6"])
      expect(isSimpleValue(node(plain))).toBe(true);
    for (const rich of ["2^3", "sqrt(81)", "(7+3)/2", "2pi", "5!"])
      expect(isSimpleValue(node(rich))).toBe(false);
    expect(describeJudgeEntry("8.5")).toEqual({ kind: "plain", text: "8.5" });
    expect(describeJudgeEntry("sqrt(81)").kind).toBe("expression");
    // Text the parser cannot read is still shown, never hidden.
    expect(describeJudgeEntry("??")).toEqual({ kind: "plain", text: "??" });
  });
});

describe("MathML rendering", () => {
  const markup = (source: string) => mathMLToString(toMathML(node(source)));

  it("typesets an integral, a fraction, a root and a power", () => {
    const integral = markup("integral from 0 to pi of sin(x) dx");
    expect(integral).toContain(
      '<msubsup><mo stretchy="false">∫</mo><mn>0</mn><mi>π</mi></msubsup>',
    );
    expect(integral).toContain("<mi>sin</mi>");
    expect(integral).toContain("<mi>d</mi><mi>x</mi>");
    expect(markup("(7+3)/2")).toBe(
      '<math xmlns="http://www.w3.org/1998/Math/MathML" display="inline"><mfrac><mrow><mo>(</mo><mrow><mn>7</mn><mo>+</mo><mn>3</mn></mrow><mo>)</mo></mrow><mn>2</mn></mfrac></math>',
    );
    expect(markup("sqrt(81)")).toContain("<msqrt><mn>81</mn></msqrt>");
    expect(markup("2^3")).toContain("<msup><mn>2</mn><mn>3</mn></msup>");
    expect(markup("1e6")).toContain("<msup><mn>10</mn><mn>6</mn></msup>");
    expect(markup("sum from k=1 to 10 of k^2")).toContain(
      "<munderover><mo>∑</mo>",
    );
  });

  it("brackets composite bases and negative operands", () => {
    expect(markup("(1+2)^2")).toContain("<msup><mrow><mo>(</mo>");
    expect(markup("5 - (-3)")).toContain("<mo>−</mo><mrow><mo>(</mo>");
  });

  it("never emits markup from the judge's text", () => {
    // Tags cannot appear in the language at all, and identifiers are escaped.
    expect(parseMathExpression("<script>1</script>").ok).toBe(false);
    expect(parseMathExpression('"1"').ok).toBe(false);
    const rendered = markup("integral from 0 to 1 of q dq");
    expect(rendered).not.toMatch(
      /<(?!\/?(?:math|mrow|mn|mi|mo|mfrac|msup|msubsup|munderover|msqrt|mroot|mspace)\b)/u,
    );
  });
});

describe("judge score pipeline", () => {
  it.each([
    ["normal decimal", "8.5", 8.5, 8.5],
    [
      "negative number",
      "-3",
      -3,
      -5 * (1 - Math.exp(-0.1053605156578263 * 3 ** 0.3259064530714697)),
    ],
    ["zero", "0", 0, 0],
    ["exactly ten", "10", 10, 10],
    ["large positive", "1e6", 1_000_000, null],
    ["large negative", "-1e6", -1_000_000, null],
    ["scientific notation", "2.5e1", 25, null],
    ["pi", "pi", Math.PI, Math.PI],
    ["e", "e", Math.E, Math.E],
    ["arithmetic", "(7+3)/2", 5, 5],
    ["function", "sqrt(81)", 9, 9],
    ["integral", "integral from 0 to pi of sin(x) dx", 2, 2],
  ] as const)(
    "%s parses, classifies and transforms",
    (_label, raw, finite, transformedExpected) => {
      const parsed = parseJudgeScore(raw);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.parsed.classification).toBe("FINITE");
      expect(parsed.parsed.finiteValue).toBeCloseTo(finite, 6);
      const transformed = transformJudgeScore(parsed.parsed);
      expect(Number.isFinite(transformed)).toBe(true);
      if (transformedExpected !== null)
        expect(transformed).toBeCloseTo(transformedExpected, 6);
      else if (finite > 10) {
        expect(transformed).toBeGreaterThan(10);
        expect(transformed).toBeLessThan(15);
      } else {
        expect(transformed).toBeLessThan(0);
        expect(transformed).toBeGreaterThan(-5);
      }
    },
  );

  it("handles infinity deliberately through the transformation", () => {
    for (const raw of ["infinity", "∞", "inf", "1/0", "10^400", "exp(1000)"]) {
      const parsed = parseJudgeScore(raw);
      expect(parsed.ok, raw).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.parsed).toEqual({
        classification: "POSITIVE_INFINITY",
        finiteValue: null,
      });
      expect(transformJudgeScore(parsed.parsed)).toBe(15);
      // Nothing about the stored record is NaN or unserialisable.
      expect(JSON.parse(JSON.stringify(parsed.parsed))).toEqual(parsed.parsed);
    }
    for (const raw of ["-infinity", "-∞", "-1/0", "-(10^400)"]) {
      const parsed = parseJudgeScore(raw);
      expect(parsed.ok, raw).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.parsed.classification).toBe("NEGATIVE_INFINITY");
      expect(transformJudgeScore(parsed.parsed)).toBe(-5);
    }
    expect(classifyValue(-0)).toEqual({
      classification: "FINITE",
      finiteValue: 0,
    });
  });

  it("refuses malformed expressions cleanly instead of storing NaN", () => {
    for (const raw of [
      "",
      "  ",
      "NaN",
      "sqrt(-4)",
      "0/0",
      "inf - inf",
      "abc",
      "8 5",
      "((",
      "alert(1)",
    ]) {
      const parsed = parseJudgeScore(raw);
      expect(parsed.ok, raw).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.reason).toBe("INVALID");
      expect(parsed.detail.length).toBeGreaterThan(0);
    }
    expect(parseJudgeScore("1".repeat(129))).toMatchObject({
      ok: false,
      reason: "TOO_LONG",
    });
  });

  it("keeps the taper beyond 0–10 unchanged for expression input", () => {
    expect(effective("11")).toBeCloseTo(10.5, 12);
    expect(effective("10 + 1")).toBeCloseTo(10.5, 12);
    expect(effective("2 * 10")).toBeCloseTo(11, 12);
    expect(effective("-1")).toBeCloseTo(-0.5, 12);
    expect(effective("-(2 - 1)")).toBeCloseTo(-0.5, 12);
    expect(effective("0.5 * 10")).toBe(5);
  });

  it("previews the effective score and transformation for judges", () => {
    const plain = previewJudgeInput("8.5");
    expect(plain).toMatchObject({
      status: "valid",
      effectiveScore: 8.5,
      transform: null,
    });
    const expression = previewJudgeInput("sqrt(81)");
    expect(expression).toMatchObject({
      status: "valid",
      effectiveScore: 9,
      evaluated: 9,
    });
    const tapered = previewJudgeInput("2^4");
    expect(tapered.evaluated).toBe(16);
    expect(tapered.transform).toMatch(/counts as/u);
    const invalid = previewJudgeInput("sqrt(");
    expect(invalid.status).toBe("invalid");
    expect(invalid.detail).toMatch(/ends early/u);
  });
});
