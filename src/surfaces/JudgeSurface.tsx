import { useEffect, useRef, useState } from "react";

import { commandId, PROTOCOL_VERSION } from "../../shared/domain";
import {
  deriveJudgeView,
  JUDGE_EXAMPLES,
  previewJudgeInput,
} from "../judge/judge-view";
import {
  RealtimeClient,
  showWebSocketUrl,
  useRealtimeSelector,
} from "../realtime/RealtimeClient";

interface JudgeSurfaceProps {
  token: string;
}

const REASONS: Readonly<Record<string, string>> = {
  VOTING_CLOSED: "Scoring closed before your score arrived. Nothing was saved.",
  WRONG_ACT: "The act changed before your score arrived.",
  INVALID_SCORE: "The server did not accept that value.",
  TOO_LONG: "That entry is too long.",
};

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

  const inputRef = useRef<HTMLInputElement | null>(null);
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

  const view = deriveJudgeView({ connection, projection });
  const preview = previewJudgeInput(raw);

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
        <p className="judge__mark">SYTYCDS · ADJUDICATOR</p>
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
          <p className="judge__locked-score">{view.submission.input.raw}</p>
          <p className="judge__locked-detail">
            Counted as {view.submission.effectiveScore.toFixed(3)}. A submitted
            score cannot be changed.
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
              onChange={(event) => {
                setRaw(event.target.value);
                setFailure(null);
              }}
            />
            <div className="judge__feedback" aria-live="polite">
              {preview.status === "invalid" && (
                <span className="judge__invalid">
                  Not a score this system accepts
                </span>
              )}
              {preview.status === "too_long" && (
                <span className="judge__invalid">That entry is too long</span>
              )}
              {preview.transform && (
                <span className="judge__transform">→ {preview.transform}</span>
              )}
            </div>
            <div className="judge__examples">
              {JUDGE_EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  className="judge__example"
                  onClick={() => {
                    setRaw(example);
                    setFailure(null);
                  }}
                >
                  {example}
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
            <p className="judge__confirm-score">{raw.trim()}</p>
            {preview.transform && (
              <p className="judge__confirm-detail">→ {preview.transform}</p>
            )}
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
    </main>
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
