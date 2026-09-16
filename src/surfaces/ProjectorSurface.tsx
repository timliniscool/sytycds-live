import { useEffect, useRef, useState } from "react";

import { PROTOCOL_VERSION, type MediaCacheSummary } from "../../shared/domain";
import type { MediaCommandMessage } from "../../shared/protocol";
import {
  ProjectorMediaEngine,
  type ProjectorMediaStatus,
} from "../projector/MediaEngine";
import { MediaCache } from "../projector/media-cache";
import { cacheStorageAvailable, probeAssets } from "../projector/preflight";
import {
  ActCardGraphic,
  EmergencyGraphic,
  PerformanceGraphic,
  HoldGraphic,
  HoldingGraphic,
  IntermissionGraphic,
  LobbyGraphic,
  TitleCardGraphic,
} from "../projector/ProjectorGraphics";
import { FinalResultsGraphic } from "../projector/Results";
import { deriveScene, type ProjectorBase } from "../projector/scene";
import { ScoreboardGraphic } from "../projector/Scoreboard";
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
import { ReactionLane } from "../reactions/ReactionLane";

const INITIAL_MEDIA: ProjectorMediaStatus = {
  visual: "IDLE",
  audio: "IDLE",
  armed: false,
  black: false,
  error: null,
  hasFrame: false,
};

/** Sampling rate for the operator's transport readout. */
const TELEMETRY_INTERVAL_MS = 500;
/** Repeat interval for unchanged telemetry, so a reloaded console recovers. */
const TELEMETRY_HEARTBEAT_MS = 5_000;

