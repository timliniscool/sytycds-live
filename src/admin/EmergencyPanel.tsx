import { useEffect, useState } from "react";

import type { AdminCommandType } from "../../shared/admin-command";
import type { DisplayMode, EmergencyPresentation } from "../../shared/domain";

/** An armed emergency control disarms itself if the second press never comes. */
const ARM_WINDOW_MS = 10_000;

export interface EmergencyPanelProps {
  displayMode: DisplayMode;
  previousDisplayMode: DisplayMode | null;
  presentation: EmergencyPresentation;
  send(type: AdminCommandType, extras?: Record<string, unknown>): string | null;
}

/**
 * Two deliberate presses activate an emergency, and the second press is a
 * large, unambiguous button rather than a browser confirm dialog. Leaving is
 * one press, because getting back to the show is never the dangerous action.
 */
export function EmergencyPanel({
  displayMode,
  previousDisplayMode,
  presentation,
  send,
}: EmergencyPanelProps) {
  const [armed, setArmed] = useState(false);
  const active = displayMode === "EMERGENCY";
  const held = displayMode === "HOLD";

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), ARM_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  useEffect(() => {
    if (active) setArmed(false);
  }, [active]);

  return (
    <section
      className={`emergency-panel${active ? " emergency-panel--active" : ""}`}
      aria-label="Emergency and hold"
    >
      <div className="emergency-panel__head">
        <p>OVERRIDE</p>
        <h2>
          {active
            ? `EMERGENCY · ${presentation}`
            : held
              ? "HOLD"
              : "Normal output"}
        </h2>
        <span>
          {active || held
            ? `Return restores ${previousDisplayMode?.replaceAll("_", " ") ?? "the previous display"}.`
            : "Emergency takes two presses. Hold takes one."}
        </span>
      </div>

      {!active && !armed && (
        <div className="emergency-panel__row">
          <button
            type="button"
            className="emergency-panel__arm"
            onClick={() => setArmed(true)}
          >
            ARM EMERGENCY
          </button>
          <button
            type="button"
            disabled={held}
            onClick={() => send("SET_DISPLAY_MODE", { mode: "HOLD" })}
          >
            HOLD · PLEASE STAND BY
          </button>
          {held && (
            <button
              type="button"
              className="emergency-panel__return"
              onClick={() => send("RESTORE_DISPLAY")}
            >
              RETURN TO SHOW
            </button>
          )}
        </div>
      )}

      {!active && armed && (
        <div className="emergency-panel__row emergency-panel__row--armed">
          <button
            type="button"
            className="emergency-panel__fire"
            onClick={() =>
              send("ACTIVATE_EMERGENCY", { presentation: "BLACK" })
            }
          >
            BLACK SCREEN NOW
          </button>
          <button
            type="button"
            className="emergency-panel__fire"
            onClick={() => send("ACTIVATE_EMERGENCY", { presentation: "TEXT" })}
          >
            EMERGENCY TEXT NOW
          </button>
          <button type="button" onClick={() => setArmed(false)}>
            CANCEL
          </button>
        </div>
      )}

      {active && (
        <div className="emergency-panel__row">
          <button
            type="button"
            className={presentation === "BLACK" ? "is-active" : ""}
            onClick={() =>
              send("ACTIVATE_EMERGENCY", { presentation: "BLACK" })
            }
          >
            BLACK
          </button>
          <button
            type="button"
            className={presentation === "TEXT" ? "is-active" : ""}
            onClick={() => send("ACTIVATE_EMERGENCY", { presentation: "TEXT" })}
          >
            TEXT
          </button>
          <button
            type="button"
            className="emergency-panel__return"
            onClick={() => send("RESTORE_DISPLAY")}
          >
            RETURN TO SHOW
          </button>
        </div>
      )}
    </section>
  );
}
