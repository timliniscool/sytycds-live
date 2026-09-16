import { useEffect, useRef, useState } from "react";

import { PROTOCOL_VERSION, type AudienceScore } from "../../shared/domain";
import {
  RealtimeClient,
  showWebSocketUrl,
  useRealtimeSelector,
} from "../realtime/RealtimeClient";
import {
  AUDIENCE_SCORES,
  connectionNotice,
  deriveVoteView,
  rejectionMessage,
  resolveVotingClose,
  type VoteRejection,
  type VoteSubmission,
} from "../vote/vote-view";
import {
  REACTION_IDS,
  type ReactionHistogram,
  type ReactionId,
} from "../../shared/reactions";
import { ReactionReporter } from "../vote/reaction-reporter";
import { ReactionLane, reactionGlyph } from "../reactions/ReactionLane";
import {
  effectiveAppearance,
  useShowDocumentTitle,
  useShowTheme,
} from "../theme";
import { PLATFORM_ATTRIBUTION } from "../../shared/platform";

interface VoteResponse {
  accepted?: boolean;
  locked?: boolean;
  score?: number | null;
  code?: string;
}

const REJECTIONS: ReadonlySet<string> = new Set([
  "VOTING_CLOSED",
  "ALREADY_VOTED",
  "WRONG_ACT",
  "INVALID_SCORE",
  "BAD_REQUEST",
]);

function asRejection(code: string | undefined): VoteRejection {
  return code && REJECTIONS.has(code) ? (code as VoteRejection) : "BAD_REQUEST";
}

