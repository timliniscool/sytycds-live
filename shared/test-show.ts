/**
 * Procedural test shows.
 *
 * Everything here is pure and deterministic: the same seed and scenario always
 * produce the same plan, so a layout or scoring problem found on one machine
 * can be reproduced on another by typing eight characters. The coordinator
 * turns a plan into rows and fixtures; this module never touches storage.
 *
 * All names and copy are synthetic. Nothing is drawn from real people, real
 * schools or any published work.
 */

import type {
  AudienceScore,
  DisplayMode,
  ResultsStage,
  ShowStep,
} from "./domain";
import type { ThemeId } from "./themes";

export type TestScenarioId =
  | "completed-show"
  | "near-end"
  | "tie-heavy"
  | "incomplete-judge"
  | "mid-show"
  | "media-heavy"
  | "heavy-audience"
  | "early-show"
  | "sparse-audience"
  | "mostly-default-performance"
  | "long-text"
  | "edge-scoring"
  | "broken-media";

export interface TestScenario {
  id: TestScenarioId;
  label: string;
  /** Relative frequency when the seed chooses the scenario. */
  weight: number;
  /** Which part of an evening it exercises; late phases test more. */
  phase: "end" | "mid" | "early";
}

/**
 * Roughly 60% near or at the end of the show, 25% mid-show and 15% early or
 * edge cases, because a completed show exercises rankings, ties, reveals and
 * final results, which is where most of the presentation logic lives.
 */
export const TEST_SCENARIOS: readonly TestScenario[] = [
  { id: "completed-show", label: "Completed show", weight: 20, phase: "end" },
  { id: "near-end", label: "Near end of show", weight: 20, phase: "end" },
  {
    id: "tie-heavy",
    label: "End of show / tie-heavy",
    weight: 12,
    phase: "end",
  },
  {
    id: "incomplete-judge",
    label: "Near end / one judge has not scored",
    weight: 8,
    phase: "end",
  },
  { id: "mid-show", label: "Mid-show", weight: 13, phase: "mid" },
  {
    id: "media-heavy",
    label: "Mid-show / media-heavy",
    weight: 6,
    phase: "mid",
  },
  {
    id: "heavy-audience",
    label: "Mid-show / heavy audience",
    weight: 6,
    phase: "mid",
  },
  { id: "early-show", label: "Early show", weight: 5, phase: "early" },
  {
    id: "sparse-audience",
    label: "Early show / sparse audience",
    weight: 3,
    phase: "early",
  },
  {
    id: "mostly-default-performance",
    label: "Mostly default performance screens",
    weight: 3,
    phase: "early",
  },
  {
    id: "long-text",
    label: "Long text / layout stress",
    weight: 2,
    phase: "early",
  },
  {
    id: "edge-scoring",
    label: "Edge scoring inputs",
    weight: 1,
    phase: "early",
  },
  {
    id: "broken-media",
    label: "Broken media / readiness failure",
    weight: 1,
    phase: "early",
  },
];

export function isTestScenarioId(value: unknown): value is TestScenarioId {
  return (
    typeof value === "string" &&
    TEST_SCENARIOS.some((scenario) => scenario.id === value)
  );
}

export function scenarioLabel(id: string): string {
  return TEST_SCENARIOS.find((scenario) => scenario.id === id)?.label ?? id;
}

const SEED_PATTERN = /^[0-9A-F]{8}$/u;

export function isTestSeed(value: unknown): value is string {
  return typeof value === "string" && SEED_PATTERN.test(value);
}

/** Eight uppercase hex characters from a caller-supplied random source. */
export function createTestSeed(random: () => number = Math.random): string {
  let seed = "";
  for (let index = 0; index < 8; index += 1) {
    seed += "0123456789ABCDEF"[Math.floor(random() * 16) % 16];
  }
  return seed;
}

