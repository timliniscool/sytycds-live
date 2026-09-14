import { useEffect, useRef, useState } from "react";

import type {
  ProjectorCue,
  ProjectorShowProjection,
} from "../../shared/domain";
import { PROTOCOL_VERSION } from "../../shared/domain";
import type { MediaCommandMessage } from "../../shared/protocol";
import {
  ProjectorMediaEngine,
  type ProjectorMediaStatus,
} from "../projector/MediaEngine";
import {
  ActCardGraphic,
  HoldingGraphic,
  LobbyGraphic,
} from "../projector/ProjectorGraphics";
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
};

/** Sampling rate for the operator's transport readout. */
const TELEMETRY_INTERVAL_MS = 500;
/** Repeat interval for unchanged telemetry, so a reloaded console recovers. */
const TELEMETRY_HEARTBEAT_MS = 5_000;

function cueFor(
  command: MediaCommandMessage,
  cues: readonly ProjectorCue[],
): ProjectorCue | null {
  return command.cueId
    ? (cues.find((cue) => cue.id === command.cueId) ?? null)
    : null;
}

export default function ProjectorSurface() {
  const [media, setMedia] = useState(INITIAL_MEDIA);
  const clientRef = useRef<RealtimeClient | null>(null);
  const engineRef = useRef<ProjectorMediaEngine | null>(null);
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
  const connection = useRealtimeSelector(client, (state) => state.connection);

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

  useEffect(() => {
    if (command && projection)
      void engineRef.current?.execute(
        command,
        cueFor(command, projection.activeCues),
      );
  }, [command, projection]);

  // Playback position exists only in this browser's media elements. It is
  // sampled and forwarded when it changes, so the operator can see the
  // transport without the projector ever re-rendering for it.
  useEffect(() => {
    let previous = "";
    let sentAt = 0;
    const timer = setInterval(() => {
      const engine = engineRef.current;
      if (!engine) return;
      const status = engine.telemetry();
      const encoded = JSON.stringify(status);
      const now = Date.now();
      // Unchanged telemetry still repeats slowly: an operator who reloads the
      // console mid-show must not sit in front of an empty transport readout.
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

  const blacked = media.black || projection?.runtime.blackScreen === true;
  const visualCueActive = Boolean(projection?.runtime.activeVisualCueId);
  const degraded = connection !== "LIVE";

  return (
    <main className="projector" aria-label="SYTYCDS projector">
      {!visualCueActive && !blacked && (
        <Graphics projection={projection} connection={connection} />
      )}
      <div
        className={`projector-media${blacked ? " projector-media--black" : ""}`}
        ref={hostRef}
      />
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
      {(degraded || media.error) && (
        <output className="projector-status">
          {degraded ? connection : ""}
          {media.error ? ` · ${media.error}` : ""}
        </output>
      )}
    </main>
  );
}

function Graphics({
  projection,
  connection,
}: {
  projection: ProjectorShowProjection | null;
  connection: string;
}) {
  if (!projection) {
    return (
      <HoldingGraphic
        kicker="SYTYCDS"
        headline={
          connection === "UNAUTHORISED"
            ? "Display not authorised"
            : "Connecting"
        }
      />
    );
  }

  switch (projection.show.displayMode) {
    case "LOBBY":
      return (
        <LobbyGraphic
          title={projection.show.title}
          tagline={projection.show.tagline}
          joinUrl={`${window.location.origin}/vote`}
        />
      );
    case "ACT_CARD":
      return projection.activeAct ? (
        <ActCardGraphic act={projection.activeAct} />
      ) : (
        <HoldingGraphic kicker="Up next" headline="Stand by" />
      );
    case "PERFORMANCE":
      // The performance belongs to the stage, not to the screen.
      return <div className="stage stage--empty" />;
    case "INTERMISSION":
      return <HoldingGraphic kicker="Back shortly" headline="Intermission" />;
    case "HOLD":
      return <HoldingGraphic kicker="One moment" headline="Please stand by" />;
    case "EMERGENCY":
      return (
        <HoldingGraphic
          kicker="Please follow staff instructions"
          headline="Stop"
        />
      );
    case "SCOREBOARD":
      return (
        <HoldingGraphic
          kicker="Scores"
          headline={projection.activeAct?.actName ?? "Scoring"}
        />
      );
    case "FINAL_RESULTS":
      return <HoldingGraphic kicker="Tonight" headline="Final results" />;
  }
}
