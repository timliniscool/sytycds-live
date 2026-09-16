import { useEffect, useRef, useState } from "react";

import { commandId, PROTOCOL_VERSION } from "../../shared/domain";
import {
  deriveJudgeView,
  previewJudgeInput,
  type JudgeInputPreview,
} from "../judge/judge-view";
import { JudgeEntry } from "../math/MathExpression";
import {
  RealtimeClient,
  showWebSocketUrl,
  useRealtimeSelector,
} from "../realtime/RealtimeClient";
import { PLATFORM_ATTRIBUTION, PLATFORM_NAME } from "../../shared/platform";
import {
  effectiveAppearance,
  useShowDocumentTitle,
  useShowTheme,
} from "../theme";

interface JudgeSurfaceProps {
  token: string;
}

const REASONS: Readonly<Record<string, string>> = {
  VOTING_CLOSED: "Scoring closed before your score arrived. Nothing was saved.",
  WRONG_ACT: "The act changed before your score arrived.",
  INVALID_SCORE: "The server did not accept that value.",
  TOO_LONG: "That entry is too long.",
};

/** One sentence, by request; the calculator is the rest of the explanation. */
const EFFECTIVE_SCORE_EXPLANATION =
  "Effective Score is the numeric value your entered score or expression evaluates to before the show's scoring transformation is applied.";

interface Key {
  label: string;
  /** Text inserted at the caret; a trailing "(" opens a function call. */
  insert: string;
  /** Editing keys change the text instead of inserting. */
  action?: "delete" | "clear";
  /** Screen-reader name when the label is a symbol. */
  name?: string;
  wide?: boolean;
  tone?: "digit" | "operator" | "function" | "edit";
}

/**
 * A compact scientific keypad. Every key inserts text the parser reads, so the
 * keypad and the keyboard are two ways of writing the same expression; nothing
 * is computed here.
 */
const KEYPAD: readonly (readonly Key[])[] = [
  [
    { label: "(", insert: "(", tone: "operator" },
    { label: ")", insert: ")", tone: "operator" },
    { label: "π", insert: "π", name: "pi", tone: "function" },
    { label: "e", insert: "e", name: "Euler's number", tone: "function" },
    { label: "∞", insert: "∞", name: "infinity", tone: "function" },
  ],
  [
    { label: "sin", insert: "sin(", tone: "function" },
    { label: "cos", insert: "cos(", tone: "function" },
    { label: "tan", insert: "tan(", tone: "function" },
    { label: "ln", insert: "ln(", tone: "function" },
    { label: "log", insert: "log(", tone: "function" },
  ],
  [
    { label: "√", insert: "sqrt(", name: "square root", tone: "function" },
    { label: "xʸ", insert: "^", name: "to the power of", tone: "operator" },
    { label: "n!", insert: "!", name: "factorial", tone: "operator" },
    { label: "eˣ", insert: "exp(", name: "exponential", tone: "function" },
    {
      label: "∫",
      insert: "integral from 0 to 1 of x dx",
      name: "definite integral template",
      tone: "function",
    },
  ],
  [
    { label: "7", insert: "7", tone: "digit" },
    { label: "8", insert: "8", tone: "digit" },
    { label: "9", insert: "9", tone: "digit" },
    { label: "÷", insert: "÷", name: "divide", tone: "operator" },
    { label: "⌫", insert: "", action: "delete", name: "delete", tone: "edit" },
  ],
  [
    { label: "4", insert: "4", tone: "digit" },
    { label: "5", insert: "5", tone: "digit" },
    { label: "6", insert: "6", tone: "digit" },
    { label: "×", insert: "×", name: "multiply", tone: "operator" },
    { label: "C", insert: "", action: "clear", name: "clear", tone: "edit" },
  ],
  [
    { label: "1", insert: "1", tone: "digit" },
    { label: "2", insert: "2", tone: "digit" },
    { label: "3", insert: "3", tone: "digit" },
    { label: "−", insert: "−", name: "minus", tone: "operator" },
    { label: "abs", insert: "abs(", tone: "function" },
  ],
  [
    { label: "0", insert: "0", tone: "digit" },
    { label: ".", insert: ".", name: "decimal point", tone: "digit" },
    { label: ",", insert: ",", name: "comma", tone: "digit" },
    { label: "+", insert: "+", name: "plus", tone: "operator" },
    {
      label: "1e6",
      insert: "1e6",
      name: "one million in scientific notation",
      tone: "function",
    },
  ],
];

