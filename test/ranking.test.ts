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
  it("ranks frozen scores with competition ranking and marks exact ties", () => {
    const ranking = rankActs([
      { act: act("a", 0), finalScore: 7.5 },
      { act: act("b", 1), finalScore: 9.25 },
      { act: act("c", 2), finalScore: 7.5 },
      { act: act("d", 3), finalScore: 6 },
    ]);
    expect(
      ranking.ranked.map((entry) => [entry.actId, entry.rank, entry.tied]),
    ).toEqual([
      ["b", 1, false],
      ["a", 2, true],
      ["c", 2, true],
      ["d", 4, false],
    ]);
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
    expect(ranking.incomplete.map((entry) => entry.id)).toEqual(["b"]);
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
    expect(rankGroups(ranked)).toEqual([1, 2, 4, 5]);
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
    expect(
      publicResultsFor(ranked, "TOP_THREE", 0)?.entries.map(
        (entry) => entry.actId,
      ),
    ).toEqual(["a", "b", "c"]);
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
