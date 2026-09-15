import { useEffect, useRef, useState } from "react";

import { commandId, PROTOCOL_VERSION } from "../../shared/domain";
import {
  overallReadiness,
  type PreflightGroup,
  type PreflightItem,
  type ProjectorPreflightReport,
} from "../../shared/preflight";
import type { RealtimeClient } from "../realtime/RealtimeClient";

export interface PreflightPanelProps {
  client: RealtimeClient;
}

const PROJECTOR_TIMEOUT_MS = 45_000;
const RESYNC_TIMEOUT_MS = 4_000;

function pending(
  id: string,
  label: string,
  group: PreflightGroup,
  required = true,
): PreflightItem {
  return { id, label, status: "PENDING", detail: "Running…", required, group };
}

function result(
  id: string,
  label: string,
  group: PreflightGroup,
  status: PreflightItem["status"],
  detail: string,
  required = true,
): PreflightItem {
  return { id, label, status, detail, required, group };
}

const BROWSER_PENDING: PreflightItem[] = [
  pending("worker", "Worker reachable", "browser"),
  pending("coordinator", "Coordinator reachable", "browser"),
  pending("admin_session", "Operator session", "browser"),
];
const REALTIME_PENDING: PreflightItem[] = [
  pending("realtime", "Realtime reconnect", "realtime"),
];
const PROJECTOR_PENDING: PreflightItem[] = [
  pending("projector_report", "Projector self-test", "projector"),
  pending("projector_armed", "Projector audio armed", "projector"),
  pending("media_engine", "Projector media engine", "projector"),
  pending("cache_storage", "Projector CacheStorage", "projector", false),
  pending("media_cache", "Media cache progress", "projector"),
  pending("audio_metadata", "Audio metadata", "projector"),
  pending("video_metadata", "Video metadata", "projector"),
];

async function browserChecks(): Promise<PreflightItem[]> {
  const items: PreflightItem[] = [];
  try {
    const started = performance.now();
    const response = await fetch("/api/health", { credentials: "same-origin" });
    const elapsed = Math.round(performance.now() - started);
    const body = response.ok
      ? ((await response.json()) as {
          ok: boolean;
          coordinator?: { ok: boolean; schemaVersion: number };
        })
      : null;
    items.push(
      response.ok
        ? result(
            "worker",
            "Worker reachable",
            "browser",
            "READY",
            `${elapsed} ms`,
          )
        : result(
            "worker",
            "Worker reachable",
            "browser",
            "FAILURE",
            `HTTP ${response.status} from /api/health. Check the deployment.`,
          ),
    );
    items.push(
      body?.coordinator?.ok
        ? result(
            "coordinator",
            "Coordinator reachable",
            "browser",
            "READY",
            `Durable Object answered; schema ${body.coordinator.schemaVersion}`,
          )
        : result(
            "coordinator",
            "Coordinator reachable",
            "browser",
            "FAILURE",
            "The show coordinator did not answer. Check the Durable Object binding.",
          ),
    );
  } catch {
    items.push(
      result(
        "worker",
        "Worker reachable",
        "browser",
        "FAILURE",
        "No response from the Worker. Check network and deployment.",
      ),
      result(
        "coordinator",
        "Coordinator reachable",
        "browser",
        "FAILURE",
        "Cannot reach the coordinator while the Worker is unreachable.",
      ),
    );
  }
  try {
    const response = await fetch("/api/admin/session", {
      credentials: "same-origin",
    });
    const body = response.ok
      ? ((await response.json()) as { authenticated: boolean })
      : null;
    items.push(
      body?.authenticated
        ? result(
            "admin_session",
            "Operator session",
            "browser",
            "READY",
            "Signed in",
          )
        : result(
            "admin_session",
            "Operator session",
            "browser",
            "FAILURE",
            "This console is not signed in. Reload and sign in again.",
          ),
    );
  } catch {
    items.push(
      result(
        "admin_session",
        "Operator session",
        "browser",
        "FAILURE",
        "Could not verify the operator session.",
      ),
    );
  }
  return items;
}

/** Sends a resync request and times the snapshot that comes back. */
function realtimeCheck(client: RealtimeClient): Promise<PreflightItem[]> {
  return new Promise((resolve) => {
    const before = client.getState().projection;
    const started = performance.now();
    let settled = false;
    const finish = (item: PreflightItem) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      clearTimeout(timer);
      resolve([item]);
    };
    const unsubscribe = client.subscribeSelector(
      (state) => state.projection,
      () => {
        if (client.getState().projection !== before) {
          finish(
            result(
              "realtime",
              "Realtime reconnect",
              "realtime",
              "READY",
              `Snapshot returned in ${Math.round(performance.now() - started)} ms`,
            ),
          );
        }
      },
    );
    const timer = setTimeout(
      () =>
        finish(
          result(
            "realtime",
            "Realtime reconnect",
            "realtime",
            "FAILURE",
            "No snapshot within 4 s of a resync request. The control link is not healthy.",
          ),
        ),
      RESYNC_TIMEOUT_MS,
    );
    if (client.getState().connection !== "LIVE") {
      finish(
        result(
          "realtime",
          "Realtime reconnect",
          "realtime",
          "FAILURE",
          `Control link is ${client.getState().connection}.`,
        ),
      );
      return;
    }
    client.requestResync();
  });
}

