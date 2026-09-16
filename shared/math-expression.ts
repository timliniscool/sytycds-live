/**
 * A small, safe mathematical expression language for adjudicator scores.
 *
 * The grammar is deliberately closed: numbers, the constants π, e and ∞, the
 * arithmetic operators, a fixed whitelist of functions, factorial, and two
 * bounded operators (a definite integral and a finite sum) written either as
 * functions or in plain English (`integral from 0 to pi of sin(x) dx`). Every
 * expression is tokenised and parsed into a tree here and evaluated by walking
 * that tree; nothing is ever handed to `eval`, `Function` or any other code
 * path that could execute text. Work is bounded (tree depth, evaluation
 * count, integration budget) because the coordinator evaluates every
 * submission itself.
 *
 * The same tree renders to MathML so an entered expression can be typeset
 * exactly as the judge wrote it, without any HTML or LaTeX passing through.
 */

export type MathNode =
  | { kind: "number"; value: number; text: string }
  | { kind: "constant"; name: "pi" | "e" | "infinity" }
  | { kind: "variable"; name: string }
  | { kind: "unary"; op: "-" | "+"; operand: MathNode }
  | {
      kind: "binary";
      op: "+" | "-" | "*" | "/" | "^" | "implicit";
      left: MathNode;
      right: MathNode;
    }
  | { kind: "factorial"; operand: MathNode }
  | { kind: "group"; inner: MathNode }
  | { kind: "call"; name: string; args: readonly MathNode[] }
  | BoundNode<"integral">
  | BoundNode<"sum">;

/** A definite integral or a finite sum over one bound variable. */
export interface BoundNode<Kind extends "integral" | "sum"> {
  kind: Kind;
  body: MathNode;
  variable: string;
  lower: MathNode;
  upper: MathNode;
}

export type MathParseResult =
  { ok: true; node: MathNode } | { ok: false; detail: string };

export type MathEvaluation =
  { ok: true; value: number } | { ok: false; detail: string };

/** Nesting deeper than this is refused before evaluation. */
export const MAX_EXPRESSION_DEPTH = 40;
/** Total node evaluations one expression may perform, integrals included. */
const EVALUATION_BUDGET = 400_000;
const MAX_SUM_TERMS = 100_000;
const MAX_INTEGRAL_DEPTH = 2;
const INTEGRAL_MAX_RECURSION = 18;
const INTEGRAL_TOLERANCE = 1e-10;

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

type Token =
  | { kind: "number"; text: string; value: number }
  | { kind: "identifier"; text: string }
  | { kind: "operator"; text: string }
  | { kind: "end" };

const NUMBER = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/u;
const IDENTIFIER = /^[A-Za-z_][A-Za-z_0-9]*/u;

const OPERATOR_ALIASES: Readonly<Record<string, string>> = {
  "×": "*",
  "·": "*",
  "∙": "*",
  "⋅": "*",
  "÷": "/",
  "−": "-",
  "–": "-",
  "—": "-",
  "**": "^",
  "[": "(",
  "]": ")",
  "{": "(",
  "}": ")",
};

const SYMBOL_IDENTIFIERS: Readonly<Record<string, string>> = {
  π: "pi",
  "∞": "infinity",
  "√": "sqrt",
  "∫": "integral",
  "∑": "sum",
  Σ: "sum",
  ℯ: "e",
};

