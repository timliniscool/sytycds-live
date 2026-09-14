import { useEffect, useState } from "react";

import type { AdminCommandType } from "../../shared/admin-command";
import { MAX_PUBLIC_MESSAGE_LENGTH } from "../../shared/domain";

export interface PublicTextPanelProps {
  intermissionMessage: string;
  emergencyMessage: string;
  send(type: AdminCommandType, extras?: Record<string, unknown>): string | null;
}

function MessageField({
  id,
  label,
  hint,
  value,
  onSave,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  onSave(text: string): void;
}) {
  const [draft, setDraft] = useState(value);
  // The authoritative text wins whenever it changes underneath an idle field.
  useEffect(() => setDraft(value), [value]);
  const dirty = draft.trim() !== value;
  return (
    <div className="public-text__field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="text"
        maxLength={MAX_PUBLIC_MESSAGE_LENGTH}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && dirty) onSave(draft);
        }}
      />
      <button type="button" disabled={!dirty} onClick={() => onSave(draft)}>
        {dirty ? "SAVE" : "SAVED"}
      </button>
      <small>
        {hint} · {draft.length}/{MAX_PUBLIC_MESSAGE_LENGTH}
      </small>
    </div>
  );
}

export function PublicTextPanel({
  intermissionMessage,
  emergencyMessage,
  send,
}: PublicTextPanelProps) {
  return (
    <section className="public-text" aria-label="Public text">
      <div className="region-title">
        <p>PUBLIC TEXT</p>
        <h2>Messages shown to the hall</h2>
        <span>Saved text goes live immediately in its display mode.</span>
      </div>
      <MessageField
        id="intermission-message"
        label="Intermission"
        hint="Shown under “Intermission” on the projector and on phones"
        value={intermissionMessage}
        onSave={(text) => send("SET_INTERMISSION_MESSAGE", { text })}
      />
      <MessageField
        id="emergency-message"
        label="Emergency text"
        hint="Used only by EMERGENCY TEXT; empty shows “Please follow staff instructions”"
        value={emergencyMessage}
        onSave={(text) => send("SET_EMERGENCY_MESSAGE", { text })}
      />
    </section>
  );
}
