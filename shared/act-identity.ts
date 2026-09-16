import type { Performer, PerformerDisplayMode, PublicAct } from "./domain";

export const MAX_PERFORMERS = 64;
export const PROJECTOR_MEMBER_SEPARATOR = " · ";

export interface ActIdentity {
  /** Strongest performer/group line. The act title remains a separate heading. */
  primary: string;
  /** Optional supporting member list or count. */
  secondary: string | null;
  performerCount: number;
  memberNames: string;
  compact: string;
}

export interface IdentityOptions {
  /** Audience phones can tolerate a longer, wrapping list than a projector. */
  surface?: "projector" | "audience" | "admin";
  /** Used by the server after it deliberately redacts private member names. */
  allowMemberNames?: boolean;
}

function membersOf(
  act: Pick<PublicAct, "performerName" | "performers">,
): readonly Performer[] {
  if (act.performers !== undefined) return act.performers;
  return act.performerName.trim()
    ? [{ id: "legacy", name: act.performerName.trim() }]
    : [];
}

function countLabel(count: number): string {
  return `${count} performer${count === 1 ? "" : "s"}`;
}

/**
 * The one identity policy for act cards, performances, scoreboards, results,
 * admin previews and phones. Automatic mode considers both count and the
 * actual line length: a short quintet may fit while four long names may not.
 */
export function actIdentity(
  act: Pick<
    PublicAct,
    | "performerName"
    | "performers"
    | "performerCount"
    | "groupName"
    | "performerDisplayMode"
  >,
  options: IdentityOptions = {},
): ActIdentity {
  const surface = options.surface ?? "projector";
  const members = membersOf(act);
  const names = members.map((member) => member.name.trim()).filter(Boolean);
  const count = Math.max(act.performerCount ?? names.length, 1);
  const joined = names.join(PROJECTOR_MEMBER_SEPARATOR);
  const group = act.groupName?.trim() ?? "";
  const mode: PerformerDisplayMode = act.performerDisplayMode ?? "AUTOMATIC";
  const allowNames = options.allowMemberNames !== false;
  const readableLimit = surface === "audience" ? 110 : 64;
  const readable =
    allowNames &&
    names.length > 0 &&
    (names.length === 1 ||
      (names.length <= 4 && joined.length <= readableLimit) ||
      (names.length <= 8 && joined.length <= Math.floor(readableLimit * 0.85)));
  const fallbackName = act.performerName.trim() || "Performer";

  let primary: string;
  let secondary: string | null = null;
  switch (mode) {
    case "GROUP_NAME_ONLY":
      primary =
        group || (readable ? joined : `Ensemble · ${countLabel(count)}`);
      break;
    case "GROUP_NAME_AND_MEMBERS":
      primary = group || "Ensemble";
      secondary = allowNames && joined ? joined : countLabel(count);
      break;
    case "MEMBER_NAMES":
      primary = allowNames && joined ? joined : group || countLabel(count);
      break;
    case "PERFORMER_COUNT":
      primary = group || (count === 1 ? fallbackName : "Ensemble");
      secondary = countLabel(count);
      break;
    case "AUTOMATIC":
      if (count === 1 && !group) {
        primary = allowNames && joined ? joined : fallbackName;
      } else if (group) {
        primary = group;
        secondary = readable ? joined : countLabel(count);
      } else if (readable) {
        primary = joined;
      } else {
        primary = `Ensemble · ${countLabel(count)}`;
      }
      break;
  }

  return {
    primary,
    secondary,
    performerCount: count,
    memberNames: allowNames ? joined : "",
    compact: secondary ? `${primary} — ${secondary}` : primary,
  };
}
