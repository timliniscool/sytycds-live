import { useEffect, useRef, useState } from "react";

import type {
  AudienceAggregate,
  PublicAct,
  ScoreboardJudge,
} from "../../shared/domain";
import {
  audienceReadout,
  formatScore,
  judgeTile,
  stepTowards,
} from "./scoreboard-view";

const AUDIENCE_TWEEN_MS = 450;
const REVEAL_COUNT_MS = 1_400;

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Paints intermediate digits between the previous and current authoritative
 * value. The value itself is never altered: the effect only decides what is on
 * screen for the next few hundred milliseconds.
 */
function useTweenedNumber(
  target: number | null,
  durationMs: number,
): number | null {
  const [displayed, setDisplayed] = useState<number | null>(target);
  const displayedRef = useRef<number | null>(target);

  useEffect(() => {
    if (target === null || displayedRef.current === null || reducedMotion()) {
      displayedRef.current = target;
      setDisplayed(target);
      return;
    }
    const from = displayedRef.current;
    const started = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const value = stepTowards(from, target, now - started, durationMs);
      displayedRef.current = value;
      setDisplayed(value);
      if (value !== target) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs]);

  return displayed;
}

export function ScoreboardGraphic({
  act,
  judges,
  aggregate,
  revealedResult,
}: {
  act: PublicAct | null;
  judges: readonly ScoreboardJudge[];
  aggregate: AudienceAggregate | null;
  revealedResult: number | null;
}) {
  const audience = audienceReadout(aggregate);
  const tweened = useTweenedNumber(
    audience.hasVotes ? (aggregate?.weightedMean ?? null) : null,
    AUDIENCE_TWEEN_MS,
  );
  const tiles = [...judges]
    .sort((left, right) => left.slot - right.slot)
    .map(judgeTile);

  return (
    <section className="stage scoreboard" key={act?.id ?? "scoreboard"}>
      <header className="scoreboard__act">
        <p className="stage__kicker">Scores</p>
        <h1 className="scoreboard__performer">
          {act?.performerName ?? "Stand by"}
        </h1>
        {act && <p className="scoreboard__name">{act.actName}</p>}
      </header>

      <div className="scoreboard__panels">
        <div className="scoreboard__audience">
          <p className="scoreboard__label">Audience</p>
          <p
            className={`scoreboard__big${tweened === null ? " scoreboard__big--empty" : ""}`}
            aria-live="off"
          >
            {tweened === null ? "–" : formatScore(tweened)}
          </p>
          <p className="scoreboard__count">
            {audience.hasVotes
              ? `${audience.count} vote${audience.count === 1 ? "" : "s"}`
              : "No votes yet"}
          </p>
        </div>

        {/*
          The column count comes from the panel itself, so one to four judges
          share a row and five to eight fall into two even rows. Leaving it to
          `auto-fit` made the track width depend on the longest judge name,
          which is how four judges ended up on three columns.
        */}
        <ul
          className="scoreboard__judges"
          style={{
            gridTemplateColumns: `repeat(${Math.min(Math.max(tiles.length, 1), 4)}, minmax(0, 1fr))`,
          }}
        >
          {tiles.map((tile, index) => (
            <li
              key={index}
              className={`scoreboard__judge${tile.waiting ? " scoreboard__judge--waiting" : ""}`}
            >
              <p className="scoreboard__label">{tile.name}</p>
              <p className="scoreboard__value">{tile.primary}</p>
              <p className="scoreboard__secondary">{tile.secondary ?? " "}</p>
            </li>
          ))}
        </ul>
      </div>

      <FinalPanel value={revealedResult} />
    </section>
  );
}

/**
 * Before the reveal the panel holds a dash and, crucially, no number exists
 * anywhere in this client. On reveal the digits count up once and settle.
 */
function FinalPanel({ value }: { value: number | null }) {
  const [shown, setShown] = useState<number | null>(value);
  const [revealing, setRevealing] = useState(false);

  useEffect(() => {
    if (value === null) {
      setShown(null);
      setRevealing(false);
      return;
    }
    if (reducedMotion()) {
      setShown(value);
      setRevealing(true);
      return;
    }
    setRevealing(true);
    const started = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const next = stepTowards(0, value, now - started, REVEAL_COUNT_MS);
      setShown(next);
      if (next !== value) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value]);

  return (
    <footer
      className={`scoreboard__final${revealing ? " scoreboard__final--revealed" : ""}`}
    >
      <p className="scoreboard__label">Final score</p>
      <p
        className={`scoreboard__final-value${shown === null ? " scoreboard__final-value--empty" : ""}`}
      >
        {shown === null ? "–" : formatScore(shown)}
      </p>
    </footer>
  );
}
