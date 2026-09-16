import { useEffect, useState } from "react";

import type { LivePresence } from "../../shared/domain";

export interface ProjectorPairingPanelProps {
  /**
   * Authoritative presence from the coordinator, pushed over the control link
   * the moment it changes. Null until the first message arrives.
   */
  presence: LivePresence | null;
}

/** Paired, connected and armed are three different facts, shown as three. */
export function projectorStatusLabels(presence: LivePresence | null): {
  paired: string;
  connection: string;
  audio: string;
  ready: boolean;
} {
  if (!presence)
    return {
      paired: "…",
      connection: "…",
      audio: "…",
      ready: false,
    };
  const connected = presence.projectors > 0;
  return {
    paired: presence.projectorPaired ? "PAIRED" : "NOT PAIRED",
    connection: connected
      ? presence.projectors === 1
        ? "CONNECTED"
        : `${presence.projectors} CONNECTED`
      : presence.projectorPaired
        ? "PAIRED · NOT CONNECTED"
        : "NOT CONNECTED",
    audio: !connected
      ? "AUDIO —"
      : presence.projectorArmed
        ? "AUDIO ARMED"
        : "AUDIO NOT ARMED",
    ready: connected && presence.projectorArmed === true,
  };
}

export function ProjectorPairingPanel({
  presence,
}: ProjectorPairingPanelProps) {
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

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
    if (response.ok) setCode(null);
  }

  const labels = projectorStatusLabels(presence);
  const remaining =
    expiresAt === null
      ? null
      : Math.max(0, Math.ceil((expiresAt - now) / 1000));

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
          session survives reloads. Status here is live from the coordinator.
        </span>
      </div>
      <p className="projector-pairing-admin__status">
        <b className={presence?.projectorPaired ? "is-ready" : ""}>
          {labels.paired}
        </b>
        <span className={presence && presence.projectors > 0 ? "is-ready" : ""}>
          {labels.connection}
        </span>
        <span className={labels.ready ? "is-ready" : ""}>{labels.audio}</span>
      </p>
      <button type="button" onClick={() => void generate()}>
        {code ? "REPLACE PAIRING CODE" : "GENERATE PROJECTOR CODE"}
      </button>
      {code && (
        <output className="projector-pairing-admin__code">
          <strong>{code}</strong>
          {remaining !== null && (
            <span>
              {remaining === 0
                ? "Code expired — generate another"
                : `${remaining} seconds remaining`}
            </span>
          )}
        </output>
      )}
      {presence?.projectorPaired && (
        <button type="button" onClick={() => void revoke()}>
          REVOKE PROJECTOR SESSIONS
        </button>
      )}
      {notice && <p role="alert">{notice}</p>}
    </section>
  );
}