export default function ProjectorSurface() {
  const [pairing, setPairing] = useState<"checking" | "unpaired" | "paired">(
    "checking",
  );
  const [pairingCode, setPairingCode] = useState("");
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  /**
   * The operator has pressed ENABLE AUDIO & ENTER SHOW, or has deliberately
   * continued without sound. Until then the gate covers the output, so the
   * gesture the browser needs is impossible to walk past by accident.
   */
  const [enteredShow, setEnteredShow] = useState(false);
  const [armError, setArmError] = useState<string | null>(null);
  const [media, setMedia] = useState(INITIAL_MEDIA);
  const [cache, setCache] = useState<MediaCacheSummary | null>(null);
  const [diagnostics, setDiagnostics] = useState(false);
  const clientRef = useRef<RealtimeClient | null>(null);
  const engineRef = useRef<ProjectorMediaEngine | null>(null);
  const cacheRef = useRef<MediaCache | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  if (!clientRef.current)
    clientRef.current = new RealtimeClient({
      url: showWebSocketUrl(window.location),
      hello: {
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        requestedRole: "projector",
      },
    });
  const client = clientRef.current;
  const projection = useRealtimeSelector(client, (state) =>
    state.projection?.role === "projector" ? state.projection : null,
  );
  const command = useRealtimeSelector(
    client,
    (state) => state.lastMediaCommand,
  );
  const preflightRequest = useRealtimeSelector(
    client,
    (state) => state.lastPreflightRequest,
  );
  const connection = useRealtimeSelector(client, (state) => state.connection);
  const revision = useRealtimeSelector(client, (state) => state.revision);
  const aggregates = useRealtimeSelector(client, (state) => state.aggregates);
  const reactionSignal = useRealtimeSelector(
    client,
    (state) => state.lastReactionSignal,
  );
  const reactionClear = useRealtimeSelector(
    client,
    (state) => state.lastReactionClear,
  );
  // The hall draws the current act in its own appearance when it has one.
  const appearance = projection
    ? effectiveAppearance(projection.show, projection.activeAct)
    : null;
  useShowTheme(appearance?.themeId, appearance?.fontFamily, true);
  useShowDocumentTitle(projection?.show.title, "Projector");

  useEffect(() => {
    void fetch("/api/projector/session", { credentials: "same-origin" })
      .then((response) => response.json() as Promise<{ paired: boolean }>)
      .then((result) => setPairing(result.paired ? "paired" : "unpaired"))
      .catch(() => setPairing("unpaired"));
  }, []);

  // No socket is opened before this display holds a session. An unpaired
  // connection would be refused, and a refused connection is terminal.
  useEffect(() => {
    if (pairing !== "paired") return;
    client.connect();
    return () => client.destroy();
  }, [client, pairing]);

  // The coordinator refused this display: its session was revoked or expired.
  // That is a pairing state, not a dead end, so the display asks for a code
  // again rather than sitting on "not authorised" until somebody reloads it.
  useEffect(() => {
    if (connection !== "UNAUTHORISED") return;
    setPairing("unpaired");
    setEnteredShow(false);
    setPairingError("This display is no longer paired. Enter a new code.");
  }, [connection]);

  /**
   * Pairing is a credential transition, not a page load. The coordinator reads
   * the projector session cookie once, during the WebSocket handshake, so the
   * unauthorised socket has to be replaced by a new one that carries the cookie
   * this response just set. The authorised socket then asks for the snapshot
   * itself, and the display moves straight to live output.
   */
  async function pair(): Promise<void> {
    setPairingError(null);
    setPairingBusy(true);
    try {
      const response = await fetch("/api/projector/pair", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: pairingCode }),
      });
      const result = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!response.ok) {
        setPairingError(result?.error ?? "Pairing failed");
        return;
      }
      setPairingCode("");
      setPairing("paired");
      client.reconnectWithNewCredential();
    } catch {
      setPairingError("The show server could not be reached. Try again.");
    } finally {
      setPairingBusy(false);
    }
  }

  /**
   * Called directly from the click handler. `engine.arm()` issues both
   * gesture-sensitive browser calls synchronously inside this call, before the
   * first `await`; only the state updates below happen afterwards. Nothing
   * here fakes success: the gate lifts only once the browser has said yes.
   */
  async function enableAudioAndEnter(): Promise<void> {
    const engine = engineRef.current;
    if (!engine) {
      setArmError("The media engine is not ready yet. Try again in a moment.");
      return;
    }
    const arming = engine.arm();
    const armed = await arming;
    setArmError(
      armed ? null : "This browser refused to enable audio. Try again.",
    );
    if (armed) setEnteredShow(true);
  }

  useEffect(() => {
    if (pairing !== "paired") return;
    const engine = new ProjectorMediaEngine({
      onStatus: setMedia,
      onAcknowledgement: (executionId, succeeded, detail) =>
        client.send({
          type: "projector_ack",
          protocolVersion: PROTOCOL_VERSION,
          commandId: executionId as MediaCommandMessage["executionId"],
          succeeded,
          state: succeeded
            ? detail === "PREPARED"
              ? "prepared"
              : detail === "PAUSED"
                ? "paused"
                : detail === "ENDED"
                  ? "ended"
                  : "started"
            : "failed",
          detail,
        }),
    });
    engineRef.current = engine;
    if (hostRef.current) engine.attach(hostRef.current);
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, [client, pairing]);

  // The media service worker answers /api/media/* from CacheStorage so a
  // prepared file survives a Wi-Fi drop; the page fills that cache from the
  // manifest. Both are scoped to this route and touch no other traffic.
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker
        .register("/media-sw.js", { scope: "/projector" })
        .catch(() => undefined);
    }
    const mediaCache = new MediaCache(setCache);
    cacheRef.current = mediaCache;
    return () => {
      mediaCache.dispose();
      cacheRef.current = null;
    };
  }, []);

  const manifest = projection?.mediaManifest ?? null;
  useEffect(() => {
    if (manifest) void cacheRef.current?.sync(manifest);
  }, [manifest]);

  // Every snapshot and media patch converges the engine on the authoritative
  // transports. A reconnect therefore restores the presentation without
  // restarting anything that already matches.
  const runtime = projection?.runtime ?? null;
  const cues = projection?.activeCues ?? null;
  useEffect(() => {
    if (runtime && cues) void engineRef.current?.reconcile(runtime, cues);
  }, [runtime, cues]);

  useEffect(() => {
    if (command && runtime && cues) {
      client.send({
        type: "projector_ack",
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.executionId,
        succeeded: true,
        state: "received",
        detail: "RECEIVED",
      });
      void engineRef.current?.execute(command, runtime, cues);
    }
  }, [client, command, runtime, cues]);

  useEffect(() => {
    if (!preflightRequest) return;
    let cancelled = false;
    void probeAssets(preflightRequest.assets).then((assets) => {
      if (cancelled) return;
      client.send({
        type: "projector_preflight",
        protocolVersion: PROTOCOL_VERSION,
        requestId: preflightRequest.requestId,
        report: {
          protocolVersion: PROTOCOL_VERSION,
          engineReady: engineRef.current?.isReady() ?? false,
          armed: engineRef.current?.telemetry().armed ?? false,
          cacheStorage: cacheStorageAvailable(),
          assets,
          ...(cacheRef.current ? { cache: cacheRef.current.summary() } : {}),
        },
      });
    });
    return () => {
      cancelled = true;
    };
  }, [preflightRequest, client]);

  // Playback position exists only in this browser's media elements. It is
  // sampled and forwarded when it changes, so the operator can see the
  // transport without the projector ever re-rendering for it.
  useEffect(() => {
    let previous = "";
    let sentAt = 0;
    const timer = setInterval(() => {
      const engine = engineRef.current;
      if (!engine) return;
      const status = {
        ...engine.telemetry(),
        ...(cacheRef.current ? { cache: cacheRef.current.summary() } : {}),
      };
      const encoded = JSON.stringify(status);
      const now = Date.now();
      if (encoded === previous && now - sentAt < TELEMETRY_HEARTBEAT_MS) return;
      previous = encoded;
      sentAt = now;
      client.send({
        type: "projector_status",
        protocolVersion: PROTOCOL_VERSION,
        status,
      });
    }, TELEMETRY_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [client]);

  // Operator diagnostics live behind a key so they can never reach the hall
  // by accident; `d` toggles them from the projector keyboard.
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "d") setDiagnostics((value) => !value);
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);

  const scene = deriveScene(projection, connection, window.location.origin);
  const blackout = scene.base.kind === "BLACKOUT";
  const degraded = connection !== "LIVE";
  const aggregate = projection?.activeAct
    ? (aggregates.get(projection.activeAct.id) ??
      projection.scoreboard.audience)
    : null;

  if (pairing !== "paired") {
    return (
      <main
        className="projector projector-pairing"
        aria-labelledby="projector-pair-title"
      >
        <p>{PLATFORM_NAME}</p>
        <h1 id="projector-pair-title">Pair this display</h1>
        {pairing === "checking" ? (
          <p>Checking this display…</p>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void pair();
            }}
          >
            <label htmlFor="projector-code">8-digit code</label>
            <input
              id="projector-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]{8,9}"
              maxLength={9}
              value={pairingCode}
              onChange={(event) => {
                const digits = event.target.value
                  .replace(/\D/gu, "")
                  .slice(0, 8);
                setPairingCode(
                  digits.length > 4
                    ? `${digits.slice(0, 4)} ${digits.slice(4)}`
                    : digits,
                );
              }}
            />
            <button
              type="submit"
              disabled={
                pairingBusy || pairingCode.replace(/\s/gu, "").length !== 8
              }
            >
              {pairingBusy ? "PAIRING…" : "PAIR DISPLAY"}
            </button>
            {pairingError && <p role="alert">{pairingError}</p>}
          </form>
        )}
        <footer>{PLATFORM_ATTRIBUTION}</footer>
      </main>
    );
  }

  return (
    <main className="projector" aria-label={`${PLATFORM_NAME} projector`}>
      <Base
        base={scene.base}
        judges={projection?.scoreboard.judges ?? []}
        aggregate={aggregate}
        revealedResult={projection?.revealedResult ?? null}
        // A commanded visual that never produced a frame — a missing file, a
        // codec the projector cannot decode — must not leave the hall staring
        // at nothing. The act's own performance screen is the safe fallback.
        mediaFrameReady={media.hasFrame}
      />
      <div
        className={[
          "projector-media",
          scene.mediaVisible && media.hasFrame ? "projector-media--framed" : "",
          scene.mediaVisible ? "" : "projector-media--hidden",
        ].join(" ")}
        ref={hostRef}
      />
      {scene.layer.kind === "TITLE_CARD" && (
        <TitleCardGraphic title={scene.layer.title} />
      )}
      {scene.base.kind === "BLACKOUT" && (
        // True black over everything: no graphic, no text, no reaction lane.
        <div className="projector-black" aria-hidden="true" />
      )}
      {projection?.show.reactionsEnabled &&
        projection.show.displayMode !== "EMERGENCY" &&
        !projection.runtime.blackScreen && (
          <ReactionLane
            eventKey={
              reactionSignal
                ? `${reactionSignal.revision}:${JSON.stringify(reactionSignal.histogram)}`
                : null
            }
            histogram={reactionSignal?.histogram ?? null}
            clearKey={reactionClear?.commandId ?? null}
          />
        )}
      {!media.armed && !enteredShow && (
        // Browsers only unlock sound from a gesture made in *this* browser, so
        // the gate has to be pressed on the display itself. It covers the
        // output until it is, which is also how the operator knows to do it.
        <div className="projector-gate" role="group" aria-label="Enable audio">
          <div className="projector-gate__card">
            <p className="projector-gate__kicker">{PLATFORM_NAME}</p>
            <h2 className="projector-gate__title">This display is paired</h2>
            <p className="projector-gate__detail">
              Press this once, here on the projector machine, to unlock sound
              for the whole show.
            </p>
            <button
              className="projector-gate__enter"
              type="button"
              onClick={() => void enableAudioAndEnter()}
            >
              ENABLE AUDIO &amp; ENTER SHOW
            </button>
            <button
              className="projector-gate__skip"
              type="button"
              onClick={() => setEnteredShow(true)}
            >
              Continue without audio
            </button>
            {armError && (
              <p className="projector-gate__error" role="alert">
                {armError}
              </p>
            )}
          </div>
        </div>
      )}
      {!media.armed && enteredShow && (
        // Entered without sound: small, out of the hall's way, still fixable.
        <button
          className="projector-arm"
          type="button"
          onClick={() => void enableAudioAndEnter()}
        >
          AUDIO NOT ARMED — ENABLE
        </button>
      )}
      {degraded && !blackout && (
        <i className="projector-link" aria-hidden="true" />
      )}
      {diagnostics && !blackout && (
        <output className="projector-diagnostics">
          <span>link {connection.toLowerCase()}</span>
          <span>rev {revision ?? "—"}</span>
          <span>mode {projection?.show.displayMode ?? "—"}</span>
          <span>layer {scene.layer.kind.toLowerCase()}</span>
          <span>
            visual {media.visual.toLowerCase()} · audio{" "}
            {media.audio.toLowerCase()}
          </span>
          <span>
            {media.armed ? "armed" : "not armed"} ·{" "}
            {media.hasFrame ? "frame" : "no frame"}
          </span>
          {media.error && (
            <span className="projector-diagnostics__error">{media.error}</span>
          )}
          {cache && (
            <span>
              cache {cache.cached}/{cache.files} ·{" "}
              {Math.round(cache.cachedBytes / 1_048_576)}/
              {Math.round(cache.bytes / 1_048_576)} MB
              {cache.persisted === true ? " · persisted" : ""}
            </span>
          )}
          {cache?.error && (
            <span className="projector-diagnostics__error">{cache.error}</span>
          )}
          <span>press D to hide</span>
        </output>
      )}
    </main>
  );
}

