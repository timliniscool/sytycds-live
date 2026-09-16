import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  Component,
  type ReactNode,
} from "react";

import {
  commandId,
  PROTOCOL_VERSION,
  SHOW_STEPS,
  showRevision,
  type DisplayMode,
  type ShowFlowState,
} from "../../shared/domain";
import { projectorStatusLabels } from "../admin/ProjectorPairingPanel";
import type {
  AdminCommand,
  AdminCommandType,
} from "../../shared/admin-command";
import { EmergencyPanel } from "../admin/EmergencyPanel";
import { HistoryPanel } from "../admin/HistoryPanel";
import { AnalyticsPanel } from "../admin/AnalyticsPanel";
import { ClearActScoresDialog } from "../admin/ClearActScores";
import { MediaConsole } from "../admin/MediaConsole";
import { JudgeEntry } from "../math/MathExpression";
import { ResultsPanel } from "../admin/ResultsPanel";
import { ShowIdentityPanel } from "../admin/ShowIdentityPanel";
import {
  RealtimeClient,
  showWebSocketUrl,
  useRealtimeSelector,
} from "../realtime/RealtimeClient";
import { PLATFORM_ATTRIBUTION, PLATFORM_NAME } from "../../shared/platform";
import { useShowDocumentTitle, useShowTheme } from "../theme";

// Keep pre-show configuration code out of the critical live-control bundle.
// These workspaces load on first use and remain cached by the browser.
const ActEditor = lazy(async () => {
  const module = await import("../admin/ActEditor");
  return { default: module.ActEditor };
});
const SetupWorkspace = lazy(async () => {
  const module = await import("../admin/SetupWorkspace");
  return { default: module.SetupWorkspace };
});
// The guide carries the whole README; it loads only when an operator opens it.
const HelpPanel = lazy(async () => {
  const module = await import("../admin/HelpPanel");
  return { default: module.HelpPanel };
});

/**
 * A lazily loaded view can fail to arrive — most often an old console tab
 * asking for a chunk that a new deployment has replaced. Without a boundary
 * that error unmounts the whole console and the operator sees a blank screen;
 * with one, the view says what happened and offers the one fix.
 */
class ViewBoundary extends Component<
  { name: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="admin-view-failed" role="alert">
        <strong>The {this.props.name} could not be loaded.</strong>
        <span>
          This usually means the console was updated while this tab was open.
          Reload to pick up the current version; the show itself is unaffected.
        </span>
        <button type="button" onClick={() => window.location.reload()}>
          RELOAD CONSOLE
        </button>
      </div>
    );
  }
}

type AuthenticationState =
  "checking" | "submitting" | "signed-out" | "signed-in" | "failed";
type ConsoleView = "show" | "acts" | "results" | "setup" | "history";

interface PublicConfig {
  title: string;
  themeId: string;
  fontFamily: string;
}

function publicConfig(value: unknown): PublicConfig | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.title === "string" &&
    typeof candidate.themeId === "string" &&
    typeof candidate.fontFamily === "string"
    ? {
        title: candidate.title,
        themeId: candidate.themeId,
        fontFamily: candidate.fontFamily,
      }
    : null;
}

