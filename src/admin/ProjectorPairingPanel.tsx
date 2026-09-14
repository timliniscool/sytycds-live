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

  async function refresh(): Promise<void> {
    const response = await fetch("/api/admin/projector", {
      credentials: "same-origin",
    });
    if (response.ok) setStatus((await response.json()) as Status);
  }
  useEffect(() => {
    void refresh();
  }, []);

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
    <section aria-labelledby="projector-pairing-title">
      <h2 id="projector-pairing-title">Projector pairing</h2>
      <p>
        {status?.paired ? "Paired" : "Not paired"} ·{" "}
        {status?.connected ? "connected" : "offline"}
      </p>
      <button type="button" onClick={() => void generate()}>
        Generate projector code
      </button>
      {code && (
        <output>
          <strong>{code}</strong>
          {expiresAt &&
            ` · expires ${new Date(expiresAt).toLocaleTimeString()}`}
        </output>
      )}
      {status?.paired && (
        <button type="button" onClick={() => void revoke()}>
          Revoke projector
        </button>
      )}
      {notice && <p role="alert">{notice}</p>}
    </section>
  );
}
