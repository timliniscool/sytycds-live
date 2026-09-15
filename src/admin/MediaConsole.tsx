import { useCallback, useEffect, useRef, useState } from "react";

import type { AdminCommandType } from "../../shared/admin-command";
import type {
  AdminAct,
  DisplayMode,
  ShowRuntimeState,
} from "../../shared/domain";
import type {
  CommandAcknowledgementMessage,
  ProjectorAcknowledgementMessage,
} from "../../shared/protocol";
import {
  useRealtimeSelector,
  type RealtimeClient,
} from "../realtime/RealtimeClient";

export interface MediaConsoleProps {
  act: AdminAct | null;
  runtime: ShowRuntimeState;
  displayMode: DisplayMode;
  /** Telemetry ticks every half second; only this console re-renders for it. */
  client: RealtimeClient;
  projectorAcknowledgement: ProjectorAcknowledgementMessage | null;
  commandAcknowledgement: CommandAcknowledgementMessage | null;
  send(type: AdminCommandType, extras?: Record<string, unknown>): string | null;
}

/** A command that has left the console but has not been acknowledged yet. */
interface PendingCommand {
  id: string;
  type: AdminCommandType;
}

const PENDING_TIMEOUT_MS = 4_000;

function megabytes(bytes: number): string {
  return (bytes / 1_048_576).toFixed(bytes < 10 * 1_048_576 ? 1 : 0);
}

