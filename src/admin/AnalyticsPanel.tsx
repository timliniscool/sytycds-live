import { useState } from "react";

/**
 * On-demand diagnostics from `GET /api/admin/diagnostics`. Nothing here polls:
 * the operator asks, the coordinator answers with what it knows right now, and
 * storage is re-listed from R2 only when explicitly refreshed (it is otherwise
 * cached on the server for 45 s).
 */
interface Diagnostics {
  realtime: {
    sampledAt: string;
    presence: {
      audience: number;
      judgeIds: readonly string[];
      projectors: number;
      projectorPaired: boolean;
      projectorArmed: boolean | null;
    };
    show: {
      displayMode: string;
      audienceVoteState: string;
      activeActId: string | null;
      revision: number;
      flow: {
        step: string | null;
        next: string | null;
        blocked: string | null;
      };
    } | null;
    votes: { currentAct: number; total: number };
    projectorMedia: {
      visual: string;
      audio: string;
      positionMs: number | null;
      durationMs: number | null;
      armed: boolean;
      black: boolean;
      error: string | null;
      cache?: {
        cached: number;
        files: number;
        cachedBytes: number;
        bytes: number;
      };
    } | null;
    recentFailures: readonly {
      id: number;
      type: string;
      at: string;
      detail: string;
    }[];
    counters: {
      startedAt: string;
      hellos: {
        admin: number;
        projector: number;
        audience: number;
        judge: number;
      };
      refusedHellos: number;
      resyncRequests: number;
      protocolErrors: number;
      socketErrors: number;
    };
  };
  infrastructure: {
    sampledAt: string;
    r2: {
      showObjects: number;
      showBytes: number;
      testObjects: number;
      testBytes: number;
      fontObjects: number;
      fontBytes: number;
      listingTruncated: boolean;
      error: string | null;
    };
    database: { sizeBytes: number | null; schemaVersion: number };
    pendingMediaCleanup: number;
  } | null;
  infrastructureCacheTtlMs: number;
}

function megabytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}

