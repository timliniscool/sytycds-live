import { useState } from "react";

/**
 * Clears every audience vote, judge score and finalised result for one act,
 * behind a typed confirmation. The dialog is an in-page sheet, never a browser
 * alert, and the outcome is reported back to the caller as a plain sentence
 * so the console can show it as a notification.
 */
export interface ClearActScoresProps {
  actId: string;
  actName: string;
  /** Called with a sentence describing what happened, and whether it failed. */
  onDone: (message: string, failed: boolean) => void;
  onClose: () => void;
}

export const CLEAR_ACT_SCORES_PHRASE = "CLEAR";

export function ClearActScoresDialog({
  actId,
  actName,
  onDone,
  onClose,
}: ClearActScoresProps) {
  const [phrase, setPhrase] = useState("");
  const [busy, setBusy] = useState(false);
  const confirmed = phrase.trim().toUpperCase() === CLEAR_ACT_SCORES_PHRASE;

  async function clear(): Promise<void> {
    setBusy(true);
    try {
      const response = await fetch(
        `/api/admin/acts/${encodeURIComponent(actId)}/scoring/reset`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirm: "CLEAR ACT SCORING" }),
        },
      );
      const result = (await response.json().catch(() => null)) as {
        error?: string;
        audienceVotes?: number;
        judgeScores?: number;
        finalisedResults?: number;
      } | null;
      if (!response.ok) {
        onDone(result?.error ?? "The scores could not be cleared.", true);
        return;
      }
      const votes = result?.audienceVotes ?? 0;
      const scores = result?.judgeScores ?? 0;
      onDone(
        `${actName}: ${votes} audience vote${votes === 1 ? "" : "s"}, ${scores} judge score${scores === 1 ? "" : "s"}${result?.finalisedResults ? " and its finalised result" : ""} cleared. Scoring can start again.`,
        false,
      );
    } catch {
      onDone("The show server could not be reached.", true);
    } finally {
      setBusy(false);
      onClose();
    }
  }

  return (
    <div
      className="act-delete clear-scores"
      role="alertdialog"
      aria-labelledby="clear-scores-title"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div className="act-delete__card">
        <h3 id="clear-scores-title">Clear votes and scores for “{actName}”?</h3>
        <p>
          Every audience vote, every judge score and any finalised result for
          this act are removed, and the act can be scored again from nothing.
          Other acts are untouched. If this is the current act, its voting
          closes and any revealed result is hidden.
        </p>
        <label htmlFor="clear-scores-phrase">
          Type <b>{CLEAR_ACT_SCORES_PHRASE}</b> to confirm
        </label>
        <input
          id="clear-scores-phrase"
          type="text"
          autoComplete="off"
          autoFocus
          value={phrase}
          onChange={(event) => setPhrase(event.target.value)}
        />
        <div className="act-delete__actions">
          <button
            type="button"
            className="danger-action"
            disabled={busy || !confirmed}
            onClick={() => void clear()}
          >
            {busy ? "CLEARING…" : "CLEAR VOTES & SCORES"}
          </button>
          <button type="button" disabled={busy} onClick={onClose}>
            CANCEL
          </button>
        </div>
      </div>
    </div>
  );
}
