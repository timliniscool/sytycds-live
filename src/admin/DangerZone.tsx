import { useEffect, useState } from "react";

import type { TestShowGeneration } from "../../shared/domain";

interface OrphanReport {
  assets: readonly {
    id: string;
    objectKey: string;
    originalFilename: string;
    mimeType: string;
    sizeBytes: number;
  }[];
  totalBytes: number;
  pendingCleanup: number;
  /** Bytes in storage with no metadata row at all. */
  strayObjects: readonly { key: string; sizeBytes: number }[];
  strayBytes: number;
  strayListingTruncated: boolean;
}

interface ResetResult {
  clearedActs: number;
  objectsDeleted: number;
  objectsPending: number;
  mediaCleanupComplete: boolean;
  projectorSessionsRevoked: number;
}

interface TestShowStatus {
  current: TestShowGeneration | null;
  scenarios: readonly { id: string; label: string; phase: string }[];
  showDataExists: boolean;
}

interface TestShowSummary {
  testShowId: string;
  seed: string;
  scenario: string;
  scenarioLabel: string;
  acts: number;
  votes: number;
  judgeSubmissions: number;
  finalised: number;
  assets: number;
  brokenAssets: number;
  objectsPending: number;
}

export interface DangerZoneProps {
  /** Typing the event's own name is one of the two accepted confirmations. */
  eventTitle: string;
  /** The generated test show currently loaded, if any. */
  testShow: TestShowGeneration | null;
}