export default function AdminSurface() {
  const [authentication, setAuthentication] =
    useState<AuthenticationState>("checking");
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [branding, setBranding] = useState<PublicConfig | null>(null);

  useEffect(() => {
    void fetch("/api/public/config")
      .then((response) => (response.ok ? response.json() : null))
      .then((result: unknown) => setBranding(publicConfig(result)))
      .catch(() => undefined);
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
    setAuthentication("submitting");
    setLoginError(null);
    try {
      const response = await fetch("/api/admin/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      setPassword("");
      if (response.ok) {
        setAuthentication("signed-in");
        return;
      }
      setAuthentication("signed-out");
      setLoginError(
        response.status === 429
          ? "Too many attempts. Wait a moment before trying again."
          : "Username or password was not accepted.",
      );
    } catch {
      setAuthentication("failed");
      setLoginError(
        "The show server could not be reached. Check the network and retry.",
      );
    }
  }

  if (authentication !== "signed-in") {
    return (
      <OperatorSignIn
        authentication={authentication}
        branding={branding}
        loginError={loginError}
        username={username}
        password={password}
        onUsername={setUsername}
        onPassword={setPassword}
        onSubmit={submit}
      />
    );
  }

  return <Console />;
}

/**
 * The sign-in screen owns the theme while there is no operator session, and
 * the console owns it afterwards. Exactly one component writes the theme at any
 * moment, so an unrefreshed cached branding value can never overwrite the
 * authoritative one the coordinator just sent.
 */
function OperatorSignIn({
  authentication,
  branding,
  loginError,
  username,
  password,
  onUsername,
  onPassword,
  onSubmit,
}: {
  authentication: AuthenticationState;
  branding: PublicConfig | null;
  loginError: string | null;
  username: string;
  password: string;
  onUsername: (value: string) => void;
  onPassword: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  useShowTheme(branding?.themeId, branding?.fontFamily);
  useShowDocumentTitle(branding?.title, "Show control");
  return (
    <main
      className="surface surface--admin"
      aria-labelledby="admin-login-title"
    >
      <header className="admin-login__head">
        <p>{PLATFORM_NAME} / secured operator access</p>
        <h1 id="admin-login-title">Operator sign-in</h1>
        <span>{branding?.title ?? "Live event control"}</span>
      </header>
      {authentication === "checking" ? (
        <p>Checking operator session…</p>
      ) : (
        <form onSubmit={onSubmit}>
          <label htmlFor="admin-username">Username</label>
          <input
            id="admin-username"
            type="text"
            autoComplete="username"
            value={username}
            onChange={(event) => onUsername(event.target.value)}
            required
          />
          <label htmlFor="admin-password">Password</label>
          <input
            id="admin-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => onPassword(event.target.value)}
            required
          />
          <button type="submit" disabled={authentication === "submitting"}>
            {authentication === "submitting"
              ? "Signing in…"
              : "Sign in to show control"}
          </button>
          {loginError && <p role="alert">{loginError}</p>}
        </form>
      )}
      <footer>{PLATFORM_ATTRIBUTION}</footer>
    </main>
  );
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

/** Modes that are steps of the act flow; the step rail owns them. */
const SCREEN_STEP_MODES: ReadonlySet<DisplayMode> = new Set([
  "ACT_CARD",
  "PERFORMANCE",
  "SCOREBOARD",
]);
const VIEWS: readonly { view: ConsoleView; label: string }[] = [
  { view: "show", label: "SHOW" },
  { view: "acts", label: "ACTS & MEDIA" },
  { view: "results", label: "RESULTS" },
  { view: "setup", label: "SETUP & PREFLIGHT" },
  { view: "history", label: "HISTORY" },
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

/** What GO will do, in the words on the button. */
export function describeFlowNext(flow: ShowFlowState): string {
  switch (flow.next.kind) {
    case "step":
      return flow.next.step.replaceAll("_", " ");
    case "first_act":
      return `FIRST ACT · ${flow.next.label}`;
    case "next_act":
      return `NEXT ACT · ${flow.next.label}`;
    case "end":
      return "END OF RUNNING ORDER";
  }
}

function Console() {
  const clientRef = useRef<RealtimeClient | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = useState<ConsoleView>("show");
  const [helpOpen, setHelpOpen] = useState(false);
  const [clearing, setClearing] = useState<{
    actId: string;
    actName: string;
  } | null>(null);
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
  useShowTheme(projection?.show.themeId, projection?.show.fontFamily);
  useShowDocumentTitle(projection?.show.title, "Show control");
  const connection = useRealtimeSelector(client, (state) => state.connection);
  const lastError = useRealtimeSelector(client, (state) => state.lastError);
  const showUnavailable = useRealtimeSelector(
    client,
    (state) => state.showUnavailable,
  );
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
  const projectorAcknowledgement = useRealtimeSelector(
    client,
    (state) => state.lastProjectorAcknowledgement,
  );
  const presence = useRealtimeSelector(client, (state) => state.presence);
  // Live aggregates: the coordinator coalesces vote bursts into
  // `aggregate_update` messages, which land here; the snapshot copy inside the
  // projection is only the starting point.
  const liveAggregates = useRealtimeSelector(
    client,
    (state) => state.aggregates,
  );
  useEffect(() => {
    client.connect();
    return () => client.destroy();
  }, [client]);
  // Every refusal is said plainly. A "stale" answer means this console's
  // revision fell behind the coordinator: the state is re-fetched and the
  // operator is told to press again, instead of a control that seems dead.
  useEffect(() => {
    const ack = acknowledgement?.acknowledgement;
    if (!ack) return;
    if (ack.status === "stale") {
      client.requestResync();
      setNotice(
        "The console was a step behind the show and has refreshed. Press that again.",
      );
      return;
    }
    if (ack.status !== "accepted")
      setNotice(ack.reason ?? "That command was not accepted.");
  }, [acknowledgement, client]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 7_000);
    return () => clearTimeout(timer);
  }, [notice]);

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
  // Nothing here blocks with a dialog. A refused or risky action is said on
  // screen, and a risky one is confirmed by pressing the same control again
  // within a few seconds.
  const pressAgainRef = useRef<{ key: string; until: number } | null>(null);
  function confirmByPressingAgain(key: string, message: string): boolean {
    const pending = pressAgainRef.current;
    if (pending && pending.key === key && pending.until > Date.now()) {
      pressAgainRef.current = null;
      return true;
    }
    pressAgainRef.current = { key, until: Date.now() + 6_000 };
    setNotice(`${message} Press again to confirm.`);
    return false;
  }
  function select(actId: string): void {
    if (projection?.show.audienceVoteState === "OPEN") {
      setNotice(
        "Audience voting is open. Close it before changing the current act.",
      );
      return;
    }
    if (
      mediaPlaying &&
      !confirmByPressingAgain(`select:${actId}`, "Media is playing.")
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
      <main className="admin-console admin-console--loading">
        {showUnavailable ? (
          // A fresh deployment: the coordinator is up but no show exists yet.
          <ShowIdentityPanel current={null} />
        ) : (
          <p className="admin-loading">
            <span className="admin-mark">{PLATFORM_NAME} / CONTROL</span>
            {connection === "UNAUTHORISED"
              ? "The coordinator refused this operator session. Sign out and in again."
              : connection === "INCOMPATIBLE"
                ? "This console is out of date. Reload the page."
                : "Connecting to the show coordinator…"}
            <small>
              {connection.toLowerCase()}
              {lastError ? ` · ${lastError}` : ""}
            </small>
          </p>
        )}
      </main>
    );
  const active =
    projection.acts.find((act) => act.id === projection.show.activeActId) ??
    null;
  // What the operator has to be ready for, not just what is on now.
  const nextAct =
    projection.acts.find(
      (act) => !act.withdrawn && act.order > (active?.order ?? -1),
    ) ?? null;
  const aggregate = active
    ? (liveAggregates.get(active.id) ??
      projection.audienceAggregates.find((entry) => entry.actId === active.id))
    : null;
  const votingOpen = projection.show.audienceVoteState === "OPEN";
  const submittedScores = projection.judges.flatMap((judge) =>
    judge.submission ? [judge.submission.effectiveScore] : [],
  );
  const judgeContribution =
    projection.show.audienceWeight < 1 &&
    submittedScores.length === projection.judges.length &&
    projection.judges.length > 0
      ? (submittedScores.reduce((sum, score) => sum + score, 0) /
          projection.judges.length) *
        (1 - projection.show.audienceWeight)
      : null;
  const judgeMean =
    submittedScores.length === projection.judges.length &&
    projection.judges.length > 0
      ? submittedScores.reduce((sum, score) => sum + score, 0) /
        projection.judges.length
      : null;
  const audienceContribution =
    aggregate?.weightedMean === null || aggregate?.weightedMean === undefined
      ? null
      : aggregate.weightedMean * projection.show.audienceWeight;
  const result = active ? projection.results[active.id] : undefined;
  const projectorStatus = projectorStatusLabels(presence);
  const flow = projection.runtime.flow;
  return (
    <main className="admin-console">
      <header className="admin-status">
        <span className="admin-mark">{PLATFORM_NAME} / CONTROL</span>
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
              aria-pressed={view === entry.view}
              onClick={() => setView(entry.view)}
            >
              {entry.label}
            </button>
          ))}
        </nav>
        {/* Standing readiness from the coordinator's own sockets and sessions:
            paired, connected and armed are three facts, never inferred from
            telemetry. Audio can only be armed on the projector itself. */}
        <strong
          className={`projector-readout${projectorStatus.ready ? " is-ready" : ""}`}
          title="Live from the coordinator"
        >
          PROJECTOR {projectorStatus.connection} · {projectorStatus.audio}
        </strong>
        {projection.runtime.blackScreen && (
          <strong className="admin-status__alarm">SCREEN BLACKED OUT</strong>
        )}
        {projection.show.displayMode === "EMERGENCY" && (
          <strong className="admin-status__alarm">EMERGENCY ON SCREEN</strong>
        )}
        {projectorAcknowledgement && !projectorAcknowledgement.succeeded && (
          <strong className="admin-status__alarm">
            PROJECTOR COMMAND FAILED
          </strong>
        )}
        <small className="admin-status__attribution">
          {PLATFORM_ATTRIBUTION}
        </small>
        <button
          type="button"
          className="admin-status__logout"
          onClick={() => {
            void fetch("/api/admin/logout", {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: "{}",
            }).finally(() => window.location.reload());
          }}
        >
          SIGN OUT
        </button>
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
          {projection.acts.length === 0 && (
            <p className="act-list__empty">
              No acts yet. Add the running order before doors.
            </p>
          )}
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
                aria-disabled={votingOpen && !current}
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
          <button
            type="button"
            className="admin-help-button"
            aria-haspopup="dialog"
            aria-expanded={helpOpen}
            title="Help & operator guide"
            onClick={() => setHelpOpen(true)}
          >
            <span aria-hidden="true">?</span> Help
          </button>
          <button
            type="button"
            disabled={votingOpen}
            onClick={() => send("PREVIOUS_ACT")}
          >
            ← Previous
          </button>
          <button
            type="button"
            disabled={votingOpen}
            onClick={() => send("NEXT_ACT")}
          >
            Next →
          </button>
          {votingOpen && (
            <p className="sequence-controls__hint">
              Audience voting is open — close it to change the act.
            </p>
          )}
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
        {view === "history" && (
          <HistoryPanel
            revision={revision === null ? null : Number(revision)}
          />
        )}
        {view === "acts" && (
          <ViewBoundary name="act editor">
            <Suspense
              fallback={<p className="admin-loading">Loading act editor…</p>}
            >
              <ActEditor
                acts={projection.acts}
                activeActId={projection.show.activeActId}
                onSelectLive={select}
              />
            </Suspense>
          </ViewBoundary>
        )}
        {view === "setup" && (
          <ViewBoundary name="setup view">
            <Suspense
              fallback={<p className="admin-loading">Loading setup…</p>}
            >
              <SetupWorkspace
                projection={projection}
                client={client}
                judgeConnections={judgeConnections}
                presence={presence}
                send={send}
              />
            </Suspense>
          </ViewBoundary>
        )}
        {view === "show" && (
          <>
            {/*
              An override is on the screen in the hall. The console says so in
              its own right, above everything else, because the display-mode
              buttons below will happily look normal while the projector is
              black — and an operator must never have to infer that.
            */}
            {(projection.runtime.blackScreen ||
              projection.show.displayMode === "EMERGENCY") && (
              <section className="override-banner" role="alert">
                <strong>
                  {projection.show.displayMode === "EMERGENCY"
                    ? "EMERGENCY ON SCREEN"
                    : "BLACKOUT ACTIVE"}
                </strong>
                <span>
                  {projection.show.displayMode === "EMERGENCY"
                    ? "The hall sees the emergency output. Nothing else is visible."
                    : "The hall sees black. Changing the display mode will not appear until blackout is lifted."}
                </span>
                <button
                  type="button"
                  className="override-banner__return"
                  onClick={() =>
                    projection.show.displayMode === "EMERGENCY"
                      ? send("RESTORE_DISPLAY")
                      : send("BLACK_SCREEN")
                  }
                >
                  RETURN TO SHOW
                </button>
              </section>
            )}
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
              <p className="current-workspace__next">
                <b>NEXT</b>{" "}
                {nextAct
                  ? `${nextAct.actName} — ${nextAct.performerName}`
                  : "End of the running order"}
              </p>
              {/*
                The show flow: one GO advances an ordinary act through its
                steps, and the button says what it is about to do. Voting
                close, blackout, emergency and finalising stay explicit below.
              */}
              <div className="show-flow" aria-label="Show flow">
                <p>
                  SHOW FLOW ·{" "}
                  {flow.step ? flow.step.replaceAll("_", " ") : "NOT STARTED"}
                </p>
                <button
                  type="button"
                  className="show-flow__go"
                  disabled={flow.blocked !== null}
                  title={flow.blocked ?? undefined}
                  onClick={() => send("ADVANCE_SHOW")}
                >
                  GO
                  <small>{flow.blocked ?? describeFlowNext(flow)}</small>
                </button>
                <div className="show-flow__steps">
                  {SHOW_STEPS.map((step) => (
                    <button
                      key={step}
                      type="button"
                      className={flow.step === step ? "is-active" : ""}
                      aria-pressed={flow.step === step}
                      disabled={!active}
                      onClick={() => send("SET_SHOW_STEP", { step })}
                    >
                      {step.replaceAll("_", " ")}
                    </button>
                  ))}
                </div>
              </div>
              <div className="display-controls">
                <p>SCREEN</p>
                {MODES.filter((mode) => !SCREEN_STEP_MODES.has(mode)).map(
                  (mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={
                        projection.show.displayMode === mode ? "is-active" : ""
                      }
                      aria-pressed={projection.show.displayMode === mode}
                      onClick={() => send("SET_DISPLAY_MODE", { mode })}
                    >
                      {mode.replaceAll("_", " ")}
                    </button>
                  ),
                )}
                <button
                  type="button"
                  className={`display-controls__black${projection.runtime.blackScreen ? " is-active" : ""}`}
                  aria-pressed={projection.runtime.blackScreen}
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
              client={client}
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
                  <b>{presence?.audience ?? audienceConnections}</b> audience
                  phones
                </span>
                <span>
                  <b>{connection}</b> update health
                </span>
              </div>
              <div className="vote-actions">
                {votingOpen ? (
                  <button
                    type="button"
                    className="vote-actions__close"
                    onClick={() => send("CLOSE_AUDIENCE_VOTING")}
                  >
                    CLOSE AUDIENCE VOTING
                  </button>
                ) : (
                  <button
                    type="button"
                    className="vote-actions__open"
                    disabled={!active}
                    onClick={() => {
                      if (
                        active &&
                        confirmByPressingAgain(
                          "open-voting",
                          `Open audience voting for ${active.actName}?`,
                        )
                      )
                        send("OPEN_AUDIENCE_VOTING");
                    }}
                  >
                    OPEN AUDIENCE VOTING
                  </button>
                )}
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
                        <b>
                          <JudgeEntry raw={judge.submission.input.raw} />
                        </b>
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
                  {!active
                    ? "NO ACT"
                    : result?.kind === "incomplete"
                      ? "INCOMPLETE"
                      : result?.kind === "finalised"
                        ? "FINALISED"
                        : "PROVISIONAL"}
                </h2>
                <span>
                  {!active
                    ? "Select an act to begin scoring."
                    : result?.kind === "incomplete"
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
                  <small>
                    Audience {Math.round(projection.show.audienceWeight * 100)}%
                  </small>
                  <b>{audienceContribution?.toFixed(3) ?? "—"}</b>
                </span>
                <span>
                  <small>Judge mean</small>
                  <b>{judgeMean?.toFixed(3) ?? "—"}</b>
                </span>
                <span>
                  <small>
                    Judges{" "}
                    {Math.round((1 - projection.show.audienceWeight) * 100)}%
                  </small>
                  <b>{judgeContribution?.toFixed(3) ?? "—"}</b>
                  <em>
                    {submittedScores.length}/{projection.judges.length} locked
                  </em>
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
                <button
                  type="button"
                  className="score-actions__clear"
                  disabled={!active}
                  title="Remove every vote, judge score and result for this act"
                  onClick={() =>
                    active &&
                    setClearing({ actId: active.id, actName: active.actName })
                  }
                >
                  CLEAR VOTES & SCORES…
                </button>
              </div>
            </section>
            <AnalyticsPanel />
          </>
        )}
      </div>
      {/*
        The operator guide opens over the console from the Help pill in the
        running-order footer; it is never a destination the console switches to.
      */}
      {clearing && (
        <ClearActScoresDialog
          actId={clearing.actId}
          actName={clearing.actName}
          onDone={(message) => setNotice(message)}
          onClose={() => setClearing(null)}
        />
      )}
      {notice && (
        <output className="admin-toast" role="status">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)}>
            DISMISS
          </button>
        </output>
      )}
      {helpOpen && (
        <div
          className="admin-help"
          role="dialog"
          aria-modal="true"
          aria-label="Help and operator guide"
          onClick={(event) => {
            if (event.target === event.currentTarget) setHelpOpen(false);
          }}
        >
          <div className="admin-help__sheet">
            <header className="admin-help__head">
              <p>HELP & OPERATOR GUIDE</p>
              <button type="button" onClick={() => setHelpOpen(false)}>
                CLOSE
              </button>
            </header>
            <div className="admin-help__body">
              <ViewBoundary name="operator guide">
                <Suspense
                  fallback={<p className="admin-loading">Loading guide…</p>}
                >
                  <HelpPanel />
                </Suspense>
              </ViewBoundary>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