function Base({
  base,
  judges,
  aggregate,
  revealedResult,
  mediaFrameReady,
}: {
  base: ProjectorBase;
  judges: Parameters<typeof ScoreboardGraphic>[0]["judges"];
  aggregate: Parameters<typeof ScoreboardGraphic>[0]["aggregate"];
  revealedResult: number | null;
  mediaFrameReady: boolean;
}) {
  switch (base.kind) {
    case "CONNECTING":
      return (
        <HoldingGraphic
          kicker={PLATFORM_NAME}
          headline={base.unauthorised ? "Display not authorised" : "Connecting"}
        />
      );
    case "BLACKOUT":
      // The blackout layer is the entire output; there is no base beneath it.
      return null;
    case "LOBBY":
      return (
        <LobbyGraphic
          title={base.title}
          tagline={base.tagline}
          joinUrl={base.joinUrl}
        />
      );
    case "ACT_CARD":
      return <ActCardGraphic act={base.act} />;
    case "STAND_BY":
      return <HoldingGraphic kicker="Up next" headline="Stand by" />;
    case "PERFORMANCE":
      // With no custom visual commanded — or with one that failed to produce a
      // frame — the act's own performance screen is the output. A custom visual
      // that is genuinely on screen owns the whole frame.
      return (base.automatic || !mediaFrameReady) && base.act ? (
        <PerformanceGraphic act={base.act} />
      ) : (
        <div className="stage stage--empty" />
      );
    case "SCOREBOARD":
      return (
        <ScoreboardGraphic
          act={base.act}
          judges={judges}
          aggregate={aggregate}
          revealedResult={revealedResult}
        />
      );
    case "INTERMISSION":
      return <IntermissionGraphic message={base.message} />;
    case "HOLD":
      return <HoldGraphic />;
    case "EMERGENCY":
      return (
        <EmergencyGraphic
          presentation={base.presentation}
          message={base.message}
        />
      );
    case "FINAL_RESULTS":
      return <FinalResultsGraphic title={base.title} results={base.results} />;
  }
}
