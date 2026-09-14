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
import {
  RealtimeClient,
  showWebSocketUrl,
  useRealtimeSelector,
} from "../realtime/RealtimeClient";

type AuthenticationState = "checking" | "signed-out" | "signed-in" | "failed";

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

const MODES: readonly DisplayMode[] = [
  "LOBBY",
  "ACT_CARD",
  "PERFORMANCE",
  "SCOREBOARD",
  "INTERMISSION",
  "HOLD",
  "FINAL_RESULTS",
  "EMERGENCY",
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
  const acknowledgement = useRealtimeSelector(
    client,
    (state) => state.lastCommandAcknowledgement,
  );
  const audienceConnections = useRealtimeSelector(
    client,
    (state) => state.audienceConnections,
  );
  useEffect(() => {
    client.connect();
    return () => client.destroy();
  }, [client]);
  useEffect(() => {
    if (acknowledgement?.acknowledgement.reason)
      setNotice(acknowledgement.acknowledgement.reason);
  }, [acknowledgement]);

  function send(
    type: AdminCommandType,
    extras: Record<string, unknown> = {},
  ): void {
    if (!projection) return;
    const command = {
      protocolVersion: PROTOCOL_VERSION,
      commandId: commandId(id()),
      expectedRevision: showRevision(Number(projection.show.revision)),
      type,
      ...extras,
    } as AdminCommand;
    if (
      !client.send({
        type: "admin_command",
        protocolVersion: PROTOCOL_VERSION,
        command,
      })
    )
      setNotice("Control link is not live");
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
  return (
    <main className="admin-console">
      <header className="admin-status">
        <span className="admin-mark">SYTYCDS / CONTROL</span>
        <strong
          className={`connection connection--${connection.toLowerCase()}`}
        >
          {connection}
        </strong>
        <span>REV {projection.show.revision}</span>
        <span>
          PROJECTOR {projection.show.displayMode.replaceAll("_", " ")}
        </span>
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
            const status =
              result?.kind === "finalised"
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
                className={`act-row${current ? " act-row--current" : ""}`}
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
      <section className="current-workspace" aria-label="Current act workspace">
        <div className="region-title">
          <p>CURRENT ACT</p>
          <h2>{active ? active.actName : "No act selected"}</h2>
          <span>
            {active?.performerName} {active ? `· ${active.schoolYear}` : ""}
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
              onClick={() => {
                if (
                  mode === "EMERGENCY" &&
                  !window.confirm("Activate emergency display?")
                )
                  return;
                send("SET_DISPLAY_MODE", { mode });
              }}
            >
              {mode.replaceAll("_", " ")}
            </button>
          ))}
          <button
            type="button"
            className={projection.runtime.blackScreen ? "is-active" : ""}
            onClick={() => send("BLACK_SCREEN")}
          >
            BLACK
          </button>
          {projection.show.displayMode === "HOLD" && (
            <small>Restore target is retained by the coordinator.</small>
          )}
        </div>
      </section>
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
            <b>{aggregate?.weightedMean?.toFixed(2) ?? "—"}</b> weighted mean
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
      <section className="media-workspace" aria-label="Media workspace">
        <div>
          <p>MEDIA</p>
          <b>
            Visual {projection.runtime.visualTransport} · Audio{" "}
            {projection.runtime.audioTransport}
          </b>
        </div>
        <div>
          <button type="button" onClick={() => send("PAUSE_MEDIA")}>
            Pause
          </button>
          <button type="button" onClick={() => send("RESUME_MEDIA")}>
            Resume
          </button>
          <button type="button" onClick={() => send("STOP_MEDIA")}>
            Stop all
          </button>
        </div>
      </section>
    </main>
  );
}