function clock(milliseconds: number | null): string {
  if (milliseconds === null) return "--:--";
  const total = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

/** Modes whose own graphics are the public output; the visual layer stays hidden. */
const VISUAL_LAYER_HIDDEN: ReadonlySet<DisplayMode> = new Set([
  "HOLD",
  "EMERGENCY",
  "SCOREBOARD",
  "FINAL_RESULTS",
]);

export function MediaConsole({
  act,
  runtime,
  displayMode,
  client,
  projectorAcknowledgement,
  commandAcknowledgement,
  send,
}: MediaConsoleProps) {
  const telemetry = useRealtimeSelector(
    client,
    (state) => state.projectorTelemetry,
  );
  const cues = act?.cues ?? [];
  const [selectedCueId, setSelectedCueId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingCommand | null>(null);
  const [seekMs, setSeekMs] = useState<number | null>(null);
  // The gate has to close on the click itself. React state is not visible until
  // the next render, and two clicks can land inside one of those.
  const pendingRef = useRef<PendingCommand | null>(null);

  const clearPending = useCallback(() => {
    pendingRef.current = null;
    setPending(null);
  }, []);

  // Selection follows the act, then the coordinator's prepared cue, so the
  // console never points at a cue belonging to a different performance.
  useEffect(() => {
    setSelectedCueId(null);
  }, [act?.id]);

  useEffect(() => {
    if (
      pending &&
      commandAcknowledgement?.acknowledgement.commandId === pending.id
    ) {
      clearPending();
    }
  }, [commandAcknowledgement, pending, clearPending]);

  // A lost acknowledgement must not leave the transport permanently disabled.
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(clearPending, PENDING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [pending, clearPending]);

  const selected =
    cues.find((cue) => cue.id === selectedCueId) ??
    cues.find((cue) => cue.id === runtime.preparedCueId) ??
    cues[0] ??
    null;

  /** One in-flight media command at a time: a double click cannot fire twice. */
  function run(type: AdminCommandType, extras?: Record<string, unknown>): void {
    if (pendingRef.current) return;
    const id = send(type, extras);
    if (!id) return;
    pendingRef.current = { id, type };
    setPending(pendingRef.current);
  }

  const busy = pending !== null;
  const failedAcknowledgement =
    projectorAcknowledgement && !projectorAcknowledgement.succeeded
      ? projectorAcknowledgement
      : null;
  const duration = telemetry?.durationMs ?? null;
  const position = seekMs ?? telemetry?.positionMs ?? null;

  return (
    <section className="media-console" aria-label="Media and cue control">
      <div className="media-console__head">
        <p>MEDIA / CUE STACK</p>
        <h2>{act ? act.actName : "No act selected"}</h2>
        <span>
          {cues.length} cue{cues.length === 1 ? "" : "s"} · visual{" "}
          {runtime.visualTransport} · audio {runtime.audioTransport}
          {runtime.blackScreen ? " · BLACK" : ""}
        </span>
      </div>

      {failedAcknowledgement && (
        <p className="media-console__alarm" role="alert">
          PROJECTOR DID NOT EXECUTE
          {failedAcknowledgement.detail
            ? `: ${failedAcknowledgement.detail}`
            : ""}
        </p>
      )}
      {telemetry?.error && (
        <p className="media-console__alarm" role="alert">
          PROJECTOR MEDIA ERROR: {telemetry.error}
        </p>
      )}
      {telemetry && !telemetry.armed && (
        <p className="media-console__warn">
          Projector audio is not armed. Press ARM SHOW on the projector.
        </p>
      )}
      {telemetry?.held && (
        <p className="media-console__warn">
          Projector reloaded during playback: media is held. Press RESUME to
          continue or REPLAY to restart the backing track.
        </p>
      )}
      {telemetry?.cache?.error && (
        <p className="media-console__alarm" role="alert">
          PROJECTOR MEDIA CACHE: {telemetry.cache.error}
        </p>
      )}
      {runtime.activeVisualCueId && VISUAL_LAYER_HIDDEN.has(displayMode) && (
        <p className="media-console__warn">
          The visual layer is hidden while the projector shows{" "}
          {displayMode.replaceAll("_", " ")}; audio continues.
        </p>
      )}

      <ol className="cue-stack">
        {cues.length === 0 && (
          <li className="cue-stack__empty">
            This act has no cues. The projector stays on its display graphics.
          </li>
        )}
        {cues.map((cue) => {
          const prepared = cue.id === runtime.preparedCueId;
          const onAirVisual = cue.id === runtime.activeVisualCueId;
          const onAirAudio = cue.id === runtime.activeAudioCueId;
          return (
            <li key={cue.id}>
              <button
                type="button"
                className={`cue-row${selected?.id === cue.id ? " cue-row--selected" : ""}${
                  onAirVisual || onAirAudio ? " cue-row--live" : ""
                }`}
                aria-current={selected?.id === cue.id}
                onClick={() => setSelectedCueId(cue.id)}
              >
                <span className="cue-row__position">
                  {String(cue.position + 1).padStart(2, "0")}
                </span>
                <span className="cue-row__label">
                  <b>{cue.operatorLabel || "Untitled cue"}</b>
                  <small>
                    {cue.operations
                      .map((operation) =>
                        operation.kind === "visual"
                          ? operation.visual.kind
                          : operation.kind === "audio"
                            ? `AUDIO ${operation.action}`
                            : `WAIT ${clock(operation.durationMs)}`,
                      )
                      .join(" · ") || "legacy cue"}
                    {cue.durationMs !== null
                      ? ` · ${clock(cue.durationMs)}`
                      : ""}
                  </small>
                </span>
                <span className="cue-row__flags">
                  {prepared && <em className="flag flag--prepared">PREP</em>}
                  {onAirVisual && <em className="flag flag--live">VIS</em>}
                  {onAirAudio && <em className="flag flag--live">AUD</em>}
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      <div className="media-readout">
        <span>
          <small>Selected</small>
          <b>{selected ? selected.operatorLabel || "Untitled cue" : "—"}</b>
        </span>
        <span>
          <small>Prepared</small>
          <b>
            {cues.find((cue) => cue.id === runtime.preparedCueId)
              ?.operatorLabel ?? "—"}
          </b>
        </span>
        <span>
          <small>Executing</small>
          <b>
            {cues.find(
              (cue) =>
                cue.id === runtime.activeVisualCueId ||
                cue.id === runtime.activeAudioCueId,
            )?.operatorLabel ?? "—"}
          </b>
        </span>
        <span>
          <small>Projector</small>
          <b>
            {telemetry
              ? `${telemetry.visual.toLowerCase()} / ${telemetry.audio.toLowerCase()}`
              : "no telemetry"}
          </b>
        </span>
        <span>
          <small>Time</small>
          <b>
            {clock(position)} / {clock(duration)}
          </b>
        </span>
        <span>
          <small>Media cache</small>
          <b>
            {telemetry?.cache
              ? `${telemetry.cache.cached}/${telemetry.cache.files} · ${megabytes(telemetry.cache.cachedBytes)}/${megabytes(telemetry.cache.bytes)} MB${telemetry.cache.persisted === true ? " · protected" : ""}`
              : "—"}
          </b>
        </span>
      </div>

      {duration !== null && duration > 0 && (
        <div className="media-seek">
          <input
            type="range"
            aria-label="Seek media position"
            min={0}
            max={duration}
            step={1000}
            value={position ?? 0}
            onChange={(event) => setSeekMs(Number(event.target.value))}
            onPointerUp={() => {
              if (seekMs !== null) run("SEEK_MEDIA", { positionMs: seekMs });
              setSeekMs(null);
            }}
            onKeyUp={() => {
              if (seekMs !== null) run("SEEK_MEDIA", { positionMs: seekMs });
              setSeekMs(null);
            }}
          />
        </div>
      )}

      <div className="media-go">
        <button
          type="button"
          className="media-go__button"
          disabled={!selected || busy}
          onClick={() =>
            run("PLAY_CUE", selected ? { cueId: selected.id } : {})
          }
        >
          GO
          <small>
            {selected ? selected.operatorLabel || "Untitled cue" : "no cue"}
          </small>
        </button>
      </div>

      <div className="media-transport">
        <button
          type="button"
          disabled={!selected || busy}
          onClick={() =>
            run("PREPARE_CUE", selected ? { cueId: selected.id } : {})
          }
        >
          PREPARE
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => run("PAUSE_MEDIA")}
        >
          PAUSE
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => run("RESUME_MEDIA")}
        >
          RESUME
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => run("RESTART_MEDIA")}
        >
          RESTART
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => run("PREVIOUS_CUE")}
        >
          ◀ PREV CUE
        </button>
        <button type="button" disabled={busy} onClick={() => run("NEXT_CUE")}>
          NEXT CUE ▶
        </button>
      </div>

      <div className="media-emergency">
        <p>EMERGENCY</p>
        <button
          type="button"
          className="media-emergency__replay"
          disabled={busy}
          onClick={() => run("REPLAY_MEDIA")}
        >
          REPLAY BACKING AUDIO
        </button>
        <button
          type="button"
          className={runtime.blackScreen ? "is-active" : ""}
          disabled={busy}
          onClick={() => run("BLACK_SCREEN")}
        >
          {runtime.blackScreen ? "UNBLACK SCREEN" : "BLACK SCREEN"}
        </button>
        <button
          type="button"
          className="media-emergency__stop"
          disabled={busy}
          onClick={() => run("STOP_MEDIA")}
        >
          STOP VISUAL
        </button>
        <button
          type="button"
          className="media-emergency__stop-all"
          disabled={busy}
          onClick={() => run("STOP_ALL_MEDIA")}
        >
          STOP ALL MEDIA
        </button>
      </div>

      <p className="media-console__pending" aria-live="polite">
        {pending
          ? `Waiting for ${pending.type.replaceAll("_", " ").toLowerCase()}…`
          : projectorAcknowledgement?.succeeded
            ? `Projector acknowledged ${projectorAcknowledgement.detail ?? "command"}`
            : "Transport idle"}
      </p>
    </section>
  );
}