function megabytes(bytes: number): string {
  return bytes >= 1_048_576
    ? `${(bytes / 1_048_576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

async function request<Value>(
  input: string,
  init?: RequestInit,
): Promise<Value | { error: string }> {
  try {
    const response = await fetch(input, {
      credentials: "same-origin",
      ...init,
    });
    const body = (await response.json().catch(() => null)) as
      (Value & { error?: string }) | null;
    if (!response.ok)
      return {
        error: body?.error ?? `Request failed (HTTP ${response.status})`,
      };
    return (body ?? ({} as Value)) as Value;
  } catch {
    return { error: "The show server could not be reached." };
  }
}

/**
 * The operations that destroy data, kept together, last, and behind
 * deliberate confirmation. None is reachable by a single click: each opens a
 * warning, then requires the operator to type something only somebody who
 * meant it would type.
 */
export function DangerZone({ eventTitle, testShow }: DangerZoneProps) {
  const [open, setOpen] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [orphans, setOrphans] = useState<OrphanReport | null>(null);

  const confirmed =
    phrase.trim() === "RESET" ||
    phrase.trim().toLowerCase() === eventTitle.trim().toLowerCase();
  // Both directions count: rows nothing references, and bytes nothing records.
  const orphanCount = orphans
    ? orphans.assets.length + orphans.strayObjects.length
    : 0;

  async function reset(): Promise<void> {
    setBusy(true);
    setNotice(null);
    setFailed(false);
    const result = await request<ResetResult>("/api/admin/show/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "RESET SHOW" }),
    });
    setBusy(false);
    setPhrase("");
    setOpen(false);
    if ("error" in result) {
      setFailed(true);
      setNotice(result.error);
      return;
    }
    // Never report a clean bucket that is not clean.
    setFailed(!result.mediaCleanupComplete);
    const summary = `${result.clearedActs} act${result.clearedActs === 1 ? "" : "s"} and ${result.objectsDeleted} media file${result.objectsDeleted === 1 ? "" : "s"} removed. Event identity, appearance, judge setup, weighting, show-flow preferences, public messages and paired projector sessions were retained.`;
    setNotice(
      result.mediaCleanupComplete
        ? `Show reset. ${summary}`
        : `Show reset, but ${result.objectsPending} media file${result.objectsPending === 1 ? "" : "s"} could not be deleted from storage yet. Use RETRY MEDIA CLEANUP below. ${summary}`,
    );
  }

  async function scan(): Promise<void> {
    setBusy(true);
    setNotice(null);
    const result = await request<OrphanReport>("/api/admin/media/orphans");
    setBusy(false);
    if ("error" in result) {
      setFailed(true);
      setNotice(result.error);
      return;
    }
    setOrphans(result);
    setFailed(false);
    const total = result.assets.length + result.strayObjects.length;
    const bytes = result.totalBytes + result.strayBytes;
    setNotice(
      total === 0
        ? "No orphaned media. Every file in storage is still in use."
        : `${total} orphaned file${total === 1 ? "" : "s"} using ${megabytes(bytes)}` +
            (result.strayObjects.length > 0
              ? ` — ${result.strayObjects.length} of them left in storage with no record, from an interrupted delete.`
              : "."),
    );
  }

  async function clean(): Promise<void> {
    setBusy(true);
    setNotice(null);
    const result = await request<{
      retired: number;
      strays: number;
      deleted: number;
      pending: number;
      complete: boolean;
    }>("/api/admin/media/orphans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "CLEAN ORPHANED MEDIA" }),
    });
    setBusy(false);
    if ("error" in result) {
      setFailed(true);
      setNotice(result.error);
      return;
    }
    setOrphans(null);
    setFailed(!result.complete);
    setNotice(
      result.complete
        ? `${result.deleted} orphaned file${result.deleted === 1 ? "" : "s"} deleted from storage.`
        : `${result.deleted} deleted; ${result.pending} still pending. Retry below.`,
    );
  }

  async function retry(): Promise<void> {
    setBusy(true);
    setNotice(null);
    const result = await request<{
      deleted: number;
      pending: number;
      complete: boolean;
    }>("/api/admin/media/cleanup/retry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    setBusy(false);
    if ("error" in result) {
      setFailed(true);
      setNotice(result.error);
      return;
    }
    setFailed(!result.complete);
    setNotice(
      result.complete
        ? "Storage cleanup complete. Nothing is outstanding."
        : `${result.deleted} deleted; ${result.pending} still outstanding.`,
    );
  }

  return (
    <section className="danger-zone" aria-labelledby="danger-zone-title">
      <div className="region-title">
        <p>04 / DANGER</p>
        <h2 id="danger-zone-title">
          Reset, test shows and storage maintenance
        </h2>
        <span>
          Between events, not during one. Every action here destroys data.
        </span>
      </div>

      <div className="danger-zone__action">
        <div className="danger-zone__copy">
          <h3>Reset entire show</h3>
          <p>
            Clears every act, cue, uploaded and generated file, vote, judge
            score, result and temporary projector pairing code. The stage
            returns to a safe empty lobby.
          </p>
          <p>
            <b>Kept:</b> event name and text, theme and typeface, judge panel
            and links, weighting, GO behaviour, public messages, reactions,
            paired projector sessions, operator sign-in and deployment setup.
          </p>
        </div>
        {!open ? (
          <button
            type="button"
            className="danger-zone__arm"
            onClick={() => setOpen(true)}
          >
            RESET ENTIRE SHOW…
          </button>
        ) : (
          <div className="danger-zone__confirm" role="alertdialog">
            <strong>This cannot be undone.</strong>
            <label htmlFor="reset-phrase">
              Type <b>{eventTitle || "RESET"}</b> or <b>RESET</b> to confirm
            </label>
            <input
              id="reset-phrase"
              type="text"
              autoComplete="off"
              value={phrase}
              onChange={(event) => setPhrase(event.target.value)}
            />
            <div className="danger-zone__confirm-actions">
              <button
                type="button"
                className="danger-zone__fire"
                disabled={busy || !confirmed}
                onClick={() => void reset()}
              >
                {busy ? "RESETTING…" : "RESET ENTIRE SHOW"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setOpen(false);
                  setPhrase("");
                }}
              >
                CANCEL
              </button>
            </div>
          </div>
        )}
      </div>

      <ScoringResetPanel
        busy={busy}
        setBusy={setBusy}
        report={(message, isFailure) => {
          setFailed(isFailure);
          setNotice(message);
        }}
      />

      <TestShowPanel
        current={testShow}
        busy={busy}
        setBusy={setBusy}
        report={(message, isFailure) => {
          setFailed(isFailure);
          setNotice(message);
        }}
      />

      <div className="danger-zone__action">
        <div className="danger-zone__copy">
          <h3>Orphaned media</h3>
          <p>
            Uploaded files that no act and no cue refers to any more, plus any
            bytes left in storage with no record at all. Scanning is safe and
            changes nothing; cleaning deletes them from storage. Cached
            typefaces and platform assets live outside the show's storage
            namespaces and are never included.
          </p>
        </div>
        <div className="danger-zone__buttons">
          <button type="button" disabled={busy} onClick={() => void scan()}>
            FIND ORPHANED MEDIA
          </button>
          <button
            type="button"
            className="danger-zone__fire"
            disabled={busy || !orphans || orphanCount === 0}
            onClick={() => void clean()}
          >
            {orphanCount > 0
              ? `DELETE ${orphanCount} FILE${orphanCount === 1 ? "" : "S"}`
              : "NOTHING TO DELETE"}
          </button>
          <button type="button" disabled={busy} onClick={() => void retry()}>
            RETRY MEDIA CLEANUP
          </button>
        </div>
        {orphans && orphanCount > 0 && (
          <ul className="danger-zone__orphans">
            {orphans.assets.slice(0, 20).map((asset) => (
              <li key={asset.id}>
                <b>{asset.originalFilename}</b>
                <small>
                  {asset.mimeType} · {megabytes(asset.sizeBytes)}
                </small>
              </li>
            ))}
            {orphans.strayObjects.slice(0, 20).map((object) => (
              <li key={object.key}>
                <b>{object.key}</b>
                <small>no record · {megabytes(object.sizeBytes)}</small>
              </li>
            ))}
            {orphanCount > 40 && (
              <li>
                <small>and {orphanCount - 40} more…</small>
              </li>
            )}
          </ul>
        )}
      </div>

      {notice && (
        <output
          className={`danger-zone__notice${failed ? " danger-zone__notice--failed" : ""}`}
          role="status"
        >
          {notice}
        </output>
      )}
    </section>
  );
}

/**
 * The hard reset of scoring alone: every audience vote, judge score and
 * finalised result goes, the acts and their media stay. Typed confirmation is
 * proportionate here — a whole evening's scores are destroyed — and the client
 * then sends the server's separate fixed phrase.
 */
function ScoringResetPanel({
  busy,
  setBusy,
  report,
}: {
  busy: boolean;
  setBusy: (value: boolean) => void;
  report: (message: string, failed: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [phrase, setPhrase] = useState("");
  const confirmed = phrase.trim().toUpperCase() === "RESET VOTES";

  async function reset(): Promise<void> {
    setBusy(true);
    const result = await request<{
      audienceVotes: number;
      judgeScores: number;
      finalisedResults: number;
    }>("/api/admin/scoring/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "RESET SCORING" }),
    });
    setBusy(false);
    setOpen(false);
    setPhrase("");
    if ("error" in result) {
      report(result.error, true);
      return;
    }
    report(
      `Scoring reset. ${result.audienceVotes} audience vote${result.audienceVotes === 1 ? "" : "s"}, ${result.judgeScores} judge score${result.judgeScores === 1 ? "" : "s"} and ${result.finalisedResults} finalised result${result.finalisedResults === 1 ? "" : "s"} removed. Acts, media, judges and the running order are untouched; voting and judge scoring are closed.`,
      false,
    );
  }

  return (
    <div className="danger-zone__action">
      <div className="danger-zone__copy">
        <h3>Reset all votes and scores</h3>
        <p>
          Removes every audience vote, judge score, finalised result and results
          reveal for every act, so scoring can start again from nothing — for a
          rehearsal, or to revisit acts that were already finalised. Voting and
          judge scoring close.
        </p>
        <p>
          <b>Kept:</b> every act, performer, running order, media file, cue,
          judge panel and link, and all show settings.
        </p>
      </div>
      {!open ? (
        <button
          type="button"
          className="danger-zone__arm"
          disabled={busy}
          onClick={() => setOpen(true)}
        >
          RESET ALL VOTES & SCORES…
        </button>
      ) : (
        <div className="danger-zone__confirm" role="alertdialog">
          <strong>
            Every vote and score in the show is destroyed. This cannot be
            undone.
          </strong>
          <label htmlFor="scoring-reset-phrase">
            Type <b>RESET VOTES</b> to confirm
          </label>
          <input
            id="scoring-reset-phrase"
            type="text"
            autoComplete="off"
            value={phrase}
            onChange={(event) => setPhrase(event.target.value)}
          />
          <div className="danger-zone__confirm-actions">
            <button
              type="button"
              className="danger-zone__fire"
              disabled={busy || !confirmed}
              onClick={() => void reset()}
            >
              {busy ? "RESETTING…" : "RESET ALL VOTES & SCORES"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setPhrase("");
              }}
            >
              CANCEL
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The procedural test-show generator. Every press produces a new seed and a
 * new scenario unless the operator pins one; the seed is shown so a layout or
 * scoring problem seen once can be reproduced exactly.
 */
function TestShowPanel({
  current,
  busy,
  setBusy,
  report,
}: {
  current: TestShowGeneration | null;
  busy: boolean;
  setBusy: (value: boolean) => void;
  report: (message: string, failed: boolean) => void;
}) {
  const [status, setStatus] = useState<TestShowStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [seed, setSeed] = useState("");
  const [scenario, setScenario] = useState("");
  const [last, setLast] = useState<TestShowSummary | null>(null);

  useEffect(() => {
    void request<TestShowStatus>("/api/admin/test-show").then((result) => {
      if (!("error" in result)) setStatus(result);
    });
  }, [current?.testShowId]);

  async function generate(): Promise<void> {
    setBusy(true);
    const result = await request<TestShowSummary>("/api/admin/test-show", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirm: "GENERATE TEST SHOW",
        seed: seed.trim() || undefined,
        scenario: scenario || undefined,
      }),
    });
    setBusy(false);
    setOpen(false);
    if ("error" in result) {
      report(result.error, true);
      return;
    }
    setLast(result);
    report(
      `Test show generated. Seed ${result.seed} · ${result.scenarioLabel} · ${result.acts} acts, ${result.votes} votes, ${result.judgeSubmissions} judge scores, ${result.finalised} finalised, ${result.assets} media fixture${result.assets === 1 ? "" : "s"}${result.brokenAssets > 0 ? ` (${result.brokenAssets} deliberately broken)` : ""}.${result.objectsPending > 0 ? ` ${result.objectsPending} old file(s) still pending deletion.` : ""}`,
      result.objectsPending > 0,
    );
  }

  return (
    <div className="danger-zone__action test-show">
      <div className="danger-zone__copy">
        <h3>Generate a test show</h3>
        <p>
          Replaces the current show data with a procedurally generated one:
          acts, media fixtures, audience votes, judge scores and results, at a
          random point in a random evening. Your event name, theme and GO
          behaviour are kept; the judge panel is replaced by the scenario's.
          Everything generated is tagged and lives under its own storage
          namespace, so RESET ENTIRE SHOW removes it completely.
        </p>
        {current && (
          <p className="test-show__current">
            <b>Loaded test show</b> · seed <code>{current.seed}</code> ·{" "}
            {current.scenarioLabel} · generated{" "}
            {new Date(current.generatedAt).toLocaleString()}
          </p>
        )}
        {last && !current && (
          <p className="test-show__current">
            Last generated: seed <code>{last.seed}</code> · {last.scenarioLabel}
          </p>
        )}
      </div>
      {!open ? (
        <button
          type="button"
          className="danger-zone__arm"
          disabled={busy}
          onClick={() => setOpen(true)}
        >
          GENERATE TEST SHOW…
        </button>
      ) : (
        <div
          className="danger-zone__confirm"
          role="alertdialog"
          aria-labelledby="test-show-confirm-title"
        >
          <strong id="test-show-confirm-title">
            {status?.showDataExists
              ? "This replaces the show data that exists now. It cannot be undone."
              : "This fills the empty show with generated data."}
          </strong>
          <p className="danger-zone__explain">
            {status?.showDataExists
              ? "Every act, media file, vote, judge score and result in the show is removed and replaced by a generated evening. "
              : "A generated evening of acts, media, votes, judge scores and results is written into the show. "}
            Your event name, theme and GO behaviour are kept; the judge panel
            becomes the scenario's. RESET ENTIRE SHOW removes everything
            generated.
          </p>
          <div className="test-show__options">
            <label>
              Seed (optional, 8 hex characters)
              <input
                type="text"
                autoComplete="off"
                maxLength={8}
                placeholder="random"
                value={seed}
                onChange={(event) =>
                  setSeed(
                    event.target.value.toUpperCase().replace(/[^0-9A-F]/gu, ""),
                  )
                }
              />
            </label>
            <label>
              Scenario
              <select
                value={scenario}
                onChange={(event) => setScenario(event.target.value)}
              >
                <option value="">
                  Chosen by the seed (weighted to late-show)
                </option>
                {(status?.scenarios ?? []).map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="danger-zone__confirm-actions">
            <button
              type="button"
              className="danger-zone__fire"
              disabled={busy}
              onClick={() => void generate()}
            >
              {busy
                ? "GENERATING…"
                : status?.showDataExists
                  ? "REPLACE SHOW DATA WITH A TEST SHOW"
                  : "GENERATE TEST SHOW"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              CANCEL
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