export default function JudgeSurface({ token }: JudgeSurfaceProps) {
  const clientRef = useRef<RealtimeClient | null>(null);
  if (!clientRef.current) {
    clientRef.current = new RealtimeClient({
      url: showWebSocketUrl(window.location),
      hello: {
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        requestedRole: "judge",
        credential: token,
      },
    });
  }
  const client = clientRef.current;
  const projection = useRealtimeSelector(client, (state) =>
    state.projection?.role === "judge" ? state.projection : null,
  );
  const connection = useRealtimeSelector(client, (state) => state.connection);
  const submissionUpdate = useRealtimeSelector(
    client,
    (state) => state.lastJudgeSubmission,
  );
  const appearance = projection
    ? effectiveAppearance(projection.show, projection.activeAct)
    : null;
  useShowTheme(appearance?.themeId, appearance?.fontFamily);
  useShowDocumentTitle(projection?.show.title, "Judge");

  const inputRef = useRef<HTMLInputElement | null>(null);
  const caretRef = useRef<number | null>(null);
  const [raw, setRaw] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    client.connect();
    return () => client.destroy();
  }, [client]);

  // A new act is a new score sheet.
  const actId = projection?.show.activeActId ?? null;
  useEffect(() => {
    setRaw("");
    setConfirming(false);
    setSubmitting(false);
    setFailure(null);
  }, [actId]);

  useEffect(() => {
    if (!submissionUpdate) return;
    setSubmitting(false);
    setConfirming(false);
    setFailure(
      submissionUpdate.locked
        ? null
        : (REASONS[submissionUpdate.reason ?? ""] ??
            "That score was not accepted."),
    );
  }, [submissionUpdate]);

  // Keypad edits land at the caret; the caret is restored after React paints.
  useEffect(() => {
    const input = inputRef.current;
    const caret = caretRef.current;
    if (!input || caret === null) return;
    caretRef.current = null;
    if (document.activeElement === input) input.setSelectionRange(caret, caret);
  }, [raw]);

  const view = deriveJudgeView({ connection, projection });
  const preview = previewJudgeInput(raw);

  function press(key: Key): void {
    setFailure(null);
    const input = inputRef.current;
    const focused = input !== null && document.activeElement === input;
    const start = focused ? (input.selectionStart ?? raw.length) : raw.length;
    const end = focused ? (input.selectionEnd ?? start) : raw.length;
    if (key.action === "clear") {
      setRaw("");
      caretRef.current = 0;
      return;
    }
    if (key.action === "delete") {
      if (start !== end) {
        setRaw(raw.slice(0, start) + raw.slice(end));
        caretRef.current = start;
      } else if (start > 0) {
        // Delete one code point, so "π" or "∞" go in one press.
        const before = [...raw.slice(0, start)];
        before.pop();
        const kept = before.join("");
        setRaw(kept + raw.slice(start));
        caretRef.current = kept.length;
      }
      return;
    }
    setRaw(raw.slice(0, start) + key.insert + raw.slice(end));
    caretRef.current = start + key.insert.length;
  }

  function submit(): void {
    if (submitting) return;
    setSubmitting(true);
    setFailure(null);
    const sent = client.send({
      type: "judge_submit",
      protocolVersion: PROTOCOL_VERSION,
      commandId: commandId(crypto.randomUUID().replaceAll("-", "")),
      input: { raw },
    });
    if (!sent) {
      setSubmitting(false);
      setConfirming(false);
      setFailure("Your link is not connected. Try again in a moment.");
    }
  }

  return (
    <main className="judge">
      <header className="judge__head">
        <p className="judge__mark">{PLATFORM_NAME} · ADJUDICATOR</p>
        {connection === "RECONNECTING" || connection === "DEGRADED" ? (
          <p className="judge__notice">Reconnecting…</p>
        ) : null}
      </header>

      {view.kind === "AUTHENTICATING" && (
        <Panel title="Checking your link…" detail="This takes a moment." />
      )}
      {view.kind === "REJECTED" && (
        <Panel title="Link not accepted" detail={view.detail} tone="danger" />
      )}
      {view.kind === "WAITING" && (
        <Panel
          title="Waiting for the next act"
          detail="The act appears here as soon as the operator selects it."
        />
      )}

      {view.kind !== "AUTHENTICATING" &&
        view.kind !== "REJECTED" &&
        view.kind !== "WAITING" && (
          <section className="judge__act">
            <p className="judge__act-label">You are scoring</p>
            <h1 className="judge__act-name">{view.act.actName}</h1>
            <p className="judge__act-performer">{view.act.performerName}</p>
            <p className="judge__act-year">
              {view.act.schoolYear} · {view.act.actType}
            </p>
          </section>
        )}

      {view.kind === "CLOSED" && (
        <Panel
          title="Scoring is closed"
          detail="The operator opens your score entry when the act finishes."
        />
      )}

      {view.kind === "LOCKED" && (
        <section className="judge__locked">
          <p className="judge__locked-label">LOCKED</p>
          <p className="judge__locked-score">
            <JudgeEntry raw={view.submission.input.raw} />
          </p>
          <p className="judge__locked-detail">
            <LockedDetail
              parsed={view.submission.parsed}
              effectiveScore={view.submission.effectiveScore}
            />{" "}
            A submitted score cannot be changed.
          </p>
        </section>
      )}

      {view.kind === "OPEN" && (
        <>
          <div className="judge__entry">
            <label className="judge__label" htmlFor="judge-score">
              Your score
            </label>
            <input
              id="judge-score"
              ref={inputRef}
              className="judge__input"
              type="text"
              inputMode="text"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="done"
              value={raw}
              disabled={submitting}
              aria-describedby="judge-hint judge-feedback"
              onChange={(event) => {
                setRaw(event.target.value);
                setFailure(null);
              }}
            />
            <Feedback preview={preview} raw={raw} />
            <p className="judge__hint" id="judge-hint">
              Any value the scoring calculator understands counts, not just a
              decimal: <code>8.5</code>, <code>pi</code>, <code>1e6</code>,{" "}
              <code>infinity</code>, <code>sqrt(81)</code>,{" "}
              <code>sin(pi/2)</code>, <code>2^3</code>, <code>(7+3)/2</code>,{" "}
              <code>log(100)</code> or{" "}
              <code>integral from 0 to pi of sin(x) dx</code>.{" "}
              {EFFECTIVE_SCORE_EXPLANATION}
            </p>
            <div
              className="judge__keypad"
              role="group"
              aria-label="Scientific keypad"
            >
              {KEYPAD.flat().map((key) => (
                <button
                  key={key.label}
                  type="button"
                  className={`judge__key judge__key--${key.tone ?? "digit"}${key.wide ? " judge__key--wide" : ""}`}
                  aria-label={key.name ?? key.label}
                  disabled={submitting}
                  onClick={() => press(key)}
                >
                  {key.label}
                </button>
              ))}
            </div>
          </div>

          <footer className="judge__action">
            {failure && (
              <p className="judge__failure" role="alert">
                {failure}
              </p>
            )}
            <button
              type="button"
              className="judge__submit"
              disabled={preview.status !== "valid" || submitting}
              onClick={() => {
                // Dropping the keyboard first keeps the confirmation and its
                // button on screen on a phone.
                inputRef.current?.blur();
                setConfirming(true);
              }}
            >
              {submitting ? "Sending…" : "Submit score"}
            </button>
          </footer>
        </>
      )}

      {confirming && (
        <div className="judge__confirm" role="dialog" aria-modal="true">
          <div className="judge__confirm-card">
            <p className="judge__confirm-title">
              Lock in this score? It cannot be changed.
            </p>
            <p className="judge__confirm-score">
              <JudgeEntry raw={raw.trim()} />
            </p>
            <p className="judge__confirm-detail">
              <EffectiveLine preview={preview} />
            </p>
            <button
              type="button"
              className="judge__submit"
              disabled={submitting}
              onClick={submit}
            >
              {submitting ? "Sending…" : "Lock it in"}
            </button>
            <button
              type="button"
              className="judge__cancel"
              disabled={submitting}
              onClick={() => setConfirming(false)}
            >
              Go back
            </button>
          </div>
        </div>
      )}
      <small className="platform-attribution">{PLATFORM_ATTRIBUTION}</small>
    </main>
  );
}