export default function VoteSurface() {
  const clientRef = useRef<RealtimeClient | null>(null);
  if (!clientRef.current) {
    clientRef.current = new RealtimeClient({
      url: showWebSocketUrl(window.location),
      hello: {
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        requestedRole: "audience",
      },
    });
  }
  const client = clientRef.current;
  const projection = useRealtimeSelector(client, (state) =>
    state.projection?.role === "audience" ? state.projection : null,
  );
  const connection = useRealtimeSelector(client, (state) => state.connection);
  const reactionSampling = useRealtimeSelector(
    client,
    (state) => state.reactionSampling,
  );
  const reactionReporter = useRef(new ReactionReporter());
  const [reactionPulse, setReactionPulse] = useState<ReactionId | null>(null);
  const [localReaction, setLocalReaction] = useState<{
    key: number;
    histogram: ReactionHistogram;
  } | null>(null);
  const appearance = projection
    ? effectiveAppearance(projection.show, projection.activeAct)
    : null;
  useShowTheme(appearance?.themeId, appearance?.fontFamily);
  useShowDocumentTitle(projection?.show.title, "Vote");

  const [submission, setSubmission] = useState<VoteSubmission>({
    kind: "idle",
  });
  const [sawVotingOpen, setSawVotingOpen] = useState(false);
  const actId = projection?.show.activeActId ?? null;
  const votingOpen = projection?.show.audienceVoteState === "OPEN";
  // The latest submission is read inside effects without re-running them.
  const submissionRef = useRef(submission);
  submissionRef.current = submission;

  useEffect(() => () => client.destroy(), [client]);

  // A new act is a new vote. The locked state is then restored from the server
  // rather than trusted from this phone, so a reload cannot unlock anything.
  // With no act yet the same call still establishes the anonymous voter
  // identity, so the cookie exists before the first vote is attempted.
  useEffect(() => {
    setSubmission({ kind: "idle" });
    setSawVotingOpen(false);
    const controller = new AbortController();
    void fetch(
      actId
        ? `/api/vote/status?actId=${encodeURIComponent(actId)}`
        : "/api/vote/status",
      {
        credentials: "same-origin",
        signal: controller.signal,
      },
    )
      .then((response) => (response.ok ? response.json() : null))
      .then((result: VoteResponse | null) => {
        if (result?.locked) {
          setSubmission({ kind: "locked", score: result.score ?? null });
        }
        client.connect();
      })
      .catch(() => client.connect());
    return () => controller.abort();
  }, [actId, client]);

  useEffect(() => {
    if (!reactionSampling) return;
    const config = {
      slot: reactionSampling.slot,
      serverOffsetMs: reactionSampling.serverNow - Date.now(),
      epochMs: reactionSampling.epochMs,
      intervalMs: reactionSampling.intervalMs,
      eligibleSlots: reactionSampling.eligibleSlots,
    };
    const timer = setInterval(() => {
      const packet = reactionReporter.current.flush(Date.now(), config);
      if (packet)
        client.send({
          type: "reaction_summary",
          protocolVersion: PROTOCOL_VERSION,
          ...packet,
        });
    }, 1_000);
    return () => clearInterval(timer);
  }, [client, reactionSampling]);

  function react(id: ReactionId): void {
    reactionReporter.current.tap(id);
    const counts = [0, 0, 0, 0, 0] as [number, number, number, number, number];
    const index = REACTION_IDS.indexOf(id);
    if (index >= 0) counts[index] = 1;
    setLocalReaction({ key: Date.now() + Math.random(), histogram: counts });
    setReactionPulse(id);
    navigator.vibrate?.(8);
    window.setTimeout(
      () => setReactionPulse((current) => (current === id ? null : current)),
      220,
    );
  }

  useEffect(() => {
    if (votingOpen) setSawVotingOpen(true);
  }, [votingOpen]);

  // Voting closed underneath this phone. A score the voter had chosen but not
  // yet locked in is submitted now, against the close the server announced,
  // so it is counted inside the grace window; a phone holding nothing sends
  // nothing, and a submission already in flight is left to the server.
  useEffect(() => {
    if (votingOpen || !sawVotingOpen) return;
    const resolved = resolveVotingClose(submissionRef.current);
    if (resolved.submission !== submissionRef.current)
      setSubmission(resolved.submission);
    if (resolved.autoSubmit !== null) {
      void submit(resolved.autoSubmit, {
        closeRevision: client.getState().voteCloseRevision,
      });
    }
    // `submit` reads only stable refs and the client; the close is the event.
  }, [votingOpen, sawVotingOpen]);

  async function submit(
    score: AudienceScore,
    options: { closeRevision?: string | null } = {},
  ): Promise<void> {
    const closing = options.closeRevision !== undefined;
    // The server is authoritative, but a phone that already knows voting has
    // closed should not send an ordinary LOCK IN at all. The automatic
    // submission on close is the one deliberate exception, and it quotes the
    // close it is answering so the server can bound it.
    if (!actId || (!votingOpen && !closing)) {
      setSubmission({ kind: "idle" });
      return;
    }
    setSubmission({ kind: "submitting", score });
    try {
      const response = await fetch("/api/vote", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actId,
          score,
          ...(closing && options.closeRevision
            ? { closeRevision: options.closeRevision }
            : {}),
        }),
      });
      const result = (await response.json()) as VoteResponse;
      if (response.ok && result.accepted) {
        setSubmission({ kind: "locked", score });
        return;
      }
      // A duplicate delivery of an accepted vote is a locked vote, not an error.
      if (result.code === "ALREADY_VOTED") {
        setSubmission({ kind: "locked", score: null });
        return;
      }
      setSubmission({
        kind: "rejected",
        reason: asRejection(result.code),
        score,
      });
    } catch {
      setSubmission({ kind: "rejected", reason: "NETWORK", score });
    }
  }

  const view = deriveVoteView({
    connection,
    projection,
    submission,
    sawVotingOpen,
  });
  const notice = connectionNotice(connection);
  const pendingScore =
    submission.kind === "selected" ||
    submission.kind === "confirming" ||
    submission.kind === "submitting" ||
    submission.kind === "rejected"
      ? submission.score
      : null;

  const voting = view.kind === "VOTING";
  return (
    <main className={`vote${voting ? " vote--voting" : ""}`} aria-live="polite">
      <header className="vote__head">
        <p className="vote__mark">
          {projection?.show.shortName || projection?.show.title || "Audience"}
        </p>
        {view.kind === "VOTING" ||
        view.kind === "ACT" ||
        view.kind === "CLOSED" ? (
          <>
            {/*
              Act identity comes first and always fits. The optional artwork and
              description are the first things to yield space: while voting is
              open the selector and LOCK IN must be reachable without scrolling,
              so they are not competing with a picture.
            */}
            {!voting && view.act.publicImageAssetId && (
              <img
                className="vote__act-image"
                src={`/api/public/media/${encodeURIComponent(view.act.publicImageAssetId)}`}
                alt=""
              />
            )}
            <h1 className="vote__act">{view.act.actName}</h1>
            <p className="vote__performer">
              {view.act.performerName} · {view.act.schoolYear}
            </p>
            {!voting && view.act.publicDescription && (
              <p className="vote__description">{view.act.publicDescription}</p>
            )}
          </>
        ) : (
          <h1 className="vote__act">
            {projection?.show.title ?? "Audience voting"}
          </h1>
        )}
        {notice && <p className="vote__notice">{notice}</p>}
      </header>

      {view.kind === "CONNECTING" && (
        <Message body="Connecting to the show…" detail="Keep this page open." />
      )}
      {view.kind === "UNAVAILABLE" && <Message body={view.detail} />}
      {view.kind === "LOBBY" && (
        <Message
          body="Voting has not started."
          detail="Your score selector appears here the moment the operator opens voting."
        />
      )}
      {view.kind === "INTERMISSION" && (
        <Message
          body="Intermission"
          detail={view.message || "Voting resumes after the break."}
        />
      )}
      {view.kind === "HOLD" && (
        <Message body="Please wait" detail="The show is paused for a moment." />
      )}
      {view.kind === "EMERGENCY" && (
        <Message
          body={view.message || "Please follow staff instructions"}
          detail="Keep this page open."
        />
      )}
      {view.kind === "ACT" && (
        <Message body="Enjoy the act" detail="Voting opens shortly." />
      )}
      {view.kind === "CLOSED" && (
        <Message
          body="Voting has closed"
          detail={
            // A score still travelling when voting closed is being counted
            // inside the grace window; one that missed it is a lost race, not
            // a silent failure. Say exactly which happened.
            submission.kind === "submitting"
              ? `Sending your score of ${submission.score}…`
              : submission.kind === "rejected"
                ? rejectionMessage(submission.reason)
                : "Scores for this act are locked in."
          }
        />
      )}
      {view.kind === "RESULTS" && !view.publicResults && (
        <Message
          body="Final results"
          detail={
            view.revealedResult === null
              ? "Watch the main screen."
              : `${view.act?.actName ?? "This act"} scored ${view.revealedResult.toFixed(2)}.`
          }
        />
      )}
      {view.kind === "RESULTS" && view.publicResults && (
        <section className="vote__results" aria-label="Final results">
          <p className="vote__message-body">
            {view.publicResults.stage === "WINNER"
              ? view.publicResults.entries.length > 1
                ? "Joint winners"
                : "Winner"
              : view.publicResults.stage === "TOP_THREE"
                ? "Top three"
                : "Final results"}
          </p>
          <ol className="vote__results-list">
            {view.publicResults.entries.map((entry) => (
              <li key={entry.actId}>
                <span className="vote__results-rank">
                  {entry.tied ? "=" : ""}
                  {entry.rank}
                </span>
                <span className="vote__results-who">
                  <b>{entry.performerName}</b>
                  <small>{entry.actName}</small>
                </span>
                <span className="vote__results-score">
                  {entry.finalScore.toFixed(2)}
                </span>
              </li>
            ))}
          </ol>
          {view.publicResults.pendingGroups > 0 && (
            <p className="vote__message-detail">
              {view.publicResults.pendingGroups} place
              {view.publicResults.pendingGroups === 1 ? "" : "s"} still to be
              revealed on the main screen.
            </p>
          )}
        </section>
      )}
      {view.kind === "LOCKED" && (
        <section className="vote__locked">
          <p className="vote__locked-label">Your score is locked in</p>
          <p className="vote__locked-score">{view.score ?? "✓"}</p>
          <p className="vote__locked-detail">
            This cannot be changed. Thanks for voting.
          </p>
        </section>
      )}

      {view.kind === "VOTING" && (
        <>
          <div
            className="vote__scale"
            role="group"
            aria-label="Choose a score from 0 to 10"
          >
            {AUDIENCE_SCORES.map((score) => {
              const selected = pendingScore === score;
              return (
                <button
                  key={score}
                  type="button"
                  className={`vote__score${selected ? " vote__score--on" : ""}`}
                  aria-pressed={selected}
                  disabled={submission.kind === "submitting"}
                  onClick={() => setSubmission({ kind: "selected", score })}
                >
                  {score}
                </button>
              );
            })}
          </div>
          <footer className="vote__action">
            {submission.kind === "rejected" && (
              <p className="vote__error" role="alert">
                {rejectionMessage(submission.reason)}
              </p>
            )}
            {/*
              A chosen score counts: either when LOCK IN is pressed, or
              automatically the moment the operator closes voting. The phone
              says so, so nobody is surprised either way.
            */}
            <p className="vote__pending" aria-live="polite">
              {pendingScore === null
                ? "Tap a score. It counts when you lock it in, or when voting closes."
                : `Selected ${pendingScore} — lock it in, or it is sent when voting closes`}
            </p>
            <button
              type="button"
              className="vote__lock"
              disabled={
                pendingScore === null || submission.kind === "submitting"
              }
              onClick={() => {
                if (submission.kind === "selected") {
                  setSubmission({
                    kind: "confirming",
                    score: submission.score,
                  });
                }
              }}
            >
              {pendingScore === null
                ? "CHOOSE A SCORE"
                : submission.kind === "submitting"
                  ? "SENDING…"
                  : `LOCK IN ${pendingScore}`}
            </button>
          </footer>
        </>
      )}

      {submission.kind === "confirming" && view.kind === "VOTING" && (
        <div className="vote__confirm" role="dialog" aria-modal="true">
          <div className="vote__confirm-card">
            <p className="vote__confirm-title">
              Lock in <b>{submission.score}</b>?
            </p>
            <p className="vote__confirm-detail">This cannot be changed.</p>
            <button
              type="button"
              className="vote__lock"
              onClick={() => void submit(submission.score)}
            >
              YES, LOCK IT IN
            </button>
            <button
              type="button"
              className="vote__cancel"
              onClick={() =>
                setSubmission({ kind: "selected", score: submission.score })
              }
            >
              Change my score
            </button>
          </div>
        </div>
      )}
      {projection?.show.reactionsEnabled &&
        projection.show.displayMode !== "EMERGENCY" && (
          <>
            <ReactionLane
              local
              eventKey={localReaction?.key ?? null}
              histogram={localReaction?.histogram ?? null}
            />
            <aside className="vote__reactions" aria-label="Reactions">
              {REACTION_IDS.map((id) => (
                <button
                  key={id}
                  type="button"
                  aria-label={id}
                  className={
                    reactionPulse === id ? "vote__reaction--pulse" : ""
                  }
                  onClick={() => react(id)}
                >
                  {reactionGlyph(id)}
                </button>
              ))}
            </aside>
          </>
        )}
      <small className="platform-attribution">{PLATFORM_ATTRIBUTION}</small>
    </main>
  );
}

function Message({ body, detail }: { body: string; detail?: string }) {
  return (
    <section className="vote__message">
      <p className="vote__message-body">{body}</p>
      {detail && <p className="vote__message-detail">{detail}</p>}
    </section>
  );
}