export function AnalyticsPanel() {
  const [data, setData] = useState<Diagnostics | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(refresh: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/admin/diagnostics${refresh ? "?refresh=1" : ""}`,
        { credentials: "same-origin" },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(body?.error ?? `Request failed (HTTP ${response.status})`);
        return;
      }
      setData((await response.json()) as Diagnostics);
    } catch {
      setError("The coordinator could not be reached.");
    } finally {
      setBusy(false);
    }
  }

  const realtime = data?.realtime;
  const infra = data?.infrastructure;
  const r2 = infra?.r2;
  const totalBytes = r2 ? r2.showBytes + r2.testBytes + r2.fontBytes : null;

  return (
    <details className="analytics">
      <summary>
        <span>
          <p>ANALYTICS</p>
          <h2>Live load and storage</h2>
        </span>
        <small>
          {data
            ? `Sampled ${clock(realtime!.sampledAt)}`
            : "Requested on demand — nothing is polled"}
        </small>
      </summary>
      <div className="analytics__body">
        <div className="analytics__actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => void load(false)}
          >
            {busy ? "REQUESTING…" : data ? "REFRESH" : "REQUEST ANALYTICS"}
          </button>
          <button
            type="button"
            disabled={busy}
            title="Re-list storage from R2 now instead of using the 45 s cache"
            onClick={() => void load(true)}
          >
            RE-LIST STORAGE
          </button>
          {error && (
            <p className="analytics__error" role="alert">
              {error}
            </p>
          )}
        </div>

        {realtime && (
          <>
            <div className="analytics__grid">
              <span>
                <small>Audience phones</small>
                <b>{realtime.presence.audience}</b>
              </span>
              <span>
                <small>Judges connected</small>
                <b>{realtime.presence.judgeIds.length}</b>
              </span>
              <span>
                <small>Projector</small>
                <b>
                  {realtime.presence.projectors > 0
                    ? `${realtime.presence.projectors} connected`
                    : realtime.presence.projectorPaired
                      ? "paired, offline"
                      : "not paired"}
                </b>
                <em>
                  {realtime.presence.projectorArmed === null
                    ? "audio unknown"
                    : realtime.presence.projectorArmed
                      ? "audio armed"
                      : "audio not armed"}
                </em>
              </span>
              <span>
                <small>Votes</small>
                <b>{realtime.votes.currentAct}</b>
                <em>{realtime.votes.total} this show</em>
              </span>
              <span>
                <small>Revision</small>
                <b>{realtime.show?.revision ?? "—"}</b>
                <em>
                  {realtime.show
                    ? `${realtime.show.displayMode.replaceAll("_", " ")} · voting ${realtime.show.audienceVoteState}`
                    : ""}
                </em>
              </span>
              <span>
                <small>Sockets since start</small>
                <b>
                  {realtime.counters.hellos.admin +
                    realtime.counters.hellos.projector +
                    realtime.counters.hellos.audience +
                    realtime.counters.hellos.judge}
                </b>
                <em>
                  {realtime.counters.hellos.audience} audience ·{" "}
                  {realtime.counters.hellos.judge} judge ·{" "}
                  {realtime.counters.hellos.admin} admin ·{" "}
                  {realtime.counters.hellos.projector} projector
                </em>
              </span>
              <span>
                <small>Refused · resyncs · errors</small>
                <b>
                  {realtime.counters.refusedHellos} ·{" "}
                  {realtime.counters.resyncRequests} ·{" "}
                  {realtime.counters.protocolErrors +
                    realtime.counters.socketErrors}
                </b>
                <em>since {clock(realtime.counters.startedAt)}</em>
              </span>
              <span>
                <small>Projector media</small>
                <b>
                  {realtime.projectorMedia
                    ? `${realtime.projectorMedia.visual.toLowerCase()} / ${realtime.projectorMedia.audio.toLowerCase()}`
                    : "no telemetry"}
                </b>
                <em>
                  {realtime.projectorMedia?.cache
                    ? `cache ${realtime.projectorMedia.cache.cached}/${realtime.projectorMedia.cache.files} · ${megabytes(realtime.projectorMedia.cache.cachedBytes)}`
                    : (realtime.projectorMedia?.error ?? "")}
                </em>
              </span>
            </div>

            <div className="analytics__grid analytics__grid--storage">
              <span>
                <small>R2 storage</small>
                <b>{megabytes(totalBytes)}</b>
                <em>
                  {r2
                    ? `${r2.showObjects} show · ${r2.testObjects} test · ${r2.fontObjects} font objects${r2.listingTruncated ? " (listing truncated)" : ""}`
                    : "not sampled"}
                </em>
              </span>
              <span>
                <small>Show media</small>
                <b>{megabytes(r2?.showBytes)}</b>
              </span>
              <span>
                <small>Test fixtures</small>
                <b>{megabytes(r2?.testBytes)}</b>
              </span>
              <span>
                <small>Cached typefaces</small>
                <b>{megabytes(r2?.fontBytes)}</b>
              </span>
              <span>
                <small>Database</small>
                <b>{megabytes(infra?.database.sizeBytes)}</b>
                <em>
                  schema v{infra?.database.schemaVersion ?? "—"} ·{" "}
                  {infra?.pendingMediaCleanup ?? 0} pending cleanup
                </em>
              </span>
              <span>
                <small>Storage sampled</small>
                <b>{infra ? clock(infra.sampledAt) : "—"}</b>
                <em>{r2?.error ? `R2: ${r2.error}` : ""}</em>
              </span>
            </div>

            {realtime.recentFailures.length > 0 && (
              <div className="analytics__failures">
                <small>Recent refusals and media errors</small>
                <ul>
                  {realtime.recentFailures.map((failure) => (
                    <li key={failure.id}>
                      <b>{failure.type}</b> <em>{clock(failure.at)}</em>
                      <span>{failure.detail}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </details>
  );
}