function formatEvaluated(value: number): string {
  if (!Number.isFinite(value)) return value > 0 ? "∞" : "−∞";
  if (Math.abs(value) >= 1e9 || (value !== 0 && Math.abs(value) < 1e-4))
    return value.toExponential(4).replace("+", "");
  return value.toFixed(4).replace(/\.?0+$/u, "");
}

/** "Effective Score 9 · counts as 9.000" — or just the number when equal. */
function EffectiveLine({ preview }: { preview: JudgeInputPreview }) {
  if (preview.status !== "valid" || preview.effectiveScore === null)
    return null;
  const evaluated =
    preview.evaluated === null
      ? preview.effectiveScore > 0
        ? "∞"
        : "−∞"
      : formatEvaluated(preview.evaluated);
  const differs =
    preview.evaluated === null ||
    Math.abs(preview.evaluated - preview.effectiveScore) > 0.0005;
  return (
    <>
      <span className="judge__effective">
        Effective Score <b>{evaluated}</b>
      </span>
      {differs && (
        <span className="judge__counts">
          {" "}
          · counts as <b>{preview.effectiveScore.toFixed(3)}</b> after the
          show's scoring transformation
        </span>
      )}
    </>
  );
}

function Feedback({
  preview,
  raw,
}: {
  preview: JudgeInputPreview;
  raw: string;
}) {
  const typeset =
    preview.status === "valid" && !/^[\s+-]*[\d.]+(?:e[+-]?\d+)?$/iu.test(raw);
  return (
    <div className="judge__feedback" id="judge-feedback" aria-live="polite">
      {preview.status === "invalid" && (
        <span className="judge__invalid">
          {preview.detail ?? "Not a score this system accepts"}
        </span>
      )}
      {preview.status === "too_long" && (
        <span className="judge__invalid">That entry is too long</span>
      )}
      {preview.status === "valid" && (
        <>
          {typeset && (
            <span className="judge__typeset">
              <JudgeEntry raw={raw.trim()} />
            </span>
          )}
          <span className="judge__transform">
            <EffectiveLine preview={preview} />
          </span>
        </>
      )}
    </div>
  );
}

function LockedDetail({
  parsed,
  effectiveScore,
}: {
  parsed: { classification: string; finiteValue: number | null };
  effectiveScore: number;
}) {
  const evaluated =
    parsed.finiteValue === null
      ? parsed.classification === "NEGATIVE_INFINITY"
        ? "−∞"
        : "∞"
      : formatEvaluated(parsed.finiteValue);
  const differs =
    parsed.finiteValue === null ||
    Math.abs(parsed.finiteValue - effectiveScore) > 0.0005;
  return differs ? (
    <>
      Effective Score {evaluated}, counted as {effectiveScore.toFixed(3)}.
    </>
  ) : (
    <>Counted as {effectiveScore.toFixed(3)}.</>
  );
}

function Panel({
  title,
  detail,
  tone,
}: {
  title: string;
  detail: string;
  tone?: "danger";
}) {
  return (
    <section className={`judge__panel${tone ? ` judge__panel--${tone}` : ""}`}>
      <p className="judge__panel-title">{title}</p>
      <p className="judge__panel-detail">{detail}</p>
    </section>
  );
}
