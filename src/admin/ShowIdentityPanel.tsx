import { useEffect, useState, type FormEvent } from "react";

export interface ShowIdentityPanelProps {
  /** Null until the show exists; the panel then creates it. */
  current: { title: string; tagline: string } | null;
}

/**
 * The one provisioning step a fresh deployment needs. Before the show exists
 * every surface reports it as unavailable; saving here creates it and the
 * coordinator resnapshots every connected client.
 */
export function ShowIdentityPanel({ current }: ShowIdentityPanelProps) {
  const [title, setTitle] = useState(current?.title ?? "");
  const [tagline, setTagline] = useState(current?.tagline ?? "");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setTitle(current?.title ?? "");
    setTagline(current?.tagline ?? "");
  }, [current?.title, current?.tagline]);

  const dirty =
    title.trim() !== (current?.title ?? "") ||
    tagline.trim() !== (current?.tagline ?? "");

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    const response = await fetch("/api/admin/show", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, tagline }),
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
