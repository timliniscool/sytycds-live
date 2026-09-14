import { useEffect, useRef, useState } from "react";

import type { PersistedCue } from "../../shared/domain";
import { PROTOCOL_VERSION } from "../../shared/domain";
import type { MediaCommandMessage } from "../../shared/protocol";
import {
  ProjectorMediaEngine,
  type ProjectorMediaStatus,
} from "../projector/MediaEngine";
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
function cueFor(
  command: MediaCommandMessage,
  cues: readonly PersistedCue[],
): PersistedCue | null {
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

  return (
    <main className="projector" aria-label="SYTYCDS projector">
      <div
        className={`projector-media${media.black ? " projector-media--black" : ""}`}
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
      <div
        className="projector-fallback"
        hidden={media.black || Boolean(projection?.runtime.activeVisualCueId)}
      >
        <p>SO YOU THINK YOU CAN DO STUFF</p>
        <h1>{projection?.activeAct?.actName ?? "Live presentation"}</h1>
      </div>
      <output className="projector-status">
        {connection} · visual {media.visual.toLowerCase()} · audio{" "}
        {media.audio.toLowerCase()}
        {media.error ? ` · ${media.error}` : ""}
      </output>
    </main>
  );
}