function tokenise(source: string): Token[] | string {
  const tokens: Token[] = [];
  let rest = source;
  while (rest.length > 0) {
    const whitespace = /^\s+/u.exec(rest);
    if (whitespace) {
      rest = rest.slice(whitespace[0].length);
      continue;
    }
    const number = NUMBER.exec(rest);
    if (number) {
      const text = number[0];
      const value = Number(text);
      if (!Number.isFinite(value)) return `"${text}" is too large a number`;
      tokens.push({ kind: "number", text, value });
      rest = rest.slice(text.length);
      continue;
    }
    const identifier = IDENTIFIER.exec(rest);
    if (identifier) {
      tokens.push({ kind: "identifier", text: identifier[0] });
      rest = rest.slice(identifier[0].length);
      continue;
    }
    const first = [...rest][0]!;
    const symbol = SYMBOL_IDENTIFIERS[first];
    if (symbol) {
      tokens.push({ kind: "identifier", text: symbol });
      rest = rest.slice(first.length);
      continue;
    }
    if (rest.startsWith("**")) {
      tokens.push({ kind: "operator", text: "^" });
      rest = rest.slice(2);
      continue;
    }
    const alias = OPERATOR_ALIASES[first];
    if (alias) {
      tokens.push({ kind: "operator", text: alias });
      rest = rest.slice(first.length);
      continue;
    }
    if ("+-*/^(),!=".includes(first)) {
      tokens.push({ kind: "operator", text: first });
      rest = rest.slice(first.length);
      continue;
    }
    return `"${first}" is not part of the score language`;
  }
  tokens.push({ kind: "end" });
  return tokens;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

const CONSTANTS: Readonly<Record<string, MathNode>> = {
  pi: { kind: "constant", name: "pi" },
  e: { kind: "constant", name: "e" },
  inf: { kind: "constant", name: "infinity" },
  infinity: { kind: "constant", name: "infinity" },
  infty: { kind: "constant", name: "infinity" },
};

/** Canonical name → implementation. Aliases are resolved before lookup. */
const FUNCTIONS: Readonly<
  Record<string, { arity: [number, number]; apply(args: number[]): number }>
> = {
  sqrt: { arity: [1, 1], apply: ([x]) => Math.sqrt(x!) },
  cbrt: { arity: [1, 1], apply: ([x]) => Math.cbrt(x!) },
  root: { arity: [2, 2], apply: ([x, n]) => nthRoot(x!, n!) },
  abs: { arity: [1, 1], apply: ([x]) => Math.abs(x!) },
  ln: { arity: [1, 1], apply: ([x]) => Math.log(x!) },
  log: {
    arity: [1, 2],
    apply: ([x, base]) =>
      base === undefined ? Math.log10(x!) : Math.log(x!) / Math.log(base),
  },
  log2: { arity: [1, 1], apply: ([x]) => Math.log2(x!) },
  log10: { arity: [1, 1], apply: ([x]) => Math.log10(x!) },
  exp: { arity: [1, 1], apply: ([x]) => Math.exp(x!) },
  sin: { arity: [1, 1], apply: ([x]) => Math.sin(x!) },
  cos: { arity: [1, 1], apply: ([x]) => Math.cos(x!) },
  tan: { arity: [1, 1], apply: ([x]) => Math.tan(x!) },
  asin: { arity: [1, 1], apply: ([x]) => Math.asin(x!) },
  acos: { arity: [1, 1], apply: ([x]) => Math.acos(x!) },
  atan: {
    arity: [1, 2],
    apply: ([y, x]) => (x === undefined ? Math.atan(y!) : Math.atan2(y!, x)),
  },
  sinh: { arity: [1, 1], apply: ([x]) => Math.sinh(x!) },
  cosh: { arity: [1, 1], apply: ([x]) => Math.cosh(x!) },
  tanh: { arity: [1, 1], apply: ([x]) => Math.tanh(x!) },
  floor: { arity: [1, 1], apply: ([x]) => Math.floor(x!) },
  ceil: { arity: [1, 1], apply: ([x]) => Math.ceil(x!) },
  round: { arity: [1, 1], apply: ([x]) => Math.round(x!) },
  trunc: { arity: [1, 1], apply: ([x]) => Math.trunc(x!) },
  sign: { arity: [1, 1], apply: ([x]) => Math.sign(x!) },
  min: { arity: [1, 16], apply: (args) => Math.min(...args) },
  max: { arity: [1, 16], apply: (args) => Math.max(...args) },
  mean: {
    arity: [1, 16],
    apply: (args) => args.reduce((sum, x) => sum + x, 0) / args.length,
  },
  factorial: { arity: [1, 1], apply: ([x]) => factorial(x!) },
  gamma: { arity: [1, 1], apply: ([x]) => gamma(x!) },
  deg: { arity: [1, 1], apply: ([x]) => (x! * 180) / Math.PI },
  rad: { arity: [1, 1], apply: ([x]) => (x! * Math.PI) / 180 },
};

const FUNCTION_ALIASES: Readonly<Record<string, string>> = {
  arcsin: "asin",
  arccos: "acos",
  arctan: "atan",
  lg: "log10",
  average: "mean",
  avg: "mean",
  fact: "factorial",
};

const BOUND_OPERATORS: Readonly<Record<string, "integral" | "sum">> = {
  integral: "integral",
  integrate: "integral",
  int: "integral",
  sum: "sum",
  summation: "sum",
};

const KEYWORDS = new Set(["from", "to", "of"]);

function canonicalName(text: string): string {
  const lower = text.toLowerCase();
  return FUNCTION_ALIASES[lower] ?? lower;
}

function nthRoot(x: number, n: number): number {
  if (n === 0) return NaN;
  if (x < 0 && Number.isInteger(n) && Math.abs(n) % 2 === 1)
    return -((-x) ** (1 / n));
  return x ** (1 / n);
}

function factorial(x: number): number {
  if (Number.isInteger(x)) {
    if (x < 0) return NaN;
    if (x > 170) return Infinity;
    let result = 1;
    for (let index = 2; index <= x; index += 1) result *= index;
    return result;
  }
  return gamma(x + 1);
}

/** Lanczos approximation, good to ~15 significant figures. */
function gamma(x: number): number {
  if (Number.isInteger(x) && x <= 0) return NaN;
  if (x < 0.5) return Math.PI / (Math.sin(Math.PI * x) * gamma(1 - x));
  const g = 7;
  const coefficients = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  const shifted = x - 1;
  let sum = coefficients[0]!;
  for (let index = 1; index < g + 2; index += 1)
    sum += coefficients[index]! / (shifted + index);
  const t = shifted + g + 0.5;
  return Math.sqrt(2 * Math.PI) * t ** (shifted + 0.5) * Math.exp(-t) * sum;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class ParseError extends Error {}

interface Stop {
  /** Identifiers that end the current sub-expression. */
  keywords: ReadonlySet<string>;
  /** `dx`-style differential that ends an integral body. */
  differential: boolean;
}

const NO_STOP: Stop = { keywords: new Set(), differential: false };

class Parser {
  private index = 0;
  private depth = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  parse(): MathNode {
    const node = this.expression(NO_STOP);
    const token = this.peek();
    if (token.kind !== "end") {
      throw new ParseError(
        token.kind === "operator" && token.text === ")"
          ? "There is a closing bracket with no opening bracket"
          : `Unexpected "${"text" in token ? token.text : ""}"`,
      );
    }
    return node;
  }

  private peek(offset = 0): Token {
    return this.tokens[this.index + offset] ?? { kind: "end" };
  }

  private next(): Token {
    const token = this.peek();
    if (token.kind !== "end") this.index += 1;
    return token;
  }

  private isOperator(token: Token, text: string): boolean {
    return token.kind === "operator" && token.text === text;
  }

  private isKeyword(token: Token, word: string): boolean {
    return token.kind === "identifier" && token.text.toLowerCase() === word;
  }

  private expectOperator(text: string, message: string): void {
    if (!this.isOperator(this.peek(), text)) throw new ParseError(message);
    this.next();
  }

  private nested<Value>(build: () => Value): Value {
    this.depth += 1;
    if (this.depth > MAX_EXPRESSION_DEPTH)
      throw new ParseError("The expression is nested too deeply");
    try {
      return build();
    } finally {
      this.depth -= 1;
    }
  }

  private atStop(stop: Stop): boolean {
    const token = this.peek();
    if (token.kind === "end") return true;
    if (token.kind === "operator")
      return token.text === ")" || token.text === ",";
    if (token.kind === "identifier") {
      const lower = token.text.toLowerCase();
      if (stop.keywords.has(lower)) return true;
      if (stop.differential && isDifferential(token.text)) return true;
    }
    return false;
  }

  private expression(stop: Stop): MathNode {
    return this.nested(() => {
      let left = this.term(stop);
      for (;;) {
        const token = this.peek();
        if (this.isOperator(token, "+") || this.isOperator(token, "-")) {
          this.next();
          const right = this.term(stop);
          left = {
            kind: "binary",
            op: token.kind === "operator" && token.text === "+" ? "+" : "-",
            left,
            right,
          };
          continue;
        }
        return left;
      }
    });
  }

  private term(stop: Stop): MathNode {
    return this.nested(() => {
      let left = this.unary(stop);
      for (;;) {
        const token = this.peek();
        if (this.isOperator(token, "*") || this.isOperator(token, "/")) {
          this.next();
          const right = this.unary(stop);
          left = {
            kind: "binary",
            op: token.kind === "operator" && token.text === "*" ? "*" : "/",
            left,
            right,
          };
          continue;
        }
        if (this.startsPrimary(token, stop)) {
          // Juxtaposition: 2π, 3(4+1), 2sin(x). A number after a number is
          // refused so "8 5" cannot be read as forty.
          if (token.kind === "number" && left.kind === "number")
            throw new ParseError("Two numbers need an operator between them");
          const right = this.power(stop);
          left = { kind: "binary", op: "implicit", left, right };
          continue;
        }
        return left;
      }
    });
  }

  private startsPrimary(token: Token, stop: Stop): boolean {
    if (this.atStop(stop)) return false;
    if (token.kind === "number") return true;
    if (token.kind === "identifier")
      return !KEYWORDS.has(token.text.toLowerCase());
    return this.isOperator(token, "(");
  }

  private unary(stop: Stop): MathNode {
    return this.nested(() => {
      const token = this.peek();
      if (this.isOperator(token, "-") || this.isOperator(token, "+")) {
        this.next();
        const operand = this.unary(stop);
        return {
          kind: "unary",
          op: token.kind === "operator" && token.text === "-" ? "-" : "+",
          operand,
        };
      }
      return this.power(stop);
    });
  }

  private power(stop: Stop): MathNode {
    return this.nested(() => {
      const base = this.postfix(stop);
      if (this.isOperator(this.peek(), "^")) {
        this.next();
        // Right-associative, and the exponent may carry its own sign: 2^-3.
        const exponent = this.unary(stop);
        return { kind: "binary", op: "^", left: base, right: exponent };
      }
      return base;
    });
  }

  private postfix(stop: Stop): MathNode {
    let node = this.primary(stop);
    while (this.isOperator(this.peek(), "!")) {
      this.next();
      node = { kind: "factorial", operand: node };
    }
    return node;
  }

  private primary(stop: Stop): MathNode {
    return this.nested(() => {
      const token = this.next();
      if (token.kind === "end")
        throw new ParseError("The expression ends early");
      if (token.kind === "number")
        return { kind: "number", value: token.value, text: token.text };
      if (token.kind === "operator") {
        if (token.text === "(") {
          const inner = this.expression(NO_STOP);
          this.expectOperator(")", "A bracket was opened but never closed");
          return { kind: "group", inner };
        }
        throw new ParseError(`"${token.text}" cannot start a value`);
      }
      const lower = token.text.toLowerCase();
      if (
        KEYWORDS.has(lower) ||
        (stop.differential && isDifferential(token.text))
      )
        throw new ParseError(`"${token.text}" was not expected here`);
      const bound = BOUND_OPERATORS[lower];
      if (bound) return this.boundOperator(bound);
      const constant = CONSTANTS[lower];
      if (constant) return constant;
      const name = canonicalName(token.text);
      if (FUNCTIONS[name]) {
        // `sqrt 81`, `√81` and `sin pi` apply to the next power-level value;
        // `sqrt(81)` takes an argument list.
        if (this.isOperator(this.peek(), "(")) {
          this.next();
          const args = this.arguments();
          return { kind: "call", name, args };
        }
        const argument = this.unary(stop);
        return { kind: "call", name, args: [argument] };
      }
      if (this.isOperator(this.peek(), "("))
        throw new ParseError(
          `"${token.text}" is not a function this system knows`,
        );
      return { kind: "variable", name: token.text };
    });
  }

  private arguments(): MathNode[] {
    const args: MathNode[] = [];
    if (this.isOperator(this.peek(), ")")) {
      this.next();
      return args;
    }
    for (;;) {
      args.push(this.expression(NO_STOP));
      const token = this.next();
      if (this.isOperator(token, ")")) return args;
      if (!this.isOperator(token, ","))
        throw new ParseError("A bracket was opened but never closed");
    }
  }

  /**
   * Two spellings of the same thing:
   *   integral(sin(x), x, 0, pi)   integral(sin(x), 0, pi)
   *   integral from 0 to pi of sin(x) dx
   *   integral of sin(x) dx from 0 to pi
   *   sum from k = 1 to 10 of k^2      sum(k^2, k, 1, 10)
   */
  private boundOperator(kind: "integral" | "sum"): MathNode {
    if (this.isOperator(this.peek(), "(")) {
      this.next();
      const args = this.arguments();
      if (args.length === 3) {
        const [body, lower, upper] = args as [MathNode, MathNode, MathNode];
        const free = [...freeVariables(body)];
        if (free.length !== 1)
          throw new ParseError(
            free.length === 0
              ? `Name the variable: ${kind}(expression, x, lower, upper)`
              : `Which variable? ${kind}(expression, x, lower, upper)`,
          );
        return { kind, body, variable: free[0]!, lower, upper };
      }
      if (args.length === 4) {
        const [body, variable, lower, upper] = args as [
          MathNode,
          MathNode,
          MathNode,
          MathNode,
        ];
        if (variable.kind !== "variable")
          throw new ParseError(
            `The second argument of ${kind} must be a variable`,
          );
        return { kind, body, variable: variable.name, lower, upper };
      }
      throw new ParseError(
        `${kind}(expression, x, lower, upper) takes four values`,
      );
    }
    const bounds: {
      lower: MathNode | null;
      upper: MathNode | null;
      variable: string | null;
    } = { lower: null, upper: null, variable: null };
    const readBounds = () => {
      this.next(); // from
      const first = this.peek();
      if (
        kind === "sum" &&
        first.kind === "identifier" &&
        this.isOperator(this.peek(1), "=")
      ) {
        bounds.variable = first.text;
        this.next();
        this.next();
      }
      bounds.lower = this.expression({
        keywords: new Set(["to"]),
        differential: false,
      });
      if (!this.isKeyword(this.peek(), "to"))
        throw new ParseError(`"${kind} from A to B" needs its "to"`);
      this.next();
      bounds.upper = this.expression({
        keywords: new Set(["of"]),
        differential: kind === "integral",
      });
    };
    if (this.isKeyword(this.peek(), "from")) readBounds();
    if (!this.isKeyword(this.peek(), "of"))
      throw new ParseError(`Write "${kind} from A to B of expression"`);
    this.next();
    const body = this.expression({
      keywords: new Set(["from"]),
      differential: kind === "integral",
    });
    if (kind === "integral") {
      const differential = this.peek();
      if (
        differential.kind === "identifier" &&
        isDifferential(differential.text)
      ) {
        this.next();
        bounds.variable = differential.text.slice(1);
      }
    }
    if (bounds.lower === null && this.isKeyword(this.peek(), "from"))
      readBounds();
    const { lower, upper } = bounds;
    if (lower === null || upper === null)
      throw new ParseError(`"${kind}" needs "from A to B"`);
    let variable = bounds.variable;
    if (variable === null) {
      const free = [...freeVariables(body)];
      if (free.length !== 1)
        throw new ParseError(
          kind === "integral"
            ? "End the integral with its variable, for example dx"
            : "Write the sum as sum from k = 1 to 10 of ...",
        );
      variable = free[0]!;
    }
    return { kind, body, variable, lower, upper };
  }
}

function isDifferential(text: string): boolean {
  return /^d[A-Za-z]$/u.test(text) && !FUNCTIONS[canonicalName(text)];
}

export function freeVariables(
  node: MathNode,
  bound: ReadonlySet<string> = new Set(),
): Set<string> {
  const found = new Set<string>();
  const visit = (current: MathNode, scope: ReadonlySet<string>) => {
    switch (current.kind) {
      case "number":
      case "constant":
        return;
      case "variable":
        if (!scope.has(current.name)) found.add(current.name);
        return;
      case "unary":
      case "factorial":
        visit(current.operand, scope);
        return;
      case "group":
        visit(current.inner, scope);
        return;
      case "binary":
        visit(current.left, scope);
        visit(current.right, scope);
        return;
      case "call":
        current.args.forEach((argument) => visit(argument, scope));
        return;
      case "integral":
      case "sum":
        visit(current.lower, scope);
        visit(current.upper, scope);
        visit(current.body, new Set([...scope, current.variable]));
        return;
    }
  };
  visit(node, bound);
  return found;
}

export function parseMathExpression(source: string): MathParseResult {
  const tokens = tokenise(source);
  if (typeof tokens === "string") return { ok: false, detail: tokens };
  if (tokens.length === 1) return { ok: false, detail: "Enter a score" };
  try {
    return { ok: true, node: new Parser(tokens).parse() };
  } catch (error: unknown) {
    return {
      ok: false,
      detail:
        error instanceof ParseError
          ? error.message
          : "That expression could not be read",
    };
  }
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

class EvaluationError extends Error {}

class Evaluator {
  private budget = EVALUATION_BUDGET;
  private integralDepth = 0;

  evaluate(node: MathNode, scope: ReadonlyMap<string, number>): number {
    this.budget -= 1;
    if (this.budget < 0)
      throw new EvaluationError("That expression is too expensive to compute");
    switch (node.kind) {
      case "number":
        return node.value;
      case "constant":
        return node.name === "pi"
          ? Math.PI
          : node.name === "e"
            ? Math.E
            : Infinity;
      case "variable": {
        const value = scope.get(node.name);
        if (value === undefined)
          throw new EvaluationError(`"${node.name}" has no value here`);
        return value;
      }
      case "unary": {
        const operand = this.evaluate(node.operand, scope);
        return node.op === "-" ? -operand : operand;
      }
      case "group":
        return this.evaluate(node.inner, scope);
      case "factorial":
        return factorial(this.evaluate(node.operand, scope));
      case "binary": {
        const left = this.evaluate(node.left, scope);
        const right = this.evaluate(node.right, scope);
        switch (node.op) {
          case "+":
            return left + right;
          case "-":
            return left - right;
          case "*":
          case "implicit":
            return left * right;
          case "/":
            return left / right;
          case "^":
            return left ** right;
        }
        break;
      }
      case "call": {
        const definition = FUNCTIONS[node.name];
        if (!definition)
          throw new EvaluationError(`"${node.name}" is not a known function`);
        const [min, max] = definition.arity;
        if (node.args.length < min || node.args.length > max)
          throw new EvaluationError(
            `${node.name} takes ${min === max ? min : `${min} to ${max}`} value${max === 1 ? "" : "s"}`,
          );
        return definition.apply(
          node.args.map((argument) => this.evaluate(argument, scope)),
        );
      }
      case "integral":
        return this.integrate(node, scope);
      case "sum":
        return this.sum(node, scope);
    }
    throw new EvaluationError("Unsupported expression");
  }

  private sum(
    node: Extract<MathNode, { kind: "sum" }>,
    scope: ReadonlyMap<string, number>,
  ): number {
    const lower = this.evaluate(node.lower, scope);
    const upper = this.evaluate(node.upper, scope);
    if (!Number.isInteger(lower) || !Number.isInteger(upper))
      throw new EvaluationError("Sum limits must be whole numbers");
    if (upper - lower + 1 > MAX_SUM_TERMS)
      throw new EvaluationError("That sum has too many terms");
    let total = 0;
    const inner = new Map(scope);
    for (let index = lower; index <= upper; index += 1) {
      inner.set(node.variable, index);
      total += this.evaluate(node.body, inner);
    }
    return total;
  }

  /** Adaptive Simpson quadrature with a hard recursion and budget ceiling. */
  private integrate(
    node: Extract<MathNode, { kind: "integral" }>,
    scope: ReadonlyMap<string, number>,
  ): number {
    this.integralDepth += 1;
    try {
      if (this.integralDepth > MAX_INTEGRAL_DEPTH)
        throw new EvaluationError("Integrals may be nested at most twice");
      const lower = this.evaluate(node.lower, scope);
      const upper = this.evaluate(node.upper, scope);
      if (!Number.isFinite(lower) || !Number.isFinite(upper))
        throw new EvaluationError("Integral limits must be finite numbers");
      if (lower === upper) return 0;
      const inner = new Map(scope);
      const f = (x: number): number => {
        inner.set(node.variable, x);
        const value = this.evaluate(node.body, inner);
        if (!Number.isFinite(value))
          throw new EvaluationError(
            "The integrand is not finite on that interval",
          );
        return value;
      };
      const simpson = (
        a: number,
        b: number,
        fa: number,
        fm: number,
        fb: number,
      ) => ((b - a) / 6) * (fa + 4 * fm + fb);
      const recurse = (
        a: number,
        b: number,
        fa: number,
        fm: number,
        fb: number,
        whole: number,
        tolerance: number,
        depth: number,
      ): number => {
        const m = (a + b) / 2;
        const lm = (a + m) / 2;
        const rm = (m + b) / 2;
        const flm = f(lm);
        const frm = f(rm);
        const left = simpson(a, m, fa, flm, fm);
        const right = simpson(m, b, fm, frm, fb);
        const delta = left + right - whole;
        if (
          depth >= INTEGRAL_MAX_RECURSION ||
          Math.abs(delta) <= 15 * tolerance
        )
          return left + right + delta / 15;
        return (
          recurse(a, m, fa, flm, fm, left, tolerance / 2, depth + 1) +
          recurse(m, b, fm, frm, fb, right, tolerance / 2, depth + 1)
        );
      };
      const fa = f(lower);
      const fb = f(upper);
      const fm = f((lower + upper) / 2);
      return recurse(
        lower,
        upper,
        fa,
        fm,
        fb,
        simpson(lower, upper, fa, fm, fb),
        INTEGRAL_TOLERANCE,
        0,
      );
    } finally {
      this.integralDepth -= 1;
    }
  }
}

export function evaluateMathExpression(node: MathNode): MathEvaluation {
  const free = freeVariables(node);
  if (free.size > 0) {
    const name = [...free][0]!;
    return {
      ok: false,
      detail: `"${name}" is not a number, constant or function this system knows`,
    };
  }
  try {
    const value = new Evaluator().evaluate(node, new Map());
    if (Number.isNaN(value))
      return {
        ok: false,
        detail: "That expression does not evaluate to a number",
      };
    return { ok: true, value };
  } catch (error: unknown) {
    return {
      ok: false,
      detail:
        error instanceof EvaluationError
          ? error.message
          : "That expression could not be computed",
    };
  }
}

/**
 * A plain number or a single constant, with an optional sign: the cases that
 * read better as typed than typeset.
 */
export function isSimpleValue(node: MathNode): boolean {
  if (node.kind === "number" || node.kind === "constant") return true;
  if (node.kind === "unary") return isSimpleValue(node.operand);
  return false;
}

// ---------------------------------------------------------------------------
// MathML
// ---------------------------------------------------------------------------

export interface MathMLElement {
  tag:
    | "math"
    | "mrow"
    | "mn"
    | "mi"
    | "mo"
    | "mfrac"
    | "msup"
    | "msubsup"
    | "munderover"
    | "msqrt"
    | "mroot"
    | "mspace";
  attributes?: Readonly<Record<string, string>>;
  children: readonly (MathMLElement | string)[];
}

const FUNCTION_APPLICATION = "⁡";

function el(
  tag: MathMLElement["tag"],
  children: readonly (MathMLElement | string)[],
  attributes?: Readonly<Record<string, string>>,
): MathMLElement {
  return attributes ? { tag, attributes, children } : { tag, children };
}

const mn = (text: string) => el("mn", [text]);
const mi = (text: string) => el("mi", [text]);
const mo = (text: string, attributes?: Readonly<Record<string, string>>) =>
  el("mo", [text], attributes);
const mrow = (...children: (MathMLElement | string)[]) => el("mrow", children);

function parenthesised(inner: MathMLElement): MathMLElement {
  return mrow(mo("("), inner, mo(")"));
}

function numberElement(text: string): MathMLElement {
  const match = /^(.*?)[eE]([+-]?\d+)$/u.exec(text);
  if (!match) return mn(text);
  const mantissa = match[1] === "" ? "1" : match[1]!;
  return mrow(
    mn(mantissa),
    mo("×"),
    el("msup", [mn("10"), mn(match[2]!.replace(/^\+/u, ""))]),
  );
}

/** Whether a node needs brackets when it becomes the base of a power. */
function needsBaseBrackets(node: MathNode): boolean {
  return (
    node.kind === "binary" ||
    node.kind === "unary" ||
    node.kind === "integral" ||
    node.kind === "sum" ||
    (node.kind === "number" && /[eE]/u.test(node.text))
  );
}

/** Whether a right-hand operand of − needs brackets to keep its sign. */
function needsOperandBrackets(node: MathNode): boolean {
  return (
    node.kind === "unary" ||
    (node.kind === "binary" && (node.op === "+" || node.op === "-"))
  );
}

function render(node: MathNode): MathMLElement {
  switch (node.kind) {
    case "number":
      return numberElement(node.text);
    case "constant":
      return mi(node.name === "pi" ? "π" : node.name === "e" ? "e" : "∞");
    case "variable":
      return mi(node.name);
    case "unary":
      return mrow(mo(node.op === "-" ? "−" : "+"), render(node.operand));
    case "group":
      return parenthesised(render(node.inner));
    case "factorial":
      return mrow(
        needsBaseBrackets(node.operand)
          ? parenthesised(render(node.operand))
          : render(node.operand),
        mo("!"),
      );
    case "binary": {
      switch (node.op) {
        case "+":
          return mrow(render(node.left), mo("+"), render(node.right));
        case "-":
          return mrow(
            render(node.left),
            mo("−"),
            needsOperandBrackets(node.right)
              ? parenthesised(render(node.right))
              : render(node.right),
          );
        case "*":
          return mrow(render(node.left), mo("×"), render(node.right));
        case "implicit":
          return mrow(
            render(node.left),
            mo(FUNCTION_APPLICATION),
            render(node.right),
          );
        case "/":
          return el("mfrac", [render(node.left), render(node.right)]);
        case "^":
          return el("msup", [
            needsBaseBrackets(node.left)
              ? parenthesised(render(node.left))
              : render(node.left),
            render(node.right),
          ]);
      }
      break;
    }
    case "call": {
      const [first, second] = node.args;
      if (node.name === "sqrt" && first) return el("msqrt", [render(first)]);
      if (node.name === "cbrt" && first)
        return el("mroot", [render(first), mn("3")]);
      if (node.name === "root" && first && second)
        return el("mroot", [render(first), render(second)]);
      if (node.name === "abs" && first)
        return mrow(mo("|"), render(first), mo("|"));
      if (node.name === "factorial" && first)
        return render({ kind: "factorial", operand: first });
      if (node.name === "exp" && first)
        return el("msup", [mi("e"), render(first)]);
      const args: (MathMLElement | string)[] = [];
      node.args.forEach((argument, index) => {
        if (index > 0) args.push(mo(","));
        args.push(render(argument));
      });
      const name =
        node.name === "log2"
          ? el("msubsup", [mi("log"), mn("2"), mrow()])
          : node.name === "log10"
            ? el("msubsup", [mi("log"), mn("10"), mrow()])
            : mi(node.name);
      return mrow(name, mo(FUNCTION_APPLICATION), parenthesised(mrow(...args)));
    }
    case "integral":
      return mrow(
        el("msubsup", [
          mo("∫", { stretchy: "false" }),
          render(node.lower),
          render(node.upper),
        ]),
        render(node.body),
        el("mspace", [], { width: "0.17em" }),
        mi("d"),
        mi(node.variable),
      );
    case "sum":
      return mrow(
        el("munderover", [
          mo("∑"),
          mrow(mi(node.variable), mo("="), render(node.lower)),
          render(node.upper),
        ]),
        render(node.body),
      );
  }
  throw new Error("Unsupported node");
}

/** A `<math>` tree for the whole expression; every leaf is escaped text. */
export function toMathML(node: MathNode): MathMLElement {
  return el("math", [render(node)], {
    xmlns: "http://www.w3.org/1998/Math/MathML",
    display: "inline",
  });
}

function escape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Serialises the tree; useful for tests and for non-React consumers. */
export function mathMLToString(element: MathMLElement): string {
  const attributes = Object.entries(element.attributes ?? {})
    .map(([name, value]) => ` ${name}="${escape(value)}"`)
    .join("");
  const children = element.children
    .map((child) =>
      typeof child === "string" ? escape(child) : mathMLToString(child),
    )
    .join("");
  return `<${element.tag}${attributes}>${children}</${element.tag}>`;
}
