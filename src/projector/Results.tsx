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

function ResultRow({ entry }: { entry: RankingEntry }) {
  return (
    <li className="results__row" key={entry.actId}>
      <span className="results__rank">{rankLabel(entry)}</span>
      <span className="results__who">
        <b>{entry.performerName}</b>
        <small>{entry.actName}</small>
      </span>
      <span className="results__score">{formatScore(entry.finalScore)}</span>
    </li>
  );
}

export function FinalResultsGraphic({
  title,
  results,
}: {
  title: string;
  results: PublicResults | null;
}) {
  if (!results || results.entries.length === 0) {
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
          <ol className="results__list">
            {results.entries.map((entry) => (
              <ResultRow key={entry.actId} entry={entry} />
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

/** Slots fill from last place upwards; the unrevealed ranks stay as outlines. */
function StagedResults({ results }: { results: PublicResults }) {
  const pending = Array.from(
    { length: results.pendingGroups },
    (_, index) => index,
  );
  return (
    <section className="stage results" key="staged">
      <p className="stage__kicker">Final results</p>
      <ol className="results__list">
        {pending.map((index) => (
          <li
            className="results__row results__row--pending"
            key={`pending-${index}`}
          >
            <span className="results__rank">?</span>
            <span className="results__who">
              <b>&nbsp;</b>
            </span>
            <span className="results__score">—</span>
          </li>
        ))}
        {results.entries.map((entry) => (
          <ResultRow key={entry.actId} entry={entry} />
        ))}
      </ol>
    </section>
  );
}

function Podium({ entries }: { entries: readonly RankingEntry[] }) {
  const groups = rankGroups(entries);
  const byRank = (rank: number) =>
    entries.filter((entry) => entry.rank === rank);
  // Second, first, third: the classic podium silhouette. A tie at a rank puts
  // every tied act on that step rather than inventing an order between them.
  const order = [groups[1], groups[0], groups[2]].filter(
    (rank): rank is number => rank !== undefined,
  );
  return (
    <section className="stage podium" key="podium">
      <p className="stage__kicker">Top three</p>
      <div className="podium__steps">
        {order.map((rank) => (
          <div className={`podium__step podium__step--${rank}`} key={rank}>
            <p className="podium__place">{ordinal(rank)}</p>
            {byRank(rank).map((entry) => (
              <div className="podium__entry" key={entry.actId}>
                <b>{entry.performerName}</b>
                <small>{entry.actName}</small>
                <span>{formatScore(entry.finalScore)}</span>
              </div>
            ))}
          </div>
        ))}
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
          <p className="winner__act">{entry.actName}</p>
          <p className="winner__score">{formatScore(entry.finalScore)}</p>
        </div>
      ))}
    </section>
  );
}
