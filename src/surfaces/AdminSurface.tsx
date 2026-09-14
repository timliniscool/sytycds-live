import { useEffect, useRef, useState, type FormEvent } from "react";

import {
  commandId,
  PROTOCOL_VERSION,
  showRevision,
  type DisplayMode,
} from "../../shared/domain";
import type {
  AdminCommand,
  AdminCommandType,
} from "../../shared/admin-command";
import { EmergencyPanel } from "../admin/EmergencyPanel";
import { JudgeLinks } from "../admin/JudgeLinks";
import { MediaConsole } from "../admin/MediaConsole";
import { PreflightPanel } from "../admin/PreflightPanel";
import { PublicTextPanel } from "../admin/PublicTextPanel";
import { ResultsPanel } from "../admin/ResultsPanel";
import {
  RealtimeClient,
  showWebSocketUrl,
  useRealtimeSelector,
} from "../realtime/RealtimeClient";

type AuthenticationState = "checking" | "signed-out" | "signed-in" | "failed";
type ConsoleView = "show" | "results" | "setup";

export default function AdminSurface() {
  const [authentication, setAuthentication] =
    useState<AuthenticationState>("checking");
  const [secret, setSecret] = useState("");

  useEffect(() => {
    void fetch("/api/admin/session", { credentials: "same-origin" })
      .then(async (response) =>
        response.ok
          ? (response.json() as Promise<{ authenticated: boolean }>)
          : null,
      )
      .then((result) =>
        setAuthentication(result?.authenticated ? "signed-in" : "signed-out"),
      )
      .catch(() => setAuthentication("failed"));
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const response = await fetch("/api/admin/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret }),
    });
    setSecret("");
    setAuthentication(response.ok ? "signed-in" : "signed-out");
  }

  if (authentication !== "signed-in") {
    return (
      <main
        className="surface surface--admin"
        aria-labelledby="admin-login-title"
      >
        <header>
          <p>SYTYCDS / show control</p>
          <h1 id="admin-login-title">Operator sign-in</h1>
        </header>
        {authentication === "checking" ? (
          <p>Checking operator session…</p>
        ) : (
          <form onSubmit={submit}>
            <label htmlFor="admin-secret">Show-control secret</label>
            <input
              id="admin-secret"
              type="password"
              autoComplete="current-password"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              required
            />
            <button type="submit">Sign in</button>
            {authentication === "failed" && (
              <p>Unable to verify this session.</p>
            )}
          </form>
        )}
      </main>
    );
  }

  return <Console />;
}

/** HOLD and EMERGENCY are overrides and live in their own panel. */
const MODES: readonly DisplayMode[] = [
  "LOBBY",
  "ACT_CARD",
  "PERFORMANCE",
  "SCOREBOARD",
  "INTERMISSION",
  "FINAL_RESULTS",
];
const VIEWS: readonly { view: ConsoleView; label: string }[] = [
  { view: "show", label: "SHOW" },
  { view: "results", label: "RESULTS" },
  { view: "setup", label: "SETUP & PREFLIGHT" },
];
function id(): string {
  return crypto.randomUUID().replaceAll("-", "");
}
function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