function projectorItems(report: ProjectorPreflightReport): PreflightItem[] {
  const audio = report.assets.filter((asset) => asset.kind === "audio");
  const video = report.assets.filter((asset) => asset.kind === "video");
  const failed = report.assets.filter((asset) => !asset.ok);
  const list = (assets: typeof failed) =>
    assets
      .slice(0, 4)
      .map((asset) => `${asset.id.slice(0, 14)}… ${asset.detail}`)
      .join("; ");
  return [
    result(
      "projector_report",
      "Projector self-test",
      "projector",
      report.protocolVersion === PROTOCOL_VERSION ? "READY" : "FAILURE",
      report.protocolVersion === PROTOCOL_VERSION
        ? `Answered on protocol ${report.protocolVersion}`
        : `Projector protocol ${report.protocolVersion} differs from ${PROTOCOL_VERSION}. Reload the projector.`,
    ),
    result(
      "projector_armed",
      "AUDIO",
      "projector",
      report.armed ? "READY" : "FAILURE",
      report.armed
        ? "ARMED — sound is unlocked on the projector"
        : // Only a gesture in the projector's own browser can unlock audio;
          // nothing the operator clicks here will ever do it.
          "NOT ARMED — go to the projector machine and press ENABLE AUDIO & ENTER SHOW on its screen. This cannot be done from the console.",
    ),
    result(
      "media_engine",
      "Projector media engine",
      "projector",
      report.engineReady ? "READY" : "FAILURE",
      report.engineReady
        ? "Media host attached"
        : "The projector page has no media host. Reload the projector.",
    ),
    result(
      "cache_storage",
      "Projector CacheStorage",
      "projector",
      report.cacheStorage ? "READY" : "WARNING",
      report.cacheStorage
        ? "Available"
        : "Not available in this browser; the HTTP cache alone will carry media.",
      false,
    ),
    report.cache
      ? result(
          "media_cache",
          "Media cache progress",
          "projector",
          report.cache.error
            ? "FAILURE"
            : report.cache.files === 0
              ? "WARNING"
              : report.cache.cached === report.cache.files
                ? "READY"
                : "FAILURE",
          report.cache.error ??
            (report.cache.files === 0
              ? "No cue references any media."
              : `${report.cache.cached}/${report.cache.files} files (${Math.round(report.cache.cachedBytes / 1_048_576)}/${Math.round(report.cache.bytes / 1_048_576)} MB) stored on the projector${report.cache.persisted === true ? "; storage is protected from eviction" : report.cache.persisted === false ? "; browser declined persistent storage" : ""}`),
        )
      : result(
          "media_cache",
          "Media cache progress",
          "projector",
          report.assets.length === 0
            ? "WARNING"
            : failed.length === 0
              ? "READY"
              : "FAILURE",
          report.assets.length === 0
            ? "No cue references any media."
            : failed.length === 0
              ? `${report.assets.length}/${report.assets.length} assets loaded on the projector`
              : `${report.assets.length - failed.length}/${report.assets.length} loaded. Failed: ${list(failed)}`,
        ),
    result(
      "audio_metadata",
      "Audio metadata",
      "projector",
      audio.length === 0
        ? "WARNING"
        : audio.every((asset) => asset.ok)
          ? "READY"
          : "FAILURE",
      audio.length === 0
        ? "No audio cues"
        : audio.every((asset) => asset.ok)
          ? `${audio.length} track${audio.length === 1 ? "" : "s"} decoded with duration`
          : `Undecodable: ${list(audio.filter((asset) => !asset.ok))}`,
      audio.length > 0,
    ),
    result(
      "video_metadata",
      "Video metadata",
      "projector",
      video.length === 0
        ? "WARNING"
        : video.every((asset) => asset.ok)
          ? "READY"
          : "FAILURE",
      video.length === 0
        ? "No video cues"
        : video.every((asset) => asset.ok)
          ? `${video.length} video${video.length === 1 ? "" : "s"} decoded with duration`
          : `Undecodable: ${list(video.filter((asset) => !asset.ok))}`,
      video.length > 0,
    ),
  ];
}

/**
 * Four probe groups run together and each replaces its own items as it
 * finishes. A failed item reruns only its group, so a fixed projector can be
 * re-checked without repeating the R2 walk.
 */
