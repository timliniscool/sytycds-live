import { useState } from "react";

import type { AdminCommandType } from "../../shared/admin-command";
import type {
  AdminRanking,
  DisplayMode,
  ResultsStage,
} from "../../shared/domain";
import { rankGroups } from "../../shared/ranking";
import { ClearActScoresDialog } from "./ClearActScores";
import { exclusionLabel, whyNothingIsEligible } from "./results-view";

export interface ResultsPanelProps {
  ranking: AdminRanking;
  stage: ResultsStage;
  revealedGroups: number;
  displayMode: DisplayMode;
  activeActId: string | null;
  send(type: AdminCommandType, extras?: Record<string, unknown>): string | null;
}

const STAGES: readonly { stage: ResultsStage; label: string }[] = [
  { stage: "HIDDEN", label: "HIDDEN" },
  { stage: "LEADERBOARD", label: "LEADERBOARD" },
  { stage: "STAGED", label: "STAGED REVEAL" },
  { stage: "TOP_THREE", label: "TOP THREE" },
  { stage: "WINNER", label: "WINNER" },
];

/**
 * The operator always sees the whole ranking; the public sees only what the
 * stage allows, and that boundary is enforced in the server projection, not
 * by this panel.
 */
export function ResultsPanel({
  ranking,
  stage,
  revealedGroups,
  displayMode,
  activeActId,
  send,
}: ResultsPanelProps) {
  const groups = rankGroups(ranking.ranked);
  const [clearing, setClearing] = useState<{
    actId: string;
    actName: string;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const onScreen = displayMode === "FINAL_RESULTS";
  const nothingRanked = ranking.ranked.length === 0;
  // A disabled control that says nothing is the worst thing to meet mid-show,
  // so when the ranking is empty the panel states the reason and the next
  // action instead of leaving the operator to infer it from the table below.
  const blocked = nothingRanked ? whyNothingIsEligible(ranking) : null;

  return (
    <section className="results-panel" aria-labelledby="results-title">
      <div className="region-title">
        <p>FINAL RESULTS</p>
        <h2 id="results-title">
          {nothingRanked
            ? "No finalised results"
            : `${ranking.ranked.length} ranked · public stage ${stage.replaceAll("_", " ")}`}
        </h2>
        <span>
          {blocked ??
            (onScreen
              ? "The projector is on FINAL RESULTS."
              : "The projector is not showing results; the stage only applies once it is.")}
        </span>
      </div>

      <div className="results-panel__stage">
        {STAGES.map((entry) => (
          <button
            key={entry.stage}
            type="button"
            className={stage === entry.stage ? "is-active" : ""}
            aria-pressed={stage === entry.stage}
            disabled={entry.stage !== "HIDDEN" && nothingRanked}
            {...(entry.stage !== "HIDDEN" && blocked ? { title: blocked } : {})}
            onClick={() => send("SET_RESULTS_STAGE", { stage: entry.stage })}
          >
            {entry.label}
          </button>
        ))}
        {!onScreen && (
          <button
            type="button"
            className="results-panel__show"
            // An empty results board in front of an audience is worse than no
            // results board, so this stays shut until something can be shown.
            disabled={nothingRanked}
            {...(blocked ? { title: blocked } : {})}
            onClick={() => send("SET_DISPLAY_MODE", { mode: "FINAL_RESULTS" })}
          >
            PUT FINAL RESULTS ON PROJECTOR
          </button>
        )}
      </div>

      {stage === "STAGED" && (
        <div className="results-panel__staged">
          <span>
            Revealed {Math.min(revealedGroups, groups.length)} of{" "}
            {groups.length} place{groups.length === 1 ? "" : "s"}, from last
            upwards
          </span>
          <button
            type="button"
            className="results-panel__next"
            disabled={revealedGroups >= groups.length}
            onClick={() => send("REVEAL_NEXT_RESULT")}
          >
            REVEAL NEXT PLACE
          </button>
          <button
            type="button"
            disabled={revealedGroups === 0}
            onClick={() => send("RESET_RESULTS_REVEAL")}
          >
            RESET
          </button>
        </div>
      )}

      <table className="results-table">
        <thead>
          <tr>
            <th scope="col">Rank</th>
            <th scope="col">Act</th>
            <th scope="col">Final</th>
            <th scope="col">Public</th>
            <th scope="col" />
          </tr>
        </thead>
        <tbody>
          {ranking.ranked.map((entry) => {
            const groupIndex = groups.indexOf(entry.rank);
            const revealed =
              stage === "LEADERBOARD" ||
              (stage === "STAGED" &&
                groupIndex >= groups.length - revealedGroups) ||
              (stage === "TOP_THREE" && entry.rank <= 3) ||
              (stage === "WINNER" && entry.rank === 1);
            return (
              <tr key={entry.actId}>
                <td>
                  {entry.tied ? "=" : ""}
                  {entry.rank}
                  {entry.tied && <small> tie</small>}
                </td>
                <td>
                  <b>{entry.performerName}</b>
                  <small>{entry.actName}</small>
                </td>
                <td className="results-table__score">
                  {entry.finalScore.toFixed(3)}
                </td>
                <td>{revealed ? "SHOWN" : "hidden"}</td>
                <td className="results-table__actions">
                  <button
                    type="button"
                    onClick={() =>
                      setClearing({
                        actId: entry.actId,
                        actName: entry.actName,
                      })
                    }
                  >
                    CLEAR
                  </button>
                  <button
                    type="button"
                    disabled={entry.actId === activeActId}
                    onClick={() => send("WITHDRAW_ACT", { actId: entry.actId })}
                  >
                    WITHDRAW
                  </button>
                </td>
              </tr>
            );
          })}
          {ranking.incomplete.map(({ act, reason, missingJudgeSlots }) => (
            <tr key={act.id} className="results-table__incomplete">
              <td>—</td>
              <td>
                <b>{act.performerName}</b>
                <small>{act.actName}</small>
              </td>
              <td className="results-table__score">
                {exclusionLabel(reason, missingJudgeSlots)}
              </td>
              <td>never</td>
              <td className="results-table__actions">
                <button
                  type="button"
                  onClick={() =>
                    setClearing({ actId: act.id, actName: act.actName })
                  }
                >
                  CLEAR
                </button>
                <button
                  type="button"
                  disabled={act.id === activeActId}
                  onClick={() => send("WITHDRAW_ACT", { actId: act.id })}
                >
                  WITHDRAW
                </button>
              </td>
            </tr>
          ))}
          {ranking.withdrawn.map((act) => (
            <tr key={act.id} className="results-table__withdrawn">
              <td>W/D</td>
              <td>
                <b>{act.performerName}</b>
                <small>{act.actName}</small>
              </td>
              <td className="results-table__score">withdrawn</td>
              <td>never</td>
              <td>
                <button
                  type="button"
                  onClick={() => send("REINSTATE_ACT", { actId: act.id })}
                >
                  REINSTATE
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {notice && (
        <output className="results-panel__notice" role="status">
          {notice}
        </output>
      )}
      {clearing && (
        <ClearActScoresDialog
          actId={clearing.actId}
          actName={clearing.actName}
          onDone={(message) => setNotice(message)}
          onClose={() => setClearing(null)}
        />
      )}
    </section>
  );
}
