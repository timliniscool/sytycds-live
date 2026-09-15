import { useEffect, useState } from "react";

interface Status {
  paired: boolean;
  connected: boolean;
}

export function ProjectorPairingPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  async function refresh(): Promise<void> {
    const response = await fetch("/api/admin/projector", {
      credentials: "same-origin",
    });
    if (response.ok) setStatus((await response.json()) as Status);
  }
  useEffect(() => {
    void refresh();
    const statusTimer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(statusTimer);
  }, []);
  useEffect(() => {
    if (!expiresAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);

  async function generate(): Promise<void> {
    const response = await fetch("/api/admin/projector/code", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const result = (await response.json()) as {
      code?: string;
      expiresAt?: number;
      error?: string;
    };
    if (!response.ok || !result.code) {
      setNotice(result.error ?? "Unable to create code");
      return;
    }
    setCode(`${result.code.slice(0, 4)} ${result.code.slice(4)}`);
    setExpiresAt(result.expiresAt ?? null);
    setNotice(null);
  }

  async function revoke(): Promise<void> {
    if (
      !window.confirm(
        "Revoke every paired projector session? The display will return to its pairing screen immediately.",
      )
    )
      return;
    const response = await fetch("/api/admin/projector/revoke", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (response.ok) {
      setCode(null);
      await refresh();
    }
  }

  return (
    <section
      className="projector-pairing-admin"
      aria-labelledby="projector-pairing-title"
    >
      <div className="region-title">
        <p>DISPLAY ACCESS</p>
        <h2 id="projector-pairing-title">Projector pairing</h2>
        <span>
          One-time codes expire after ten minutes. Pair once; the secure display
          session survives reloads.
        </span>
      </div>
      <p className="projector-pairing-admin__status">
        <b className={status?.paired ? "is-ready" : ""}>
          {status?.paired ? "PAIRED" : "NOT PAIRED"}
        </b>
        <span className={status?.connected ? "is-ready" : ""}>
          {status?.connected ? "LIVE CONNECTION" : "DISPLAY OFFLINE"}
        </span>
      </p>
      <button type="button" onClick={() => void generate()}>
        {code ? "REPLACE PAIRING CODE" : "GENERATE PROJECTOR CODE"}
      </button>
      {code && (
        <output className="projector-pairing-admin__code">
          <strong>{code}</strong>
          {expiresAt && (
            <span>
              {Math.max(0, Math.ceil((expiresAt - now) / 1000))} seconds
              remaining
            </span>
          )}
        </output>
      )}
      {status?.paired && (
        <button type="button" onClick={() => void revoke()}>
          REVOKE PROJECTOR SESSIONS
        </button>
      )}
      {notice && <p role="alert">{notice}</p>}
    </section>
  );
}
