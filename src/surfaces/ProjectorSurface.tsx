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
  const [media, setMedia] = useState(INITIAL_MEDIA);
  const [cache, setCache] = useState<MediaCacheSummary | null>(null);
  const [diagnostics, setDiagnostics] = useState(false);
  const clientRef = useRef<RealtimeClient | null>(null);
  const engineRef = useRef<ProjectorMediaEngine | null>(null);
  const cacheRef = useRef<MediaCache | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  if (!clientRef.current)
    clientRef.current = new RealtimeClient({
      url: showWebSocketUrl(window.location),
      hello: {
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        requestedRole: "projector",
        credential: token,
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

  useEffect(() => {
    client.connect();
    return () => client.destroy();
  }, [client]);

  useEffect(() => {
    const engine = new ProjectorMediaEngine({
      onStatus: setMedia,
      onAcknowledgement: (executionId, succeeded, detail) =>
        client.send({
          type: "projector_ack",
          protocolVersion: PROTOCOL_VERSION,
          commandId: executionId as MediaCommandMessage["executionId"],
          succeeded,
          detail,
        }),
    });
    engineRef.current = engine;
    if (hostRef.current) engine.attach(hostRef.current);
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, [client]);

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
    if (command && runtime && cues)
      void engineRef.current?.execute(command, runtime, cues);
  }, [command, runtime, cues]);

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
  const degraded = connection !== "LIVE";
  const aggregate = projection?.activeAct
    ? (aggregates.get(projection.activeAct.id) ??
      projection.scoreboard.audience)
    : null;

  return (
    <main className="projector" aria-label="SYTYCDS projector">
      <Base
        base={scene.base}
        judges={projection?.scoreboard.judges ?? []}
        aggregate={aggregate}
        revealedResult={projection?.revealedResult ?? null}
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
      {scene.layer.kind === "BLACK" && <div className="projector-black" />}
      {!media.armed && (
        <>
          <button
            className="projector-arm"
            type="button"
            onClick={() => void engineRef.current?.arm()}
          >
            ARM SHOW / ENABLE AUDIO
          </button>
          <p className="projector-arm__help">
            A projector operator must enable sound once after opening this page.
          </p>
        </>
      )}
      {degraded && <i className="projector-link" aria-hidden="true" />}
      {diagnostics && (
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
}: {
  base: ProjectorBase;
  judges: Parameters<typeof ScoreboardGraphic>[0]["judges"];
  aggregate: Parameters<typeof ScoreboardGraphic>[0]["aggregate"];
  revealedResult: number | null;
}) {
  switch (base.kind) {
    case "CONNECTING":
      return (
        <HoldingGraphic
          kicker="SYTYCDS"
          headline={base.unauthorised ? "Display not authorised" : "Connecting"}
        />
      );
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
    case "STAGE":
      // The performance belongs to the stage; the screen carries only what
      // the visual channel commands, over black.
      return <div className="stage stage--empty" />;
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
