import { describe, expect, it } from "vitest";

import { actId, type PublicAct } from "../shared/domain";
import { publicResultsFor, rankActs, rankGroups } from "../shared/ranking";

function act(id: string, order: number, withdrawn = false): PublicAct {
  return {
    id: actId(id),
    order,
    performerName: `Performer ${id}`,
    schoolYear: "Year 10",
    actName: `Act ${id}`,
    actType: "Music",
    publicDescription: "",
    withdrawn,
  };
}

describe("completed-show ranking", () => {
  it("ranks frozen scores densely and marks exact ties", () => {
    const ranking = rankActs([
      { act: act("a", 0), finalScore: 7.5 },
      { act: act("b", 1), finalScore: 9.25 },
      { act: act("c", 2), finalScore: 7.5 },
      { act: act("d", 3), finalScore: 6 },
    ]);
    // Dense: the score after a tie takes the very next rank number, never 4.
    expect(
      ranking.ranked.map((entry) => [entry.actId, entry.rank, entry.tied]),
    ).toEqual([
      ["b", 1, false],
      ["a", 2, true],
      ["c", 2, true],
      ["d", 3, false],
    ]);
  });

  it("gives two first places a second and a third behind them", () => {
    const ranking = rankActs([
      { act: act("alice", 0), finalScore: 9.8 },
      { act: act("bob", 1), finalScore: 9.8 },
      { act: act("charlie", 2), finalScore: 9.5 },
      { act: act("david", 3), finalScore: 9.2 },
    ]);
    expect(ranking.ranked.map((entry) => [entry.actId, entry.rank])).toEqual([
      ["alice", 1],
      ["bob", 1],
      ["charlie", 2],
      ["david", 3],
    ]);
  });

  it("gives two second places a first above and a third below", () => {
    const ranking = rankActs([
      { act: act("alice", 0), finalScore: 9.9 },
      { act: act("bob", 1), finalScore: 9.6 },
      { act: act("charlie", 2), finalScore: 9.6 },
      { act: act("david", 3), finalScore: 9.3 },
    ]);
    expect(ranking.ranked.map((entry) => [entry.actId, entry.rank])).toEqual([
      ["alice", 1],
      ["bob", 2],
      ["charlie", 2],
      ["david", 3],
    ]);
  });

  it("puts five tied entrants in first and the next distinct score in second", () => {
    const ranking = rankActs([
      ...Array.from({ length: 5 }, (_, index) => ({
        act: act(`tied-${index}`, index),
        finalScore: 8.4,
      })),
      { act: act("next", 5), finalScore: 8.3 },
    ]);
    expect(ranking.ranked.filter((entry) => entry.rank === 1)).toHaveLength(5);
    expect(ranking.ranked.at(-1)).toMatchObject({ actId: "next", rank: 2 });
    expect(rankGroups(ranking.ranked)).toEqual([1, 2]);
  });

  it("compares stored values, never the rounded display string", () => {
    const ranking = rankActs([
      { act: act("a", 0), finalScore: 8.004 },
      { act: act("b", 1), finalScore: 8.0044 },
    ]);
    // Both read "8.00" on the projector; they are still two distinct ranks.
    expect(ranking.ranked.map((entry) => entry.finalScore.toFixed(2))).toEqual([
      "8.00",
      "8.00",
    ]);
    expect(ranking.ranked.map((entry) => entry.rank)).toEqual([1, 2]);
    expect(ranking.ranked.some((entry) => entry.tied)).toBe(false);
  });

  it("is deterministic: tied acts keep running order and never get an invented winner", () => {
    const first = rankActs([
      { act: act("late", 5), finalScore: 8 },
      { act: act("early", 1), finalScore: 8 },
    ]);
    const second = rankActs([
      { act: act("early", 1), finalScore: 8 },
      { act: act("late", 5), finalScore: 8 },
    ]);
    expect(first).toEqual(second);
    expect(first.ranked.map((entry) => entry.actId)).toEqual(["early", "late"]);
    expect(first.ranked.every((entry) => entry.rank === 1 && entry.tied)).toBe(
      true,
    );
  });

  it("does not treat nearly equal stored values as a tie", () => {
    const ranking = rankActs([
      { act: act("a", 0), finalScore: 8.000001 },
      { act: act("b", 1), finalScore: 8 },
    ]);
    expect(ranking.ranked.map((entry) => entry.rank)).toEqual([1, 2]);
    expect(ranking.ranked.some((entry) => entry.tied)).toBe(false);
  });

  it("separates incomplete and withdrawn acts from the ranking", () => {
    const ranking = rankActs([
      { act: act("a", 0), finalScore: 5 },
      { act: act("b", 1), finalScore: null },
      { act: act("c", 2, true), finalScore: 9 },
      { act: act("d", 3, true), finalScore: null },
    ]);
    expect(ranking.ranked.map((entry) => entry.actId)).toEqual(["a"]);
    expect(ranking.incomplete.map((entry) => entry.act.id)).toEqual(["b"]);
    expect(ranking.incomplete[0]?.reason).toBe("NOT_FINALISED");
    expect(ranking.withdrawn.map((entry) => entry.id)).toEqual(["c", "d"]);
  });

  it("represents no eligible acts as an empty ranking", () => {
    const ranking = rankActs([{ act: act("a", 0), finalScore: null }]);
    expect(ranking.ranked).toEqual([]);
    expect(publicResultsFor(ranking.ranked, "LEADERBOARD", 0)).toEqual({
      stage: "LEADERBOARD",
      entries: [],
      pendingGroups: 0,
      totalGroups: 0,
    });
  });
});