export function PreflightPanel({ client }: PreflightPanelProps) {
  const [items, setItems] = useState<PreflightItem[]>([]);
  const [ranAt, setRanAt] = useState<string | null>(null);
  const requestRef = useRef<string | null>(null);

  function merge(next: readonly PreflightItem[]): void {
    setItems((current) => {
      const byId = new Map(current.map((item) => [item.id, item]));
      for (const item of next) byId.set(item.id, item);
      return [...byId.values()];
    });
  }

  async function runServer(only?: string): Promise<void> {
    try {
      const response = await fetch(
        only
          ? `/api/admin/preflight?only=${encodeURIComponent(only)}`
          : "/api/admin/preflight",
        { credentials: "same-origin" },
      );
      const body = response.ok
        ? ((await response.json()) as { items: PreflightItem[] })
        : null;
      merge(
        body?.items ?? [
          result(
            only ?? "server",
            "Coordinator checks",
            "server",
            "FAILURE",
            `HTTP ${response.status} from the preflight endpoint.`,
          ),
        ],
      );
    } catch {
      merge([
        result(
          only ?? "server",
          "Coordinator checks",
          "server",
          "FAILURE",
          "The preflight endpoint did not respond.",
        ),
      ]);
    }
  }

  function runProjector(): void {
    merge(PROJECTOR_PENDING);
    const requestId = crypto.randomUUID().replaceAll("-", "");
    requestRef.current = requestId;
    const sent = client.send({
      type: "preflight_request",
      protocolVersion: PROTOCOL_VERSION,
      requestId: commandId(requestId),
    });
    if (!sent) {
      merge(
        PROJECTOR_PENDING.map((item) => ({
          ...item,
          status: "FAILURE",
          detail: "Control link is not live; cannot reach the projector.",
        })),
      );
      return;
    }
    setTimeout(() => {
      if (requestRef.current !== requestId) return;
      setItems((current) =>
        current.map((item) =>
          item.group === "projector" && item.status === "PENDING"
            ? {
                ...item,
                status: "FAILURE",
                detail:
                  "The projector did not answer within 45 s. Is it connected and awake?",
              }
            : item,
        ),
      );
    }, PROJECTOR_TIMEOUT_MS);
  }

  function runAll(): void {
    setRanAt(new Date().toLocaleTimeString());
    setItems([...BROWSER_PENDING, ...REALTIME_PENDING, ...PROJECTOR_PENDING]);
    void browserChecks().then(merge);
    void realtimeCheck(client).then(merge);
    void runServer();
    runProjector();
  }

  function rerun(item: PreflightItem): void {
    switch (item.group) {
      case "server":
        merge([{ ...item, status: "PENDING", detail: "Running…" }]);
        void runServer(item.id);
        return;
      case "browser":
        merge(BROWSER_PENDING);
        void browserChecks().then(merge);
        return;
      case "realtime":
        merge(REALTIME_PENDING);
        void realtimeCheck(client).then(merge);
        return;
      case "projector":
        runProjector();
        return;
    }
  }

  useEffect(() => {
    const unsubscribe = client.subscribeSelector(
      (state) => state.lastPreflightReport,
      () => {
        const report = client.getState().lastPreflightReport;
        if (report && report.requestId === requestRef.current) {
          requestRef.current = null;
          merge(projectorItems(report.report));
        }
      },
    );
    return unsubscribe;
  }, [client]);

  const overall = items.length === 0 ? null : overallReadiness(items);
  const ordered = [...items].sort(
    (left, right) => rank(left.status) - rank(right.status),
  );

  return (
    <section className="preflight" aria-labelledby="preflight-title">
      <div className="region-title">
        <p>PREFLIGHT</p>
        <h2 id="preflight-title">Readiness test</h2>
        <span>
          {ranAt
            ? `Last run ${ranAt}. Each row is a live probe with a fix.`
            : "Runs coordinator, browser, realtime and projector probes."}
        </span>
      </div>
      <div className="preflight__bar">
        <button type="button" className="preflight__run" onClick={runAll}>
          RUN PREFLIGHT
        </button>
        {overall && (
          <strong
            className={`preflight__overall preflight__overall--${overall.toLowerCase()}`}
          >
            {overall === "READY"
              ? "READY"
              : overall === "WARNING"
                ? "READY WITH WARNINGS"
                : overall === "PENDING"
                  ? "CHECKING…"
                  : "NOT READY"}
          </strong>
        )}
      </div>
      {items.length > 0 && (
        <ul className="preflight__list">
          {ordered.map((item) => (
            <li
              key={item.id}
              className={`preflight__item preflight__item--${item.status.toLowerCase()}`}
            >
              <span className="preflight__status">{item.status}</span>
              <span className="preflight__label">
                <b>{item.label}</b>
                {!item.required && <small> optional</small>}
                <span className="preflight__detail">{item.detail}</span>
              </span>
              {(item.status === "FAILURE" || item.status === "WARNING") && (
                <button type="button" onClick={() => rerun(item)}>
                  RERUN
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function rank(status: PreflightItem["status"]): number {
  switch (status) {
    case "FAILURE":
      return 0;
    case "PENDING":
      return 1;
    case "WARNING":
      return 2;
    case "READY":
      return 3;
  }
}
