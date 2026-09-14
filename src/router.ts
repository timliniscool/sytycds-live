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
        title: "Show control · SYTYCDS",
        description: "SYTYCDS broadcast show-control console.",
        themeColor: "#101417",
      };
    case "projector":
      return {
        title: "SYTYCDS live presentation",
        description: "Live event presentation display.",
        themeColor: "#050607",
      };
    case "vote":
      return {
        title: "Vote · SYTYCDS",
        description: "Cast your SYTYCDS audience vote.",
        themeColor: "#15211c",
      };
    case "judge":
      return {
        title: "Judge · SYTYCDS",
        description: "Private SYTYCDS judge scoring.",
        themeColor: "#1c1713",
      };
    case "not-found":
      return {
        title: "Page not found · SYTYCDS",
        description: "The requested SYTYCDS page was not found.",
        themeColor: "#101417",
      };
  }
}
