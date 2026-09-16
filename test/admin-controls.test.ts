/**
 * A living inventory of the console's interactive controls.
 *
 * It discovers controls from the application source rather than from a
 * hand-written list, so a control added by anybody — in this prompt or another
 * — is covered the moment it exists. What it proves:
 *
 *  - every operator command a control sends is a command the server implements,
 *    so no button can be wired to nothing;
 *  - every command the server implements is reachable from some control, so no
 *    capability is stranded with no way to invoke it;
 *  - every admin endpoint the console calls is a route the coordinator declares;
 *  - no rendered button is inert.
 *
 * The final case prints the inventory for the release report.
 */

import { describe, expect, it } from "vitest";

import type { AdminCommandType } from "../shared/admin-command";

const SOURCES = import.meta.glob("../src/**/*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Every command the coordinator's parser and state machine accept. */
const IMPLEMENTED_COMMANDS: readonly AdminCommandType[] = [
  "SELECT_ACT",
  "NEXT_ACT",
  "PREVIOUS_ACT",
  "SET_DISPLAY_MODE",
  "RESTORE_DISPLAY",
  "OPEN_AUDIENCE_VOTING",
  "CLOSE_AUDIENCE_VOTING",
  "OPEN_ALL_JUDGES",
  "CLOSE_ALL_JUDGES",
  "OPEN_JUDGE",
  "CLOSE_JUDGE",
  "REVEAL_RESULT",
  "HIDE_RESULT",
  "FINALISE_RESULT",
  "PREPARE_CUE",
  "PLAY_CUE",
  "PAUSE_MEDIA",
  "RESUME_MEDIA",
  "STOP_MEDIA",
  "STOP_ALL_MEDIA",
  "RESTART_MEDIA",
  "REPLAY_MEDIA",
  "SEEK_MEDIA",
  "NEXT_CUE",
  "PREVIOUS_CUE",
  "BLACK_SCREEN",
  "SET_INTERMISSION_MESSAGE",
  "SET_EMERGENCY_MESSAGE",
  "ACTIVATE_EMERGENCY",
  "SET_RESULTS_STAGE",
  "REVEAL_NEXT_RESULT",
  "RESET_RESULTS_REVEAL",
  "WITHDRAW_ACT",
  "REINSTATE_ACT",
  "ADVANCE_SHOW",
  "SET_SHOW_STEP",
];

/** Admin and public routes the coordinator declares in its `fetch`. */
const ROUTED_ENDPOINTS: readonly string[] = [
  "/api/admin/session",
  "/api/admin/login",
  "/api/admin/logout",
  "/api/admin/command",
  "/api/admin/preflight",
  "/api/admin/history",
  "/api/admin/fonts",
  "/api/admin/show",
  "/api/admin/scoring-config",
  "/api/admin/scoring/reset",
  "/api/admin/judges",
  "/api/admin/acts",
  "/api/admin/cues",
  "/api/admin/media",
  "/api/admin/projector",
  "/api/admin/test-show",
  "/api/admin/diagnostics",
  "/api/projector/session",
  "/api/projector/pair",
  "/api/public/config",
  "/api/public/media/",
  "/api/vote",
  "/api/health",
  "/api/font/",
];

interface Discovered {
  value: string;
  surface: string;
}

function surfaceName(path: string): string {
  return path.replace(/^\.\.\//u, "");
}

/**
 * `send` is the console's dispatcher; the media console wraps it in `run` so it
 * can refuse a second command while one is unacknowledged. Both are controls.
 */
const COMMAND_CALL = /(?:send|run)\(\s*"([A-Z_]+)"/gu;
const FETCH_CALL = /fetch\(\s*[`"](\/api\/[^`"$?]*)/gu;

function discover(pattern: RegExp): Discovered[] {
  const found: Discovered[] = [];
  for (const [path, source] of Object.entries(SOURCES)) {
    for (const match of source.matchAll(pattern)) {
      found.push({ value: match[1] ?? "", surface: surfaceName(path) });
    }
  }
  return found;
}

/**
 * The attribute text of every `<button>` in a source file. A plain regex stops
 * at the first `>`, which in JSX is frequently inside an expression such as
 * `disabled={a >= b}` — so this walks the tag tracking quotes and brace depth.
 */
function buttonAttributes(source: string): string[] {
  const tags: string[] = [];
  const opener = /<button[\s>]/gu;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source)) !== null) {
    const from = match.index + "<button".length;
    let depth = 0;
    let quote: string | null = null;
    for (let index = from; index < source.length; index += 1) {
      const character = source[index]!;
      if (quote !== null) {
        if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'") quote = character;
      else if (character === "{") depth += 1;
      else if (character === "}") depth -= 1;
      else if (character === ">" && depth === 0) {
        tags.push(source.slice(from, index));
        break;
      }
    }
  }
  return tags;
}

describe("admin control inventory", () => {
  const commands = discover(COMMAND_CALL);

  it("discovers the console's controls from the application itself", () => {
    // Guards against the discovery silently finding nothing — a renamed helper
    // or a moved directory — and every case below passing vacuously.
    expect(
      Object.keys(SOURCES).length,
      "no component sources were discovered",
    ).toBeGreaterThan(5);
    expect(
      commands.length,
      `found: ${[...new Set(commands.map((entry) => entry.value))].join(", ")}`,
    ).toBeGreaterThan(20);
  });

  it("wires every control to a command the server implements", () => {
    const implemented = new Set<string>(IMPLEMENTED_COMMANDS);
    const dead = commands.filter((entry) => !implemented.has(entry.value));
    expect(
      dead.map((entry) => `${entry.value} (${entry.surface})`),
      "controls sending commands the server does not implement",
    ).toEqual([]);
  });

  it("leaves no server command unreachable from the console", () => {
    const reachable = new Set(commands.map((entry) => entry.value));
    expect(
      IMPLEMENTED_COMMANDS.filter((command) => !reachable.has(command)),
      "commands the server implements that no control invokes",
    ).toEqual([]);
  });

  it("calls only endpoints the coordinator routes", () => {
    const unknown = discover(FETCH_CALL).filter(
      (entry) =>
        !ROUTED_ENDPOINTS.some((route) => entry.value.startsWith(route)),
    );
    expect(
      unknown.map((entry) => `${entry.value} (${entry.surface})`),
      "endpoints called from the UI with no coordinator route",
    ).toEqual([]);
  });

  it("renders no inert button", () => {
    // A `<button>` with neither a handler nor a submit role looks live and does
    // nothing — exactly what must not ship.
    const inert: string[] = [];
    for (const [path, source] of Object.entries(SOURCES)) {
      for (const attributes of buttonAttributes(source)) {
        const live =
          attributes.includes("onClick") ||
          attributes.includes("onPointerUp") ||
          attributes.includes('type="submit"');
        if (!live)
          inert.push(
            `${surfaceName(path)}: <button ${attributes.replace(/\s+/gu, " ").trim().slice(0, 60)}>`,
          );
      }
    }
    expect(inert, "buttons with no action").toEqual([]);
  });

  it("prints the inventory for the release report", () => {
    const byCommand = new Map<string, Set<string>>();
    for (const entry of commands) {
      const surfaces = byCommand.get(entry.value) ?? new Set<string>();
      surfaces.add(entry.surface);
      byCommand.set(entry.value, surfaces);
    }
    const lines = [...byCommand.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([command, surfaces]) =>
          `  ${command.padEnd(26)} ${[...surfaces].join(", ")}`,
      );
    console.log(
      `\nADMIN CONTROL INVENTORY — ${byCommand.size} commands across ${
        new Set(commands.map((entry) => entry.surface)).size
      } surfaces\n${lines.join("\n")}`,
    );
    expect(byCommand.size).toBe(IMPLEMENTED_COMMANDS.length);
  });
});
