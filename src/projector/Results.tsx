import type React from "react";

import type { PublicResults, RankingEntry } from "../../shared/domain";
import { rankGroups } from "../../shared/ranking";
import { HoldingGraphic } from "./ProjectorGraphics";
import { formatScore } from "./scoreboard-view";

function rankLabel(entry: RankingEntry): string {
  return `${entry.tied ? "=" : ""}${entry.rank}`;
}

function ordinal(rank: number): string {
  const suffix =
    rank % 100 >= 11 && rank % 100 <= 13
      ? "th"
      : rank % 10 === 1
        ? "st"
        : rank % 10 === 2
          ? "nd"
          : rank % 10 === 3
            ? "rd"
            : "th";
  return `${rank}${suffix}`;
}

function ResultRow({
  entry,
  dense,
}: {
  entry: RankingEntry;
  /** Above ten rows the member line is dropped so every row keeps two lines. */
  dense: boolean;
}) {
  return (
    <li className="results__row" key={entry.actId}>
      <span className="results__rank">{rankLabel(entry)}</span>
      <span className="results__who">
        <b>{entry.performerName}</b>
        {entry.performerSubtitle && !dense && (
          <em>{entry.performerSubtitle}</em>
        )}
        <small>{entry.actName}</small>
      </span>
      <span className="results__score">{formatScore(entry.finalScore)}</span>
    </li>
  );
}

/** Rows beyond this many drop their third line so the board stays legible. */
const DENSE_ROWS = 10;

export function FinalResultsGraphic({
  title,
  results,
}: {
  title: string;
  results: PublicResults | null;
}) {
  // A staged board with nothing revealed yet is still a board: it shows its
  // empty places. Only a ranking with no finalised act at all holds.
  if (!results || (results.entries.length === 0 && results.totalGroups === 0)) {
    return (
      <HoldingGraphic
        kicker={title}
        headline="Final results"
        {...(results ? { detail: "No act has a final score yet" } : {})}
      />
    );
  }
  switch (results.stage) {
    case "LEADERBOARD":
      return (
        <section className="stage results" key="leaderboard">
          <p className="stage__kicker">Final results</p>
          <ol
            className="results__list"
            style={{ "--rows": results.totalEntries } as React.CSSProperties}
          >
            {results.entries.map((entry) => (
              <ResultRow
                key={entry.actId}
                entry={entry}
                dense={results.totalEntries > DENSE_ROWS}
              />
            ))}
          </ol>
        </section>
      );
    case "STAGED":
      return <StagedResults results={results} />;
    case "TOP_THREE":
      return <Podium entries={results.entries} />;
    case "WINNER":
      return <Winner entries={results.entries} />;
  }
}

/**
 * Slots fill from last place upwards; the unrevealed places stay as outlines.
 * One outline per hidden act, not per hidden rank: the board holds exactly as
 * many rows as the finished leaderboard from the first press to the last, so
 * revealing a three-way tie fills three outlines instead of growing the list
 * and shrinking every row already on screen.
 */
function StagedResults({ results }: { results: PublicResults }) {
  const hidden = Math.max(0, results.totalEntries - results.entries.length);
  const pending = Array.from({ length: hidden }, (_, index) => index);
  return (
    <section className="stage results" key="staged">
      <p className="stage__kicker">Final results</p>
      <ol
        className="results__list"
        style={{ "--rows": results.totalEntries } as React.CSSProperties}
      >
        {pending.map((index) => (
          <li
            className="results__row results__row--pending"
            key={`pending-${index}`}
            aria-label="Place not yet revealed"
          >
            <span className="results__rank">?</span>
            <span className="results__who">
              <b>&nbsp;</b>
              <small>&nbsp;</small>
            </span>
            <span className="results__score">—</span>
          </li>
        ))}
        {results.entries.map((entry) => (
          <ResultRow
            key={entry.actId}
            entry={entry}
            dense={results.totalEntries > DENSE_ROWS}
          />
        ))}
      </ol>
    </section>
  );
}

/**
 * The podium is the top three *rank numbers*, not the top three acts. Under
 * dense ranking two joint firsts still leave a second and a third, so four or
 * more people can stand on a three-step podium — and every one of them appears.
 * A step never truncates its tie group to keep a tidy silhouette.
 */
function Podium({ entries }: { entries: readonly RankingEntry[] }) {
  const groups = rankGroups(entries);
  const byRank = (rank: number) =>
    entries.filter((entry) => entry.rank === rank);
  // Second, first, third: the classic silhouette, with first in the middle.
  const order = [groups[1], groups[0], groups[2]].filter(
    (rank): rank is number => rank !== undefined,
  );
  const widest = Math.max(1, ...order.map((rank) => byRank(rank).length));
  return (
    <section className="stage podium" key="podium">
      <p className="stage__kicker">
        {entries.length > order.length ? "Top three places" : "Top three"}
      </p>
      <div
        className="podium__steps"
        // The whole podium scales to its biggest tie group, so five joint
        // winners shrink the type on every step together rather than one step
        // overflowing the screen.
        style={
          {
            "--members": widest,
            // Two rank groups occupy two steps, not two thirds of a podium.
            gridTemplateColumns: `repeat(${order.length}, minmax(0, 1fr))`,
          } as React.CSSProperties
        }
      >
        {order.map((rank) => {
          const members = byRank(rank);
          return (
            <div className={`podium__step podium__step--${rank}`} key={rank}>
              <p className="podium__place">
                {ordinal(rank)}
                {members.length > 1 && (
                  <em className="podium__shared">{members.length} way tie</em>
                )}
              </p>
              <div
                className={`podium__entries${members.length > 2 ? " podium__entries--dense" : ""}`}
              >
                {members.map((entry) => (
                  <div className="podium__entry" key={entry.actId}>
                    <b>{entry.performerName}</b>
                    {entry.performerSubtitle && (
                      <em>{entry.performerSubtitle}</em>
                    )}
                    <small>{entry.actName}</small>
                    <span>{formatScore(entry.finalScore)}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Winner({ entries }: { entries: readonly RankingEntry[] }) {
  const winners = entries.filter((entry) => entry.rank === 1);
  return (
    <section className="stage winner" key="winner">
      <p className="stage__kicker">
        {winners.length > 1 ? "Joint winners" : "Winner"}
      </p>
      {winners.map((entry) => (
        <div className="winner__entry" key={entry.actId}>
          <h1 className="winner__name">{entry.performerName}</h1>
          {entry.performerSubtitle && (
            <p className="winner__members">{entry.performerSubtitle}</p>
          )}
          <p className="winner__act">{entry.actName}</p>
          <p className="winner__score">{formatScore(entry.finalScore)}</p>
        </div>
      ))}
    </section>
  );
}