function Console() {
  const clientRef = useRef<RealtimeClient | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = useState<ConsoleView>("show");
  if (!clientRef.current)
    clientRef.current = new RealtimeClient({
      url: showWebSocketUrl(window.location),
      hello: {
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        requestedRole: "admin",
      },
    });
  const client = clientRef.current;
  const projection = useRealtimeSelector(client, (state) =>
    state.projection?.role === "admin" ? state.projection : null,
  );
  const connection = useRealtimeSelector(client, (state) => state.connection);
  // Every revisioned message advances this, while the projection keeps the
  // revision it was snapshotted at. Commands must be stamped with the former or
  // the second command of a snapshot is always rejected as stale.
  const revision = useRealtimeSelector(client, (state) => state.revision);
  const acknowledgement = useRealtimeSelector(
    client,
    (state) => state.lastCommandAcknowledgement,
  );
  const audienceConnections = useRealtimeSelector(
    client,
    (state) => state.audienceConnections,
  );
  const judgeConnections = useRealtimeSelector(
    client,
    (state) => state.judgeConnections,
  );
  const telemetry = useRealtimeSelector(
    client,
    (state) => state.projectorTelemetry,
  );
  const projectorAcknowledgement = useRealtimeSelector(
    client,
    (state) => state.lastProjectorAcknowledgement,
  );
  useEffect(() => {
    client.connect();
    return () => client.destroy();
  }, [client]);
  useEffect(() => {
    if (acknowledgement?.acknowledgement.reason)
      setNotice(acknowledgement.acknowledgement.reason);
  }, [acknowledgement]);

  /** Returns the command ID so a caller can wait for its acknowledgement. */
  function send(
    type: AdminCommandType,
    extras: Record<string, unknown> = {},
  ): string | null {
    if (!projection) return null;
    const identifier = id();
    const command = {
      protocolVersion: PROTOCOL_VERSION,
      commandId: commandId(identifier),
      expectedRevision: showRevision(
        Number(revision ?? projection.show.revision),
      ),
      type,
      ...extras,
    } as AdminCommand;
    if (
      !client.send({
        type: "admin_command",
        protocolVersion: PROTOCOL_VERSION,
        command,
      })
    ) {
      setNotice("Control link is not live");
      return null;
    }
    return identifier;
  }
  const mediaPlaying =
    projection?.runtime.visualTransport === "PLAYING" ||
    projection?.runtime.audioTransport === "PLAYING";
  function select(actId: string): void {
    if (
      mediaPlaying &&
      !window.confirm("Media is playing. Change the current act?")
    )
      return;
    send("SELECT_ACT", { actId });
  }
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (isTyping(event.target) || !projection) return;
      if (event.key === "ArrowRight") {
        event.preventDefault();
        send("NEXT_ACT");
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        send("PREVIOUS_ACT");
      }
      if (event.key.toLowerCase() === "p")
        send("SET_DISPLAY_MODE", { mode: "PERFORMANCE" });
      if (event.key.toLowerCase() === "h")
        send("SET_DISPLAY_MODE", { mode: "HOLD" });
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [projection, mediaPlaying]);
  if (!projection)
    return (
      <main className="admin-console">
        <p>Connecting to authoritative show state…</p>
      </main>
    );
  const active =
    projection.acts.find((act) => act.id === projection.show.activeActId) ??
    null;
  const aggregate = active
    ? projection.audienceAggregates.find((entry) => entry.actId === active.id)
    : null;
  const votingOpen = projection.show.audienceVoteState === "OPEN";
  const submittedScores = projection.judges.flatMap((judge) =>
    judge.submission ? [judge.submission.effectiveScore] : [],
  );
  const judgeContribution =
    submittedScores.length === 4
      ? submittedScores.reduce((sum, score) => sum + score, 0) / 8
      : null;
  const judgeMean =
    submittedScores.length === 4
      ? submittedScores.reduce((sum, score) => sum + score, 0) / 4
      : null;
  const audienceContribution =
    aggregate?.weightedMean === null || aggregate?.weightedMean === undefined
      ? null
      : aggregate.weightedMean / 2;
  const result = active ? projection.results[active.id] : undefined;
  return (
    <main className="admin-console">
      <header className="admin-status">
        <span className="admin-mark">SYTYCDS / CONTROL</span>
        <strong
          className={`connection connection--${connection.toLowerCase()}`}
        >
          {connection}
        </strong>
        <span>REV {revision ?? projection.show.revision}</span>
        <span>
          PROJECTOR {projection.show.displayMode.replaceAll("_", " ")}
        </span>
        <nav className="admin-views" aria-label="Console view">
          {VIEWS.map((entry) => (
            <button
              key={entry.view}
              type="button"
              className={view === entry.view ? "is-active" : ""}
              onClick={() => setView(entry.view)}
            >
              {entry.label}
            </button>
          ))}
        </nav>
        {projection.show.displayMode === "EMERGENCY" && (
          <strong className="admin-status__alarm">EMERGENCY ON SCREEN</strong>
        )}
        {projectorAcknowledgement && !projectorAcknowledgement.succeeded && (
          <strong className="admin-status__alarm">
            PROJECTOR COMMAND FAILED
          </strong>
        )}
        {notice && <output>{notice}</output>}
      </header>
      <section className="running-order" aria-labelledby="running-order-title">
        <div className="region-title">
          <p>RUNNING ORDER</p>
          <h1 id="running-order-title">Acts</h1>
        </div>
        <div
          className="act-list"
          role="listbox"
          aria-label="Show running order"
        >
          {projection.acts.map((act) => {
            const result = projection.results[act.id];
            const current = act.id === projection.show.activeActId;
            const status = act.withdrawn
              ? "WITHDRAWN"
              : result?.kind === "finalised"
                ? "FINALISED"
                : result?.kind === "provisional"
                  ? "SCORING READY"
                  : "PENDING";
            return (
              <button
                type="button"
                role="option"
                aria-selected={current}
                key={act.id}
                className={`act-row${current ? " act-row--current" : ""}${act.withdrawn ? " act-row--withdrawn" : ""}`}
                onClick={() => select(act.id)}
              >
                <span>{String(act.order + 1).padStart(2, "0")}</span>
                <span>
                  <b>{act.performerName}</b>
                  <small>
                    {act.schoolYear} · {act.actName}
                  </small>
                </span>
                <span>{current ? "CURRENT" : status}</span>
                <span>
                  {current && projection.show.resultRevealState === "REVEALED"
                    ? "REVEALED"
                    : ""}
                </span>
              </button>
            );
          })}
        </div>
        <div className="sequence-controls">
          <button type="button" onClick={() => send("PREVIOUS_ACT")}>
            ← Previous
          </button>
          <button type="button" onClick={() => send("NEXT_ACT")}>
            Next →
          </button>
        </div>
      </section>
      <div className="admin-column">
        {view === "results" && (
          <ResultsPanel
            ranking={projection.ranking}
            stage={projection.runtime.resultsStage}
            revealedGroups={projection.runtime.resultsRevealedGroups}
            displayMode={projection.show.displayMode}
            activeActId={projection.show.activeActId}
            send={send}
          />
        )}
        {view === "setup" && (
          <>
            <PreflightPanel client={client} />
            <PublicTextPanel
              intermissionMessage={projection.show.intermissionMessage}
              emergencyMessage={projection.show.emergencyMessage}
              send={send}
            />
            <JudgeLinks judgeConnections={judgeConnections} />
          </>
        )}
        {view === "show" && (
          <>
            <section
              className="current-workspace"
              aria-label="Current act workspace"
            >
              <div className="region-title">
                <p>CURRENT ACT</p>
                <h2>{active ? active.actName : "No act selected"}</h2>
                <span>
                  {active?.performerName}{" "}
                  {active ? `· ${active.schoolYear}` : ""}
                  {active?.withdrawn ? " · WITHDRAWN" : ""}
                </span>
              </div>
              <div className="display-controls">
                <p>DISPLAY MODE</p>
                {MODES.map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={
                      projection.show.displayMode === mode ? "is-active" : ""
                    }
                    onClick={() => send("SET_DISPLAY_MODE", { mode })}
                  >
                    {mode.replaceAll("_", " ")}
                  </button>
                ))}
                <button
                  type="button"
                  className={`display-controls__black${projection.runtime.blackScreen ? " is-active" : ""}`}
                  onClick={() => send("BLACK_SCREEN")}
                >
                  BLACK
                </button>
              </div>
            </section>
            <EmergencyPanel
              displayMode={projection.show.displayMode}
              previousDisplayMode={projection.runtime.previousDisplayMode}
              presentation={projection.runtime.emergencyPresentation}
              send={send}
            />
            <MediaConsole
              act={active}
              runtime={projection.runtime}
              displayMode={projection.show.displayMode}
              telemetry={telemetry}
              projectorAcknowledgement={projectorAcknowledgement}
              commandAcknowledgement={acknowledgement}
              send={send}
            />
            <section
              className={`voting-workspace ${votingOpen ? "voting-workspace--open" : ""}`}
              aria-label="Audience voting"
            >
              <div className="region-title">
                <p>AUDIENCE VOTING</p>
                <h2>{votingOpen ? "OPEN" : "CLOSED"}</h2>
                <span>{active?.actName ?? "Select an act"}</span>
              </div>
              <div className="vote-metrics">
                <span>
                  <b>{aggregate?.voteCount ?? 0}</b> accepted votes
                </span>
                <span>
                  <b>{aggregate?.weightedMean?.toFixed(2) ?? "—"}</b> weighted
                  mean
                </span>
                <span>
                  <b>{audienceConnections}</b> audience phones
                </span>
                <span>
                  <b>{connection}</b> update health
                </span>
              </div>
              <div className="vote-actions">
                <button
                  type="button"
                  disabled={!active || votingOpen}
                  onClick={() => {
                    if (
                      active &&
                      window.confirm(`Open voting for ${active.actName}?`)
                    )
                      send("OPEN_AUDIENCE_VOTING");
                  }}
                >
                  OPEN AUDIENCE VOTING
                </button>
                <button
                  type="button"
                  disabled={!votingOpen}
                  onClick={() => send("CLOSE_AUDIENCE_VOTING")}
                >
                  CLOSE AUDIENCE VOTING
                </button>
              </div>
            </section>
            <section className="judge-workspace" aria-labelledby="judge-title">
              <div className="region-title">
                <p>ADJUDICATORS</p>
                <h2 id="judge-title">Judge control matrix</h2>
                <span>
                  Connection, permission, and submitted score are independent.
                </span>
              </div>
              <div className="judge-global">
                <button type="button" onClick={() => send("OPEN_ALL_JUDGES")}>
                  OPEN ALL
                </button>
                <button type="button" onClick={() => send("CLOSE_ALL_JUDGES")}>
                  CLOSE ALL
                </button>
              </div>
              <div className="judge-grid">
                {projection.judges.map((judge) => (
                  <article className="judge-row" key={judge.id}>
                    <header>
                      <b>{judge.displayName}</b>
                      <small>
                        Judge {judge.slot} ·{" "}
                        <span
                          className={
                            judgeConnections.has(judge.id)
                              ? "signal signal--live"
                              : "signal"
                          }
                        >
                          {judgeConnections.has(judge.id)
                            ? "CONNECTED"
                            : "OFFLINE"}
                        </span>
                      </small>
                    </header>
                    <div>
                      <span
                        className={
                          judge.permission === "OPEN"
                            ? "signal signal--live"
                            : "signal"
                        }
                      >
                        {judge.permission}
                      </span>
                      <span
                        className={
                          judge.submission ? "signal signal--locked" : "signal"
                        }
                      >
                        {judge.submission ? "LOCKED" : "WAITING"}
                      </span>
                    </div>
                    {judge.submission ? (
                      <p>
                        <b>{judge.submission.input.raw}</b>
                        {Math.abs(
                          judge.submission.effectiveScore -
                            (judge.submission.parsed.finiteValue ??
                              judge.submission.effectiveScore),
                        ) > 0.001 && (
                          <> → {judge.submission.effectiveScore.toFixed(3)}</>
                        )}
                        <small>
                          {new Date(
                            judge.submission.submittedAt,
                          ).toLocaleTimeString()}
                        </small>
                      </p>
                    ) : (
                      <p className="judge-empty">No score submitted</p>
                    )}
                    <footer>
                      <button
                        type="button"
                        disabled={Boolean(judge.submission)}
                        onClick={() =>
                          send("OPEN_JUDGE", { judgeId: judge.id })
                        }
                      >
                        OPEN
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          send("CLOSE_JUDGE", { judgeId: judge.id })
                        }
                      >
                        CLOSE
                      </button>
                    </footer>
                  </article>
                ))}
              </div>
            </section>
            <section className="score-workspace" aria-labelledby="score-title">
              <div className="region-title">
                <p>LIVE SCORING</p>
                <h2 id="score-title">
                  {result?.kind === "incomplete"
                    ? "INCOMPLETE"
                    : result?.kind === "finalised"
                      ? "FINALISED"
                      : "PROVISIONAL"}
                </h2>
                <span>
                  {result?.kind === "incomplete"
                    ? `${result.missingJudgeSlots.length} judge score(s) and${result.audienceMissing ? " audience votes" : ""} remaining`
                    : active?.actName}
                </span>
              </div>
              <div className="score-metrics">
                <span>
                  <small>Audience weighted</small>
                  <b>{aggregate?.weightedMean?.toFixed(2) ?? "—"}</b>
                  <em>{aggregate?.voteCount ?? 0} votes</em>
                </span>
                <span>
                  <small>Audience 50%</small>
                  <b>{audienceContribution?.toFixed(3) ?? "—"}</b>
                </span>
                <span>
                  <small>Judge mean</small>
                  <b>{judgeMean?.toFixed(3) ?? "—"}</b>
                </span>
                <span>
                  <small>Judges 50%</small>
                  <b>{judgeContribution?.toFixed(3) ?? "—"}</b>
                  <em>{submittedScores.length}/4 locked</em>
                </span>
                <span>
                  <small>Final result</small>
                  <b>
                    {result?.kind === "incomplete" || !result
                      ? "—"
                      : result.value.toFixed(3)}
                  </b>
                </span>
              </div>
              <div className="score-actions">
                <button
                  type="button"
                  disabled={result?.kind !== "provisional"}
                  onClick={() => send("FINALISE_RESULT")}
                >
                  FINALISE
                </button>
                <button
                  type="button"
                  disabled={
                    result?.kind !== "finalised" ||
                    projection.show.resultRevealState === "REVEALED"
                  }
                  onClick={() => send("REVEAL_RESULT")}
                >
                  REVEAL
                </button>
                <button
                  type="button"
                  disabled={projection.show.resultRevealState !== "REVEALED"}
                  onClick={() => send("HIDE_RESULT")}
                >
                  HIDE
                </button>
              </div>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
