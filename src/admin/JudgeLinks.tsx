import { useEffect, useState } from "react";

import { JoinCode } from "../projector/ProjectorGraphics";

interface JudgeSummary {
  id: string;
  slot: number;
  displayName: string;
  active: boolean;
}

interface IssuedLink {
  judgeId: string;
  slot: number;
  displayName: string;
  link: string;
}

export interface JudgeLinksProps {
  judgeConnections: ReadonlySet<string>;
}

async function json<Value>(
  input: string,
  init?: RequestInit,
): Promise<Value | null> {
  const response = await fetch(input, { credentials: "same-origin", ...init });
  return response.ok ? ((await response.json()) as Value) : null;
}

/**
 * Judge links are private credentials and never appear on the projector or in
 * any public projection. They are shown here exactly once, when issued or
 * rotated; the server keeps only a hash and cannot show them again.
 */
export function JudgeLinks({ judgeConnections }: JudgeLinksProps) {
  const [judges, setJudges] = useState<JudgeSummary[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [labels, setLabels] = useState([
    "Judge 1",
    "Judge 2",
    "Judge 3",
    "Judge 4",
  ]);
  const [issued, setIssued] = useState<IssuedLink[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    const result = await json<{ judges: JudgeSummary[] }>("/api/admin/judges");
    const current = result?.judges ?? [];
    setJudges(current);
    setNames((previous) =>
      Object.fromEntries(
        current.map((judge) => [
          judge.id,
          previous[judge.id] ?? judge.displayName,
        ]),
      ),
    );
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function create(): Promise<void> {
    setBusy(true);
    setNotice(null);
    const result = await json<{ judges: IssuedLink[] }>(
      "/api/admin/judges/initialize",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labels: labels.map((label) => label.trim()) }),
      },
    );
    setBusy(false);
    if (!result) {
      setNotice("Between one and eight non-empty judge names are required.");
      return;
    }
    setIssued(result.judges);
    await refresh();
  }

  async function rotate(judge: JudgeSummary): Promise<void> {
    if (
      !window.confirm(
        `Rotate ${judge.displayName}'s link? Their current link stops working immediately.`,
      )
    )
      return;
    setBusy(true);
    const result = await json<IssuedLink>(
      `/api/admin/judges/${encodeURIComponent(judge.id)}/rotate`,
      { method: "POST" },
    );
    setBusy(false);
    if (result) {
      setIssued((current) => [
        ...current.filter((entry) => entry.judgeId !== result.judgeId),
        result,
      ]);
    }
    await refresh();
  }

  async function revoke(judge: JudgeSummary): Promise<void> {
    if (!window.confirm(`Revoke ${judge.displayName}'s link?`)) return;
    setBusy(true);
    await json(`/api/admin/judges/${encodeURIComponent(judge.id)}/revoke`, {
      method: "POST",
    });
    setBusy(false);
    setIssued((current) =>
      current.filter((entry) => entry.judgeId !== judge.id),
    );
    await refresh();
  }

  async function rename(judge: JudgeSummary): Promise<void> {
    const displayName = names[judge.id]?.replace(/\s+/gu, " ").trim();
    if (!displayName || displayName === judge.displayName) return;
    setBusy(true);
    const result = await json<{ renamed: boolean }>(
      `/api/admin/judges/${encodeURIComponent(judge.id)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName }),
      },
    );
    setBusy(false);
    setNotice(
      result?.renamed ? "Judge name updated." : "Judge name was not updated.",
    );
    await refresh();
  }

  return (
    <section className="judge-links" aria-labelledby="judge-links-title">
      <div className="region-title">
        <p>JUDGE LINKS</p>
        <h2 id="judge-links-title">Private adjudicator access</h2>
        <span>
          Links appear once. Copy or scan them now; rotate to issue a fresh one.
        </span>
      </div>

      {judges === null && <p className="judge-links__empty">Loading…</p>}

      {judges?.length === 0 && (
        <form
          className="judge-links__create"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <label>
            Number of judges
            <input
              type="number"
              min={1}
              max={8}
              value={labels.length}
              onChange={(event) => {
                const count = Math.min(
                  8,
                  Math.max(1, Number(event.target.value) || 1),
                );
                setLabels((current) =>
                  Array.from(
                    { length: count },
                    (_, index) => current[index] ?? `Judge ${index + 1}`,
                  ),
                );
              }}
            />
          </label>
          {labels.map((label, index) => (
            <label key={index}>
              Judge {index + 1}
              <input
                type="text"
                value={label}
                maxLength={120}
                required
                onChange={(event) =>
                  setLabels((current) =>
                    current.map((entry, position) =>
                      position === index ? event.target.value : entry,
                    ),
                  )
                }
              />
            </label>
          ))}
          <button type="submit" disabled={busy}>
            ISSUE {labels.length} JUDGE LINK{labels.length === 1 ? "" : "S"}
          </button>
          {notice && <p className="judge-links__notice">{notice}</p>}
        </form>
      )}

      {judges && judges.length > 0 && (
        <ul className="judge-links__list">
          {judges.map((judge) => {
            const link = issued.find((entry) => entry.judgeId === judge.id);
            return (
              <li key={judge.id} className="judge-links__row">
                <div className="judge-links__identity">
                  <label>
                    <span className="sr-only">Judge {judge.slot} name</span>
                    <input
                      type="text"
                      value={names[judge.id] ?? judge.displayName}
                      maxLength={120}
                      disabled={busy}
                      onChange={(event) =>
                        setNames((current) => ({
                          ...current,
                          [judge.id]: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <small>
                    Judge {judge.slot} ·{" "}
                    {judge.active ? "link active" : "REVOKED"} ·{" "}
                    {judgeConnections.has(judge.id) ? "CONNECTED" : "offline"}
                  </small>
                </div>
                <div className="judge-links__actions">
                  <button
                    type="button"
                    disabled={
                      busy ||
                      !names[judge.id]?.trim() ||
                      names[judge.id]?.trim() === judge.displayName
                    }
                    onClick={() => void rename(judge)}
                  >
                    SAVE NAME
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void rotate(judge)}
                  >
                    {judge.active ? "ROTATE" : "REISSUE"}
                  </button>
                  <button
                    type="button"
                    disabled={busy || !judge.active}
                    onClick={() => void revoke(judge)}
                  >
                    REVOKE
                  </button>
                </div>
                {link && (
                  <div className="judge-links__issued">
                    <JoinCode url={link.link} className="judge-links__qr" />
                    <code>{link.link}</code>
                    <button
                      type="button"
                      onClick={() =>
                        void navigator.clipboard
                          ?.writeText(link.link)
                          .catch(() => undefined)
                      }
                    >
                      COPY
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
