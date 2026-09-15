import { useEffect, useRef, useState } from "react";

import {
  REACTION_IDS,
  type ReactionHistogram,
  type ReactionId,
} from "../../shared/reactions";

const GLYPHS: Readonly<Record<ReactionId, string>> = {
  applause: "👏",
  heart: "♥",
  fire: "🔥",
  laugh: "😂",
  wow: "😮",
};

interface Particle {
  id: number;
  reaction: ReactionId;
  count: number;
  left: number;
  drift: number;
  duration: number;
  scale: number;
}

export interface ReactionLaneProps {
  eventKey: string | number | null;
  histogram: ReactionHistogram | null;
  clearKey?: string | number | null;
  local?: boolean;
}

/**
 * A bounded decorative lane. It renders local taps immediately and sampled
 * hall traffic as a mix of individual particles and compact clusters.
 */
export function ReactionLane({
  eventKey,
  histogram,
  clearKey = null,
  local = false,
}: ReactionLaneProps) {
  const [particles, setParticles] = useState<Particle[]>([]);
  const nextId = useRef(0);

  useEffect(() => {
    if (eventKey === null || !histogram) return;
    const incoming: Particle[] = [];
    histogram.forEach((count, index) => {
      const reaction = REACTION_IDS[index];
      if (!reaction || count < 1) return;
      const individuals = Math.min(count, 3);
      for (let item = 0; item < individuals; item += 1) {
        const id = (nextId.current += 1);
        incoming.push({
          id,
          reaction,
          count: 1,
          left: 7 + ((id * 37 + index * 13) % 87),
          drift: -36 + ((id * 29) % 73),
          duration: local ? 1_650 : 2_500 + ((id * 211) % 1_300),
          scale: 0.86 + ((id * 17) % 42) / 100,
        });
      }
      if (count > individuals) {
        const id = (nextId.current += 1);
        incoming.push({
          id,
          reaction,
          count: count - individuals,
          left: 12 + ((id * 41 + index * 17) % 78),
          drift: -22 + ((id * 31) % 45),
          duration: local ? 1_800 : 3_300,
          scale: 1.1,
        });
      }
    });
    if (incoming.length === 0) return;
    setParticles((current) =>
      [...current, ...incoming].slice(local ? -24 : -30),
    );
    const timer = window.setTimeout(
      () => {
        const expired = new Set(incoming.map((particle) => particle.id));
        setParticles((current) =>
          current.filter((particle) => !expired.has(particle.id)),
        );
      },
      Math.max(...incoming.map((particle) => particle.duration)) + 250,
    );
    return () => window.clearTimeout(timer);
  }, [eventKey, histogram, local]);

  useEffect(() => {
    if (clearKey !== null) setParticles([]);
  }, [clearKey]);

  return (
    <div
      className={`reaction-lane${local ? " reaction-lane--local" : ""}`}
      aria-hidden="true"
    >
      {particles.map((particle) => (
        <i
          key={particle.id}
          className={`reaction-particle reaction-particle--${particle.reaction}`}
          style={
            {
              left: `${particle.left}%`,
              "--reaction-drift": `${particle.drift}px`,
              "--reaction-duration": `${particle.duration}ms`,
              "--reaction-scale": String(particle.scale),
            } as React.CSSProperties
          }
        >
          {GLYPHS[particle.reaction]}
          {particle.count > 1 && <b>×{particle.count}</b>}
        </i>
      ))}
    </div>
  );
}

export function reactionGlyph(id: ReactionId): string {
  return GLYPHS[id];
}
