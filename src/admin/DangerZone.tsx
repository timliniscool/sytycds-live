import { useState } from "react";

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
}

export interface DangerZoneProps {
  /** Typing the event's own name is one of the two accepted confirmations. */
  eventTitle: string;
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
 * The two operations that destroy data, kept together, last, and behind
 * deliberate confirmation. Neither is reachable by a single click: the reset
 * opens a warning, then requires the operator to type something only somebody
 * who meant it would type.
 */
export function DangerZone({ eventTitle }: DangerZoneProps) {
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
    setNotice(
      result.mediaCleanupComplete
        ? `Show reset. ${result.clearedActs} act${result.clearedActs === 1 ? "" : "s"} and ${result.objectsDeleted} media file${result.objectsDeleted === 1 ? "" : "s"} removed. Event name, theme and judges kept.`
        : `Show reset, but ${result.objectsPending} media file${result.objectsPending === 1 ? "" : "s"} could not be deleted from storage yet. Use RETRY MEDIA CLEANUP below.`,
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
        <h2 id="danger-zone-title">Reset and storage maintenance</h2>
        <span>
          Between events, not during one. Every action here destroys data.
        </span>
      </div>

      <div className="danger-zone__action">
        <div className="danger-zone__copy">
          <h3>Reset entire show</h3>
          <p>
            Clears every act, cue, uploaded file, vote, judge score and result,
            and returns the projector to the lobby. <b>Keeps</b> the event name,
            theme, typeface, public text and the judge panel with its links, so
            the next event starts already set up.
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

      <div className="danger-zone__action">
        <div className="danger-zone__copy">
          <h3>Orphaned media</h3>
          <p>
            Uploaded files that no act and no cue refers to any more, plus any
            bytes left in storage with no record at all. Scanning is safe and
            changes nothing; cleaning deletes them from storage. Cached
            typefaces and platform assets live outside the show's storage
            namespace and are never included.
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
