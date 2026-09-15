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
  const [issued, setIssued] = useState<IssuedLink[]>([]);
  const [busy, setBusy] = useState(false);

  async function refresh(): Promise<void> {
    const result = await json<{ judges: JudgeSummary[] }>("/api/admin/judges");
    setJudges(result?.judges ?? []);
  }

  useEffect(() => {
    void refresh();
  }, []);

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

  return (
    <section className="judge-links" aria-labelledby="judge-links-title">
      <div className="region-title">
        <p>JUDGE LINKS</p>
        <h2 id="judge-links-title">Private adjudicator access</h2>
        <span>
          The panel itself is configured in <b>02 / SCORING</b>. Links appear
          once. Copy or scan them now; rotate to issue a fresh one.
        </span>
      </div>

      {judges === null && <p className="judge-links__empty">Loading…</p>}

      {judges?.length === 0 && (
        <p className="judge-links__empty">
          No judges yet. Set the panel in <b>02 / SCORING</b> above; every judge
          configured there gets a private link here.
        </p>
      )}

      {judges && judges.length > 0 && (
        <ul className="judge-links__list">
          {judges.map((judge) => {
            const link = issued.find((entry) => entry.judgeId === judge.id);
            return (
              <li key={judge.id} className="judge-links__row">
                <div className="judge-links__identity">
                  <b>{judge.displayName}</b>
                  <small>
                    Judge {judge.slot} ·{" "}
                    {judge.active ? "link active" : "REVOKED"} ·{" "}
                    {judgeConnections.has(judge.id) ? "CONNECTED" : "offline"}
                  </small>
                </div>
                <div className="judge-links__actions">
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
