import { useEffect, useState, type FormEvent } from "react";
import { DEFAULT_EVENT_NAME } from "../../shared/platform";

export interface ShowIdentityPanelProps {
  /** Null until the show exists; the panel then creates it. */
  current: {
    title: string;
    tagline: string;
    shortName?: string;
    themeId?: string;
    fontFamily?: string;
    reactionsEnabled?: boolean;
  } | null;
}

/**
 * The one provisioning step a fresh deployment needs. Before the show exists
 * every surface reports it as unavailable; saving here creates it and the
 * coordinator resnapshots every connected client.
 */
export function ShowIdentityPanel({ current }: ShowIdentityPanelProps) {
  const [title, setTitle] = useState(current?.title ?? DEFAULT_EVENT_NAME);
  const [tagline, setTagline] = useState(current?.tagline ?? "");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setTitle(current?.title ?? DEFAULT_EVENT_NAME);
    setTagline(current?.tagline ?? "");
  }, [current?.title, current?.tagline]);

  const dirty =
    title.trim() !== (current?.title ?? DEFAULT_EVENT_NAME) ||
    tagline.trim() !== (current?.tagline ?? "");

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    const response = await fetch("/api/admin/show", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        tagline,
        shortName: current?.shortName ?? "",
        themeId: current?.themeId ?? "navy-bismarck",
        fontFamily: current?.fontFamily ?? "system-ui",
        reactionsEnabled: current?.reactionsEnabled ?? true,
      }),
    });
    setBusy(false);
    if (response.ok) {
      setNotice(response.status === 201 ? "Show created." : "Saved.");
      return;
    }
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    setNotice(body?.error ?? `Save failed (HTTP ${response.status}).`);
  }

  return (
    <section className="show-identity" aria-labelledby="show-identity-title">
      <div className="region-title">
        <p>SHOW</p>
        <h2 id="show-identity-title">
          {current ? "Show identity" : "Create the show"}
        </h2>
        <span>
          {current
            ? "Title and tagline appear on the lobby graphic."
            : "Nothing else works until the show exists. Acts, judges and media come after."}
        </span>
      </div>
      <form
        className="show-identity__form"
        onSubmit={(event) => void save(event)}
      >
        <label htmlFor="show-title">Title</label>
        <input
          id="show-title"
          type="text"
          required
          maxLength={120}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <label htmlFor="show-tagline">Tagline (optional)</label>
        <input
          id="show-tagline"
          type="text"
          maxLength={160}
          value={tagline}
          onChange={(event) => setTagline(event.target.value)}
        />
        <button type="submit" disabled={busy || (!dirty && current !== null)}>
          {current ? "SAVE" : "CREATE SHOW"}
        </button>
        {notice && <output>{notice}</output>}
      </form>
    </section>
  );
}

/**
 * Starting a deployment completely fresh. It lives beside the rest of setup so
 * it is reachable after the show exists — which is the only time anyone needs
 * it — and is guarded by a typed phrase because there is no undo.
 */
export function ShowResetPanel() {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [resetPhrase, setResetPhrase] = useState("");
  const [resetOpen, setResetOpen] = useState(false);

  async function reset(): Promise<void> {
    setBusy(true);
    setNotice(null);
    const response = await fetch("/api/admin/show/reset", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: resetPhrase }),
    });
    setBusy(false);
    setResetPhrase("");
    setResetOpen(false);
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      setNotice(body?.error ?? `Reset failed (HTTP ${response.status}).`);
    }
  }

  return (
    <section className="show-identity" aria-labelledby="show-reset-title">
      <div className="region-title">
        <p>DANGER</p>
        <h2 id="show-reset-title">Start completely fresh</h2>
        <span>
          Everything about this show, erased. Use it between events, never
          during one.
        </span>
      </div>
      <div className="show-identity__reset">
        <p>DANGER</p>
        {!resetOpen ? (
          <button type="button" onClick={() => setResetOpen(true)}>
            START COMPLETELY FRESH…
          </button>
        ) : (
          <>
            <span>
              Erases the show, every act, cue, media file, judge link, vote,
              score and the history. There is no undo. Type <b>RESET SHOW</b> to
              confirm.
            </span>
            <input
              type="text"
              aria-label="Type RESET SHOW to confirm"
              autoComplete="off"
              value={resetPhrase}
              onChange={(event) => setResetPhrase(event.target.value)}
            />
            <button
              type="button"
              className="show-identity__reset-fire"
              disabled={busy || resetPhrase !== "RESET SHOW"}
              onClick={() => void reset()}
            >
              ERASE EVERYTHING
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setResetOpen(false);
                setResetPhrase("");
              }}
            >
              CANCEL
            </button>
          </>
        )}
        {notice && <output>{notice}</output>}
      </div>
    </section>
  );
}