/** mulberry32: small, fast and good enough for fixtures. */
export function seededRandom(seed: string): () => number {
  let state = Number.parseInt(seed, 16) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function chooseScenario(random: () => number): TestScenario {
  const total = TEST_SCENARIOS.reduce(
    (sum, scenario) => sum + scenario.weight,
    0,
  );
  let roll = random() * total;
  for (const scenario of TEST_SCENARIOS) {
    roll -= scenario.weight;
    if (roll < 0) return scenario;
  }
  return TEST_SCENARIOS[0]!;
}

export interface TestActMediaPlan {
  image: boolean;
  audio: boolean;
  /** An asset row whose object is deliberately missing from storage. */
  brokenImage: boolean;
}

export interface TestActPlan {
  actName: string;
  performerName: string;
  schoolYear: string;
  actType: string;
  publicDescription: string;
  internalNotes: string;
  showDescriptionToAudience: boolean;
  showImageToAudience: boolean;
  media: TestActMediaPlan;
  performanceVisual: "AUTOMATIC" | "IMAGE";
  backingAudioStart: "MANUAL" | "PERFORMANCE";
  themeId: ThemeId | null;
  /** One entry per accepted audience vote. */
  audienceScores: readonly AudienceScore[];
  /** One entry per judge slot; null when that judge has not scored. */
  judgeScores: readonly (string | null)[];
  finalised: boolean;
  withdrawn: boolean;
}

export interface TestShowPlan {
  seed: string;
  scenario: TestScenarioId;
  scenarioLabel: string;
  judgeNames: readonly string[];
  audienceWeight: number;
  acts: readonly TestActPlan[];
  currentActIndex: number | null;
  displayMode: DisplayMode;
  flowStep: ShowStep | null;
  votingOpen: boolean;
  resultsStage: ResultsStage;
}

const FIRST_NAMES = [
  "Ari",
  "Bex",
  "Cass",
  "Dev",
  "Elin",
  "Fen",
  "Gus",
  "Hana",
  "Ines",
  "Jory",
  "Kai",
  "Lou",
  "Mika",
  "Nell",
  "Oren",
  "Pia",
  "Quin",
  "Ren",
  "Sol",
  "Tam",
  "Uli",
  "Vic",
  "Wren",
  "Yara",
  "Zeph",
];
const SURNAMES = [
  "Ashby",
  "Brooke",
  "Cardew",
  "Dunmore",
  "Ellery",
  "Fairlie",
  "Garnet",
  "Hollis",
  "Ivory",
  "Jessop",
  "Kestrel",
  "Lark",
  "Marlow",
  "Norris",
  "Oakes",
  "Pell",
  "Quarry",
  "Rowan",
  "Sable",
  "Thorne",
];
const GROUP_WORDS = [
  "Collective",
  "Quartet",
  "Crew",
  "Ensemble",
  "Duo",
  "Company",
];
const ACT_ADJECTIVES = [
  "Midnight",
  "Paper",
  "Electric",
  "Quiet",
  "Velvet",
  "Copper",
  "Restless",
  "Amber",
  "Hollow",
  "Sudden",
  "Feather",
  "Granite",
];
const ACT_NOUNS = [
  "Orbit",
  "Lanterns",
  "Static",
  "Tide",
  "Meridian",
  "Parade",
  "Echo",
  "Compass",
  "Fable",
  "Signal",
  "Harbour",
  "Cartwheel",
];
const ACT_TYPES = [
  "Dance",
  "Vocal",
  "Band",
  "Comedy",
  "Magic",
  "Spoken word",
  "Piano",
  "Drumline",
  "Beatbox",
  "Acrobatics",
];
const YEARS = [
  "Year 7",
  "Year 8",
  "Year 9",
  "Year 10",
  "Year 11",
  "Year 12",
  "Year 13",
  "Staff",
];
const THEMES: readonly ThemeId[] = [
  "gold-white",
  "electric-cyan",
  "crimson",
  "emerald",
  "royal-violet",
  "monochrome",
];
const DESCRIPTION_PARTS = [
  "An original piece",
  "A reworking of a school favourite",
  "Three friends, one microphone",
  "Rehearsed entirely in the lunch queue",
  "Contains one deliberate mistake",
  "Features a costume change",
  "Begins in silence",
  "Ends with the whole hall on its feet, ideally",
];

function pick<Value>(random: () => number, values: readonly Value[]): Value {
  return values[Math.floor(random() * values.length) % values.length]!;
}

function between(random: () => number, low: number, high: number): number {
  return low + Math.floor(random() * (high - low + 1));
}

function performerName(random: () => number, group: boolean): string {
  if (group) {
    return `The ${pick(random, ACT_ADJECTIVES)} ${pick(random, GROUP_WORDS)}`;
  }
  return `${pick(random, FIRST_NAMES)} ${pick(random, SURNAMES)}`;
}

function actName(random: () => number): string {
  return `${pick(random, ACT_ADJECTIVES)} ${pick(random, ACT_NOUNS)}`;
}

function description(random: () => number, long: boolean): string {
  const count = long ? between(random, 5, 8) : between(random, 0, 2);
  const parts: string[] = [];
  for (let index = 0; index < count; index += 1)
    parts.push(pick(random, DESCRIPTION_PARTS));
  return parts.length === 0 ? "" : `${parts.join(". ")}.`;
}

/** A plausible audience: most scores cluster, a few sit at the extremes. */
function audienceScores(random: () => number, count: number): AudienceScore[] {
  const centre = between(random, 4, 9);
  const scores: AudienceScore[] = [];
  for (let index = 0; index < count; index += 1) {
    const spread = Math.round((random() - 0.5) * 6);
    const score = Math.min(10, Math.max(0, centre + spread)) as AudienceScore;
    scores.push(score);
  }
  return scores;
}

function judgeScore(random: () => number, edge: boolean): string {
  if (edge) {
    return pick(random, [
      "Infinity",
      "-inf",
      "20",
      "π",
      "0",
      "10.0",
      "-3",
      "9.999",
      "1e1",
      "7.5",
    ]);
  }
  return (between(random, 40, 100) / 10).toFixed(1);
}

/**
 * Builds the plan. The scenario decides shape (how far through the evening,
 * how many votes, which stress) and the seed decides every individual value.
 */
export function generateTestShowPlan(
  seed: string,
  scenarioId?: TestScenarioId,
): TestShowPlan {
  const random = seededRandom(seed);
  const scenario = scenarioId
    ? TEST_SCENARIOS.find((entry) => entry.id === scenarioId)!
    : chooseScenario(random);
  const id = scenario.id;

  const judgeCount =
    id === "edge-scoring"
      ? 8
      : id === "sparse-audience"
        ? 2
        : between(random, 3, 5);
  const judgeNames = Array.from({ length: judgeCount }, (_, index) =>
    random() < 0.6
      ? `${pick(random, FIRST_NAMES)} ${pick(random, SURNAMES)}`
      : `Judge ${index + 1}`,
  );
  const audienceWeight = id === "edge-scoring" ? 0.25 : 0.5;

  const actCount =
    id === "long-text"
      ? between(random, 14, 20)
      : id === "tie-heavy"
        ? between(random, 8, 12)
        : between(random, 6, 12);

  // How many acts are complete decides where the evening is.
  let finalisedCount: number;
  switch (scenario.phase) {
    case "end":
      finalisedCount =
        id === "completed-show" ? actCount : actCount - between(random, 1, 2);
      break;
    case "mid":
      finalisedCount = Math.floor(actCount / 2);
      break;
    case "early":
      finalisedCount = between(random, 0, 1);
      break;
  }
  finalisedCount = Math.max(0, Math.min(actCount, finalisedCount));

  const votesPerAct = (): number => {
    switch (id) {
      case "heavy-audience":
        return between(random, 400, 900);
      case "sparse-audience":
        return between(random, 0, 5);
      default:
        return between(random, 40, 220);
    }
  };

  const acts: TestActPlan[] = [];
  // Tie-heavy shows reuse one pool of judge scores and one audience so several
  // acts land on identical final scores.
  const tiePool = Array.from({ length: 3 }, () => ({
    judges: judgeNames.map(() => judgeScore(random, false)),
    audience: audienceScores(random, between(random, 60, 120)),
  }));

  for (let index = 0; index < actCount; index += 1) {
    const finalised = index < finalisedCount;
    const current = index === finalisedCount;
    const long = id === "long-text";
    const mediaHeavy = id === "media-heavy";
    const mostlyDefault = id === "mostly-default-performance";
    const hasImage = mediaHeavy
      ? true
      : mostlyDefault
        ? index === 0
        : random() < 0.5;
    const hasAudio = mediaHeavy ? true : mostlyDefault ? false : random() < 0.4;
    const brokenImage = id === "broken-media" && random() < 0.5;
    const tie = id === "tie-heavy" ? tiePool[index % tiePool.length]! : null;

    let judgeScores: (string | null)[];
    if (tie) judgeScores = [...tie.judges];
    else if (finalised)
      judgeScores = judgeNames.map(() =>
        judgeScore(random, id === "edge-scoring"),
      );
    else if (
      current &&
      (id === "incomplete-judge" || scenario.phase !== "early")
    )
      judgeScores = judgeNames.map((_, slot) =>
        id === "incomplete-judge" && slot === judgeCount - 1
          ? null
          : random() < 0.75
            ? judgeScore(random, id === "edge-scoring")
            : null,
      );
    else judgeScores = judgeNames.map(() => null);

    const votes = tie
      ? [...tie.audience]
      : finalised || current
        ? audienceScores(random, votesPerAct())
        : [];

    acts.push({
      actName: long
        ? `${actName(random)} ${actName(random)} ${actName(random)} (Extended Ensemble Version)`
        : actName(random),
      performerName: long
        ? `${performerName(random, true)} featuring ${performerName(random, false)} and ${performerName(random, false)}`
        : performerName(random, random() < 0.3),
      schoolYear: pick(random, YEARS),
      actType: pick(random, ACT_TYPES),
      publicDescription: description(random, long),
      internalNotes: random() < 0.3 ? "Needs two microphones and a stool." : "",
      showDescriptionToAudience: random() < 0.5,
      showImageToAudience: hasImage && random() < 0.5,
      media: { image: hasImage, audio: hasAudio, brokenImage },
      performanceVisual:
        hasImage && (mediaHeavy || random() < 0.4) ? "IMAGE" : "AUTOMATIC",
      backingAudioStart: hasAudio && random() < 0.5 ? "PERFORMANCE" : "MANUAL",
      themeId: random() < 0.15 ? pick(random, THEMES) : null,
      audienceScores: votes,
      judgeScores,
      // A finalised act needs every input; the plan guarantees it.
      finalised: finalised && votes.length > 0,
      withdrawn: !finalised && !current && id === "near-end" && random() < 0.15,
    });
  }

  const currentActIndex =
    finalisedCount >= actCount ? actCount - 1 : finalisedCount;
  let displayMode: DisplayMode;
  let flowStep: ShowStep | null;
  let votingOpen = false;
  let resultsStage: ResultsStage = "HIDDEN";
  switch (id) {
    case "completed-show":
      displayMode = "FINAL_RESULTS";
      flowStep = null;
      resultsStage = pick(random, ["LEADERBOARD", "TOP_THREE", "WINNER"]);
      break;
    case "tie-heavy":
      displayMode = "FINAL_RESULTS";
      flowStep = null;
      resultsStage = "LEADERBOARD";
      break;
    case "early-show":
    case "sparse-audience":
    case "mostly-default-performance":
    case "long-text":
      displayMode = finalisedCount === 0 ? "LOBBY" : "ACT_CARD";
      flowStep = finalisedCount === 0 ? null : "ACT_CARD";
      break;
    default:
      displayMode = pick(random, ["ACT_CARD", "SCOREBOARD"]);
      flowStep = displayMode === "SCOREBOARD" ? "SCOREBOARD" : "SCORING";
      votingOpen = id !== "incomplete-judge" && random() < 0.5;
      break;
  }

  return {
    seed,
    scenario: id,
    scenarioLabel: scenario.label,
    judgeNames,
    audienceWeight,
    acts,
    currentActIndex: actCount === 0 ? null : currentActIndex,
    displayMode,
    flowStep,
    votingOpen,
    resultsStage,
  };
}
