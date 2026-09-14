import { PLATFORM_NAME } from "../shared/platform";
import { DEFAULT_THEME_ID, themeById } from "../shared/themes";

const DEFAULT_THEME = themeById(DEFAULT_THEME_ID);

export type Route =
  | { kind: "admin" }
  | { kind: "projector" }
  | { kind: "vote" }
  | { kind: "judge"; token: string }
  | { kind: "not-found" };

const JUDGE_TOKEN = /^[A-Za-z0-9_-]{1,256}$/;

/** Resolves the small, fixed route set without shipping a general router. */
export function resolveRoute(pathname: string): Route {
  const segments = pathname.split("/");

  if (segments[0] !== "") {
    return { kind: "not-found" };
  }

  const [first, second, third] = segments.slice(1);
  if (third !== undefined || (second === "" && first === "judge")) {
    return { kind: "not-found" };
  }

  if (second === undefined || second === "") {
    switch (first) {
      case "admin":
        return { kind: "admin" };
      case "projector":
        return { kind: "projector" };
      case "vote":
        return { kind: "vote" };
      default:
        return { kind: "not-found" };
    }
  }

  if (first === "judge" && JUDGE_TOKEN.test(second)) {
    return { kind: "judge", token: second };
  }

  return { kind: "not-found" };
}

export interface RouteMetadata {
  title: string;
  description: string;
  themeColor: string;
}

export function metadataForRoute(route: Route): RouteMetadata {
  switch (route.kind) {
    case "admin":
      return {
        title: `Show control · ${PLATFORM_NAME}`,
        description: `${PLATFORM_NAME} broadcast show-control console.`,
        themeColor: DEFAULT_THEME.web.background,
      };
    case "projector":
      return {
        title: `${PLATFORM_NAME} presentation`,
        description: "Live event presentation display.",
        themeColor: DEFAULT_THEME.projector.background,
      };
    case "vote":
      return {
        title: `Vote · ${PLATFORM_NAME}`,
        description: `Cast your ${PLATFORM_NAME} audience vote.`,
        themeColor: DEFAULT_THEME.web.background,
      };
    case "judge":
      return {
        title: `Judge · ${PLATFORM_NAME}`,
        description: `Private ${PLATFORM_NAME} judge scoring.`,
        themeColor: DEFAULT_THEME.web.background,
      };
    case "not-found":
      return {
        title: `Page not found · ${PLATFORM_NAME}`,
        description: `The requested ${PLATFORM_NAME} page was not found.`,
        themeColor: DEFAULT_THEME.web.background,
      };
  }
}
