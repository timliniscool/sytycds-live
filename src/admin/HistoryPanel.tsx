import { useEffect, useState } from "react";

import type { AuditEvent } from "../../shared/domain";

const PAGE = 50;

interface HistoryPage {
  events: AuditEvent[];
  nextBefore: number | null;
}

/** Plain English for each event type; the data column carries the specifics. */
const LABELS: Readonly<Record<string, string>> = {
  "act.selected": "Act selected",
  "act.withdrawn": "Act withdrawn",
  "act.reinstated": "Act reinstated",
  "display.changed": "Display changed",
  "display.restored": "Display restored",
  "emergency.activated": "EMERGENCY",
  "voting.opened": "Audience voting opened",
  "voting.closed": "Audience voting closed",
  "judges.permission": "Judge permission",
  "judge.submitted": "Judge score accepted",
  "audience.milestone": "Audience votes",
  "result.finalised": "Result finalised",
  "result.revealed": "Result revealed",
  "result.hidden": "Result hidden",
  "results.stage": "Results stage",
  "results.revealed_next": "Next place revealed",
  "results.reset": "Staged reveal reset",
  "message.updated": "Public text updated",
  "cue.prepared": "Cue prepared",
  "cue.played": "Cue played",
  "cue.executed": "Projector executed",
  "cue.failed": "PROJECTOR FAILED",
  "media.transport": "Media transport",
  "media.error": "MEDIA ERROR",
  "command.refused": "Command refused",
  "admin.login": "Operator signed in",
  "admin.login_failed": "Operator sign-in failed",
  "admin.login_blocked": "Operator sign-in blocked",
};

const ALARMS: ReadonlySet<string> = new Set([
  "emergency.activated",
  "cue.failed",
  "media.error",
  "admin.login_failed",
  "admin.login_blocked",
]);

function describe(event: AuditEvent): string {
  const parts = Object.entries(event.data)
    .filter(([, value]) => value !== null && value !== "")
    .map(([key, value]) => `${key} ${String(value)}`);
  return parts.join(" · ");
}

function time(at: string): string {
  return new Date(at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

async function fetchPage(before: number | null): Promise<HistoryPage | null> {
  const url = before
    ? `/api/admin/history?before=${before}&limit=${PAGE}`
    : `/api/admin/history?limit=${PAGE}`;
  const response = await fetch(url, { credentials: "same-origin" });
  return response.ok ? ((await response.json()) as HistoryPage) : null;
}

export interface HistoryPanelProps {
  /** Any revisioned message bumps this; the newest page follows it. */
  revision: number | null;
}

/**
 * Newest first, one bounded page at a time. "Load older" walks back by ID, so
 * events arriving while the operator reads never shift what is on screen.
 */
export function HistoryPanel({ revision }: HistoryPanelProps) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void fetchPage(null).then((page) => {
        if (cancelled) return;
        if (!page) {
          setFailed(true);
          return;
        }
        setFailed(false);
        setEvents((current) => {
          // Merge the newest page over what is shown so older pages already
          // loaded stay in place.
          const known = new Set(page.events.map((event) => event.id));
          return [
            ...page.events,
            ...current.filter((event) => !known.has(event.id)),
          ];
        });
        setNextBefore((current) => current ?? page.nextBefore);
      });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [revision]);

  async function loadOlder(): Promise<void> {
    if (nextBefore === null || loading) return;
    setLoading(true);
    const page = await fetchPage(nextBefore);
    setLoading(false);
    if (!page) return;
    setEvents((current) => {
      const known = new Set(current.map((event) => event.id));
      return [
        ...current,
        ...page.events.filter((event) => !known.has(event.id)),
      ];
    });
    setNextBefore(page.nextBefore);
  }

  return (
    <section className="history" aria-labelledby="history-title">
      <div className="region-title">
        <p>HISTORY</p>
        <h2 id="history-title">What happened</h2>
        <span>
          Server-timed operational log, newest first. No votes, tokens or
          addresses are recorded here.
        </span>
      </div>
      {failed && (
        <p className="history__empty">The history endpoint did not answer.</p>
      )}
      {!failed && events.length === 0 && (
        <p className="history__empty">Nothing has happened yet.</p>
      )}
      <ol className="history__list">
        {events.map((event) => (
          <li
            key={event.id}
            className={`history__row${ALARMS.has(event.type) ? " history__row--alarm" : ""}${event.type === "command.refused" ? " history__row--refused" : ""}`}
          >
            <time dateTime={event.at}>{time(event.at)}</time>
            <span className="history__actor">{event.actor}</span>
            <span className="history__what">
              <b>{LABELS[event.type] ?? event.type}</b>
              <small>{describe(event) || " "}</small>
            </span>
          </li>
        ))}
      </ol>
      {nextBefore !== null && (
        <div className="history__more">
          <button
            type="button"
            disabled={loading}
            onClick={() => void loadOlder()}
          >
            {loading ? "LOADING…" : "LOAD OLDER"}
          </button>
        </div>
      )}
    </section>
  );
}