describe("public results projection", () => {
  const ranked = rankActs([
    { act: act("a", 0), finalScore: 9 },
    { act: act("b", 1), finalScore: 8 },
    { act: act("c", 2), finalScore: 8 },
    { act: act("d", 3), finalScore: 7 },
    { act: act("e", 4), finalScore: 6 },
  ]).ranked;

  it("exposes nothing while hidden", () => {
    expect(publicResultsFor(ranked, "HIDDEN", 3)).toBeNull();
  });

  it("reveals staged results from last place upwards, a tie group at a time", () => {
    expect(rankGroups(ranked)).toEqual([1, 2, 3, 4]);
    const none = publicResultsFor(ranked, "STAGED", 0);
    expect(none?.entries).toEqual([]);
    expect(none?.pendingGroups).toBe(4);
    const two = publicResultsFor(ranked, "STAGED", 2);
    expect(two?.entries.map((entry) => entry.actId)).toEqual(["d", "e"]);
    const three = publicResultsFor(ranked, "STAGED", 3);
    expect(three?.entries.map((entry) => entry.actId)).toEqual([
      "b",
      "c",
      "d",
      "e",
    ]);
    expect(three?.pendingGroups).toBe(1);
    expect(publicResultsFor(ranked, "STAGED", 99)?.pendingGroups).toBe(0);
  });

  it("keeps every tied act inside top three and winner cuts", () => {
    // The podium is the top three rank numbers, so a joint second still leaves
    // room for a third: four acts stand on a three-place podium.
    expect(
      publicResultsFor(ranked, "TOP_THREE", 0)?.entries.map(
        (entry) => entry.actId,
      ),
    ).toEqual(["a", "b", "c", "d"]);
    expect(
      publicResultsFor(ranked, "WINNER", 0)?.entries.map(
        (entry) => entry.actId,
      ),
    ).toEqual(["a"]);
    const jointWinners = rankActs([
      { act: act("x", 0), finalScore: 9 },
      { act: act("y", 1), finalScore: 9 },
    ]).ranked;
    expect(publicResultsFor(jointWinners, "WINNER", 0)?.entries).toHaveLength(
      2,
    );
  });
});
